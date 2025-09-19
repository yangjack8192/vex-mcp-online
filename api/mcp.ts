import type { VercelRequest, VercelResponse } from '@vercel/node';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import 'vex-mcp-server'; // 帮助依赖追踪

const require_ = createRequire(import.meta.url);

type RpcReq =
  | { method: 'tools/list'; params?: any }
  | { method: 'tools/call'; params: { name: string; arguments?: any } };

// 统一解析 vex-mcp-server 的入口文件（优先 build/index.js）
function resolveVexEntry(): string {
  try {
    return require_.resolve('vex-mcp-server/build/index.js');
  } catch {
    // 兜底到包的 main
    return require_.resolve('vex-mcp-server');
  }
}

function runMcpOnce(payload: RpcReq, extraEnv: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    let entry: string;
    try {
      entry = resolveVexEntry();
    } catch (e) {
      return reject(new Error(`Cannot resolve vex-mcp-server: ${e instanceof Error ? e.message : String(e)}`));
    }

    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ...extraEnv, NODE_ENV: 'production' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => (stdout += d.toString('utf8')));
    child.stderr.on('data', d => (stderr += d.toString('utf8')));

    // 行分隔 JSON-RPC
    const msg = JSON.stringify({ id: 1, jsonrpc: '2.0', ...payload }) + '\n';
    child.stdin.write(msg);
    child.stdin.end();

    child.on('error', err => reject(err));

    child.on('close', code => {
      if (code !== 0 && !stdout) {
        return reject(new Error(stderr || `child exited with code ${code}`));
      }
      try {
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        let lastObj: any = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try { lastObj = JSON.parse(lines[i]); break; } catch {}
        }
        if (!lastObj) throw new Error('No JSON-RPC response found in stdout');
        resolve(lastObj);
      } catch (e: any) {
        reject(new Error(`Parse error: ${e?.message || 'unknown'}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`));
      }
    });
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-requested-with');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    let rpc: RpcReq;
    if (body.action === 'listTools') {
      rpc = { method: 'tools/list' };
    } else if (body.action === 'callTool') {
      rpc = { method: 'tools/call', params: { name: body.name, arguments: body.args || {} } };
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    const ROBOTEVENTS_TOKEN = process.env.ROBOTEVENTS_TOKEN || '';
    if (!ROBOTEVENTS_TOKEN) {
      return res.status(500).json({ error: 'ROBOTEVENTS_TOKEN missing in env' });
    }

    const result = await runMcpOnce(rpc, { ROBOTEVENTS_TOKEN });

    return res.status(200).json({ ok: true, result });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'internal error' });
  }
}