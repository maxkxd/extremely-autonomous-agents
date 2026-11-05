import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Call, ToolSpec } from './providers.js';

// A run's tools as an MCP server, for model harnesses that bring their own
// agent loop (Claude Code). Each run gets its own address with a random token;
// the harness can call exactly that run's tools and nothing else, and every
// call goes back through the runner (tiers, limits, output counting).
// Minimal MCP over HTTP: JSON-RPC posts answered with JSON.

// title and annotations: how AI apps show a tool and whether they ask before it (the agency's own server sets them).
export type McpTool = ToolSpec & { title?: string; annotations?: Record<string, unknown> };
export type Bridge = { tools: McpTool[]; call: (c: Call) => Promise<{ content: string; error: boolean }> };
const bridges = new Map<string, Bridge>();

const PORT = Number(process.env.PORT ?? 5175);

// token: a standing one (the agency's own MCP server); otherwise a new one per run.
export function openBridge(b: Bridge, token = randomBytes(24).toString('hex')): { url: string; close: () => void } {
  bridges.set(token, b);
  return { url: `http://127.0.0.1:${PORT}/mcp/${token}`, close: () => bridges.delete(token) };
}

let seq = 0;

// The MCP versions this answers as (all the same for tools over plain JSON
// answers): the client's own when it's one of them, else the newest.
export const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const protocolFor = (asked: unknown) => (typeof asked === 'string' && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0]);

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
  let msg: Rpc;
  try {
    msg = JSON.parse(raw);
  } catch {
    res.writeHead(400).end();
    return true;
  }
  const out = await rpc(bridge, msg);
  // Notifications get no answer.
  if (!out) res.writeHead(202).end();
  else res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  return true;
}

export type Rpc = { id?: number | string; method?: string; params?: Record<string, unknown> };

// One JSON-RPC message to a bridge, and its answer (null for a notification).
// Also how a teammate's AI assistant reaches it from another computer, through
// the app (POST /api/agency-mcp/rpc, agency-mcp.ts).
export async function rpc(bridge: Bridge, msg: Rpc): Promise<object | null> {
  if (msg.id === undefined) return null;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: protocolFor(msg.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agency', version: '1.0.0' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: bridge.tools.map(t => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, inputSchema: t.schema, ...(t.annotations ? { annotations: t.annotations } : {}) })) });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const out = await bridge.call({ id: `mcp_${Date.now().toString(36)}${(seq++).toString(36)}`, name, args });
      return reply({ content: [{ type: 'text', text: out.content }], isError: out.error });
    }
    default:
      return error(-32601, `Unknown method ${msg.method}`);
  }
}
