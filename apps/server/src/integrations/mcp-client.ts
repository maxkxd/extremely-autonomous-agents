import { safeFetch } from '../runner/net.js';
import { stdioServer } from './mcp-stdio.js';
import type { McpIntegration } from './schema.js';
import { authParts, baseFor, redact } from './http.js';

// A remote MCP server as an integration (docs/integrations.md): the
// streamable HTTP transport - JSON-RPC posts, answered as JSON or as an
// event stream, with the session id the server hands out on initialize.

export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean };

const PROTOCOL = '2025-06-18';

// fetch, shaped like the safe fetcher, for a local server the person added.
async function localFetch(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: AbortSignal.timeout(init.timeoutMs ?? 60_000) });
  return { res, url };
}

// The address with the person's fields in it, kept on the host the definition names:
// a field in the host (Zoho's server name) is one plain name, never a way to send
// the key to another site ("evil.com/x?" as a server name).
export function filledUrl(template: string, filled: string): URL {
  const url = new URL(filled);
  const host = new URL(template).host;
  if (!host.includes('{{')) return url;
  const escape = (p: string) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Each field is host-name characters only (a region may have dots: com.au), around the
  // definition's fixed parts. A field followed by a fixed domain can't leave it; one that
  // ends the host must have a fixed list of values (index.ts refuses the definition otherwise).
  const pattern = new RegExp(`^${host.split(/\{\{\w+\}\}/).map(escape).join('[a-z0-9.-]+')}$`, 'i');
  if (!pattern.test(url.host) || url.host.includes('..')) throw new Error(`That doesn't make a valid address for this server (${host}): check what you pasted - a name only, no slashes.`);
  return url;
}

// A streamed answer's messages: events are separated by a blank line, and one
// event's data may run over several "data:" lines, joined with newlines (the
// event-stream format) - read line by line, a message split that way was lost.
export function streamMessages(text: string): unknown[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/\n\n+/)
    .map(event =>
      event
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).replace(/^ /, ''))
        .join('\n'),
    )
    .filter(Boolean)
    .map(data => {
      try {
        return JSON.parse(data);
      } catch {
        return null;
      }
    });
}

class Session {
  private sessionId: string | null = null;
  private seq = 1;
  // The version the server agreed to at initialize, sent on every request after it:
  // a server on an older one refuses requests that name a version it doesn't speak.
  private version = PROTOCOL;
  constructor(
    private integration: McpIntegration,
    private key: string | undefined,
  ) {}

  private async post(body: object, expectReply: boolean): Promise<unknown> {
    const { headers: auth, query } = authParts(this.integration.auth, this.key);
    // A sign-in by fields can be part of the address (Zoho: https://{{server}}.zohomcp.com/mcp/{{api_key}}/message).
    const url = filledUrl(this.integration.url!, baseFor(this.integration.url!, this.integration.auth, this.key));
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    // A server the person added on this computer: reached directly (the one
    // exception to agents never reaching local addresses - they chose it).
    const reach = this.integration.local ? localFetch : safeFetch;
    const { res } = await reach(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': this.version,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...auth,
      },
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    });
    this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;
    const text = await res.text();
    if (!res.ok) {
      const safe = redact(text, this.integration.auth, this.key);
      throw new Error(`${this.integration.name} answered ${res.status}: ${safe.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    if (!expectReply) return null;
    const id = (body as { id?: number }).id;
    // An event stream: the reply is the data line carrying our id.
    const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream') ? streamMessages(text) : [JSON.parse(text)];
    const reply = messages.find(m => m && m.id === id) as { result?: unknown; error?: { message?: string } } | undefined;
    if (!reply) throw new Error(`${this.integration.name} sent no answer.`);
    if (reply.error) throw new Error(`${this.integration.name}: ${reply.error.message ?? 'error'}`);
    return reply.result;
  }

  request = (method: string, params: object = {}) => this.post({ jsonrpc: '2.0', id: this.seq++, method, params }, true);
  notify = (method: string, params: object = {}) => this.post({ jsonrpc: '2.0', method, params }, false);

  async open() {
    const r = (await this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'Extremely Autonomous Agents', version: '1.0.0' },
    })) as { protocolVersion?: unknown } | null;
    if (typeof r?.protocolVersion === 'string' && r.protocolVersion) this.version = r.protocolVersion;
    await this.notify('notifications/initialized');
  }
}

type Rpc = { request: (method: string, params?: object) => Promise<unknown> };

async function connect(integration: McpIntegration, key: string | undefined): Promise<Rpc> {
  if (integration.command) {
    const s = stdioServer(integration.id, integration.name, integration.command, integration.env);
    await s.open();
    return s;
  }
  if (!integration.url) throw new Error(`${integration.name} has no address or command.`);
  const s = new Session(integration, key);
  try {
    await s.open();
    return s;
  } catch (e) {
    // An .../sse address is the old SSE transport, which this client doesn't speak
    // (Asana, Square, Webflow, Wix still list one; it answers a post with 405). The
    // same server's streamable address is usually .../mcp beside it.
    const u = new URL(integration.url);
    if (!/\/sse\/?$/.test(u.pathname) || !/answered (404|405|410)\b/.test((e as Error).message)) throw e;
    u.pathname = u.pathname.replace(/\/sse\/?$/, '/mcp');
    const moved = new Session({ ...integration, url: u.toString() }, key);
    try {
      await moved.open();
      return moved;
    } catch {
      throw new Error(`${integration.name}'s address (${integration.url}) is the old SSE kind of MCP server, which this app can't use - its current address usually ends in /mcp.`);
    }
  }
}

export async function listMcpTools(integration: McpIntegration, key: string | undefined): Promise<McpTool[]> {
  const s = await connect(integration, key);
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = (await s.request('tools/list', cursor ? { cursor } : {})) as {
      tools?: { name: string; description?: string; inputSchema?: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }[];
      nextCursor?: string;
    };
    for (const t of r.tools ?? [])
      tools.push({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object' }, readOnly: t.annotations?.readOnlyHint === true });
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

export async function callMcpTool(integration: McpIntegration, key: string | undefined, name: string, args: Record<string, unknown>): Promise<string> {
  const s = await connect(integration, key);
  const r = (await s.request('tools/call', { name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = (r.content ?? [])
    .map(c => (c.type === 'text' ? (c.text ?? '') : `[${c.type} content]`))
    .join('\n')
    .trim();
  if (r.isError) throw new Error(text || 'The tool failed.');
  return text.length > 30_000 ? `${text.slice(0, 30_000)}\n[cut off]` : text || '(empty result)';
}
