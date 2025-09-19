import type { VercelRequest, VercelResponse } from '@vercel/node';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

type RpcReq =
  | { method: 'tools/list'; params?: any }
  | { method: 'tools/call'; params: { name: string; arguments?: any } };

function runMcpOnce(payload: RpcReq, extraEnv: Record<string, string>): Promise<any> {
  return new Promise((resolve, reject) => {
    // Use createRequire to resolve modules in ES modules environment
    const require = createRequire(import.meta.url);

    // 解析 vex-mcp-server 的入口文件；优先尝试 build/index.js
    let entry: string;
    try {
      entry = require.resolve('vex-mcp-server/build/index.js');
    } catch {
      try {
        // 兜底：有些包 main 指到根
        entry = require.resolve('vex-mcp-server');
      } catch (e) {
        return reject(new Error(`Cannot resolve vex-mcp-server: ${e}`));
      }
    }

    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, ...extraEnv, NODE_ENV: 'production' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d) => (stderr += d.toString('utf8')));

    // 发送一条 JSON-RPC（常见为行分隔）
    const msg = JSON.stringify({ id: 1, jsonrpc: '2.0', ...payload }) + '\n';
    child.stdin.write(msg);
    child.stdin.end();

    child.on('error', (err) => reject(err));

    child.on('close', (code) => {
      if (code !== 0 && !stdout) {
        return reject(new Error(stderr || `child exited with code ${code}`));
      }
      try {
        // 可能多行输出：取最后一行可解析的 JSON
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        let lastObj: any = null;
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            lastObj = JSON.parse(lines[i]);
            break;
          } catch {
            continue;
          }
        }
        if (!lastObj) throw new Error('No JSON-RPC response found in stdout');
        resolve(lastObj);
      } catch (e: any) {
        reject(
          new Error(
            `Parse error: ${e?.message || 'unknown'}\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
          )
        );
      }
    });
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS（方便前端或第三方直接调用）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-requested-with');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    // 约定请求格式：
    // { action:"listTools" }
    // { action:"callTool", name:"<toolName>", args:{ ... } }
    let rpc: RpcReq;
    if (body.action === 'listTools') {
      rpc = { method: 'tools/list' };
    } else if (body.action === 'callTool') {
      rpc = { method: 'tools/call', params: { name: body.name, arguments: body.args || {} } };
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    // ROBOTEVENTS_TOKEN 必需。请在 Vercel 环境变量中配置。
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