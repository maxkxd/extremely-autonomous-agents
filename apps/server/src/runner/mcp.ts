import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Call, ToolSpec } from './providers.js';

// A run's tools as an MCP server, for model harnesses that bring their own
// agent loop (Claude Code). Each run gets its own address with a random token;
// the harness can call exactly that run's tools and nothing else, and every
// call goes back through the runner (tiers, limits, output counting).
// Minimal MCP over HTTP: JSON-RPC posts answered with JSON.

type Bridge = { tools: ToolSpec[]; call: (c: Call) => Promise<{ content: string; error: boolean }> };
const bridges = new Map<string, Bridge>();

const PORT = Number(process.env.PORT ?? 5175);

// token: a standing one (the agency's own MCP server); otherwise a new one per run.
export function openBridge(b: Bridge, token = randomBytes(24).toString('hex')): { url: string; close: () => void } {
  bridges.set(token, b);
  return { url: `http://127.0.0.1:${PORT}/mcp/${token}`, close: () => bridges.delete(token) };
}

let seq = 0;

// Handles /mcp/<token>. Returns false when the path isn't ours.
export async function handleMcp(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const m = path.match(/^\/mcp\/([a-f0-9]{48})$/);
  if (!m) return false;
  const bridge = bridges.get(m[1]);
  if (!bridge) {
    res.writeHead(404).end();
    return true;
  }
  // No server-sent stream: everything is answered inline.
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end();
    return true;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let msg: { id?: number | string; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw);
  } catch {
    res.writeHead(400).end();
    return true;
  }
  // Notifications get no answer.
  if (msg.id === undefined) {
    res.writeHead(202).end();
    return true;
  }
  const reply = (result: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  const error = (code: number, message: string) =>
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code, message } }));

  switch (msg.method) {
    case 'initialize':
      reply({
        protocolVersion: (msg.params?.protocolVersion as string) ?? '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agency', version: '1.0.0' },
      });
      return true;
    case 'ping':
      reply({});
      return true;
    case 'tools/list':
      reply({ tools: bridge.tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.schema })) });
      return true;
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const out = await bridge.call({ id: `mcp_${Date.now().toString(36)}${(seq++).toString(36)}`, name, args });
      reply({ content: [{ type: 'text', text: out.content }], isError: out.error });
      return true;
    }
    default:
      error(-32601, `Unknown method ${msg.method}`);
      return true;
  }
}
