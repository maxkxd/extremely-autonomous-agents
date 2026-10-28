import { safeFetch } from '../runner/net.js';
import type { McpIntegration } from './schema.js';
import { authParts } from './http.js';

// A remote MCP server as an integration (docs/integrations.md): the
// streamable HTTP transport - JSON-RPC posts, answered as JSON or as an
// event stream, with the session id the server hands out on initialize.

export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown>; readOnly: boolean };

const PROTOCOL = '2025-06-18';

class Session {
  private sessionId: string | null = null;
  private seq = 1;
  constructor(
    private integration: McpIntegration,
    private key: string | undefined,
  ) {}

  private async post(body: object, expectReply: boolean): Promise<unknown> {
    const { headers: auth, query } = authParts(this.integration.auth, this.key);
    const url = new URL(this.integration.url);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const { res } = await safeFetch(url.toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': PROTOCOL,
        ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}),
        ...auth,
      },
      body: JSON.stringify(body),
      timeoutMs: 120_000,
    });
    this.sessionId = res.headers.get('mcp-session-id') ?? this.sessionId;
    const text = await res.text();
    if (!res.ok) {
      const safe = this.key ? text.split(this.key).join('[key]') : text;
      throw new Error(`${this.integration.name} answered ${res.status}: ${safe.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    if (!expectReply) return null;
    const id = (body as { id?: number }).id;
    // An event stream: the reply is the data line carrying our id.
    const messages = (res.headers.get('content-type') ?? '').includes('text/event-stream')
      ? text
          .split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => {
            try {
              return JSON.parse(l.slice(5).trim());
            } catch {
              return null;
            }
          })
      : [JSON.parse(text)];
    const reply = messages.find(m => m && m.id === id) as { result?: unknown; error?: { message?: string } } | undefined;
    if (!reply) throw new Error(`${this.integration.name} sent no answer.`);
    if (reply.error) throw new Error(`${this.integration.name}: ${reply.error.message ?? 'error'}`);
    return reply.result;
  }

  request = (method: string, params: object = {}) => this.post({ jsonrpc: '2.0', id: this.seq++, method, params }, true);
  notify = (method: string, params: object = {}) => this.post({ jsonrpc: '2.0', method, params }, false);

  async open() {
    await this.request('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'Extremely Autonomous Agents', version: '1.0.0' },
    });
    await this.notify('notifications/initialized');
  }
}

export async function listMcpTools(integration: McpIntegration, key: string | undefined): Promise<McpTool[]> {
  const s = new Session(integration, key);
  await s.open();
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
  const s = new Session(integration, key);
  await s.open();
  const r = (await s.request('tools/call', { name, arguments: args })) as { content?: { type: string; text?: string }[]; isError?: boolean };
  const text = (r.content ?? [])
    .map(c => (c.type === 'text' ? (c.text ?? '') : `[${c.type} content]`))
    .join('\n')
    .trim();
  if (r.isError) throw new Error(text || 'The tool failed.');
  return text.length > 30_000 ? `${text.slice(0, 30_000)}\n[cut off]` : text || '(empty result)';
}
