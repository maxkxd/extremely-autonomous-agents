import { randomBytes } from 'node:crypto';
import { listIds, readMeta } from '../files.js';
import { agencyTools } from './agency-mcp.js';
import { getSetting, setSetting } from './db.js';
import { mcpDirectory, setDirectoryRouter } from './mcp-directory.js';
import { openBridge, type McpTool } from './mcp.js';

// The one MCP address for your AI assistant (Settings > Connectors > MCP,
// docs/mcp-server.md): every agency you can reach from this computer behind
// one address - your own agency here, and each organization you're in, acting
// as you there with what your role allows (remote-mcp.ts carries those through
// the app, end to end encrypted to the host). It's whoever uses this app, not
// only an organization's host. Every tool takes `agency`; left out, the call
// goes to the only obvious one, and otherwise the AI asks the person which.
//
// The same thing the public package (packages/agency-mcp) does from outside,
// here inside the app, so Claude Desktop, Claude Code, Cursor, VS Code and any
// app that takes an address all get it the same way.

export type Agency = { id: string; name: string; role: string; url: string };

const TOKEN_KEY = 'mcp_router_token';
const APP_CLOSED = "Can't reach that agency. For an organization, the Extremely Autonomous Agents app has to be open and signed in on this computer, and its host computer on.";

const AGENCY_ARG = {
  type: 'string',
  description: "Which agency: its name or id from list_agencies. Leave out only when the person has one agency; otherwise ask them which, don't guess.",
};
const LIST_AGENCIES: McpTool = {
  name: 'list_agencies',
  title: 'List your agencies',
  description: 'Your own agency and every organization you are in: name, your role, whether it has agents yet, and whether it answers right now. Pass one as `agency` to any other tool.',
  schema: { type: 'object', properties: {} },
  annotations: { title: 'List your agencies', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export const INSTRUCTIONS =
  "The person's EXTREMELY agencies of AI agents, reached through the Extremely Autonomous Agents app on this computer: their own agency, and each organization they're in (as them, with their role). " +
  'Every tool takes `agency`. When the person has more than one and it is not clear which they mean, ask them before acting, especially before creating, changing or running anything. ' +
  'To make an agent: read builder_guide first and follow it, then check_build, then create_agent. ' +
  "agency_today and agent_activity say what agents did; list_approvals and decide_approval handle what's waiting on a person; list_requests, reply_to_request and answer_request handle agents' requests; give_task and run_agent put agents to work.";

// Whether this computer's own agency has agents of its own yet (built-in ones don't count):
// an empty one beside an organization isn't an obvious place for anything.
export async function ownAgencyEmpty(): Promise<boolean> {
  for (const id of await listIds()) {
    const m = await readMeta(id);
    if (m && !m.builtIn && !m.service) return false;
  }
  return true;
}

// Which agency a call is for. Named: that one. Not named: the only obvious one
// (the only agency, or the only organization beside an empty agency of your
// own), else a question for the person.
export function pickAgency(list: Agency[], wanted: unknown, ownEmpty: boolean): { agency: Agency } | { ask: string } {
  const names = list.map(a => `${a.name} (${a.role})`).join(', ');
  const w = typeof wanted === 'string' ? wanted.trim().toLowerCase() : '';
  if (w) {
    const found = list.find(a => a.id.toLowerCase() === w) ?? list.find(a => a.name.toLowerCase() === w) ?? list.find(a => a.name.toLowerCase().includes(w));
    return found ? { agency: found } : { ask: `There's no agency "${String(wanted)}". The person's agencies: ${names}.` };
  }
  const likely = list.length > 1 && ownEmpty ? list.filter(a => a.id !== 'personal') : list;
  if (likely.length === 1) return { agency: likely[0] };
  if (!likely.length) return { ask: APP_CLOSED };
  return { ask: `Ask the person which agency this is for, then call again with \`agency\`. Theirs: ${names}.` };
}

// One tools/call on an agency's own address, its answer as text.
async function forward(a: Agency, name: string, args: Record<string, unknown>): Promise<{ content: string; error: boolean }> {
  let res: Response;
  try {
    res = await fetch(a.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  } catch {
    return { content: APP_CLOSED, error: true };
  }
  if (!res.ok) return { content: res.status === 404 ? 'That agency\'s address was replaced. Restart the Extremely Autonomous Agents app, then try again.' : `${a.name} answered HTTP ${res.status}.`, error: true };
  const r = (await res.json().catch(() => null)) as { error?: { message?: string }; result?: { content?: { type: string; text?: string }[]; isError?: boolean } } | null;
  if (r?.error) return { content: r.error.message ?? `${a.name} refused that.`, error: true };
  const text = (r?.result?.content ?? []).map(c => c.text ?? '').join('\n');
  return { content: text || `${a.name} gave no answer.`, error: !!r?.result?.isError };
}

async function ping(a: Agency): Promise<boolean> {
  try {
    const res = await fetch(a.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), signal: AbortSignal.timeout(4000) });
    return res.ok && !!((await res.json()) as { result?: unknown }).result;
  } catch {
    return false;
  }
}

// The router itself, over a list of agencies (the directory, or a test's).
export function routerBridge(list: () => Agency[], ownEmpty: () => Promise<boolean> = ownAgencyEmpty) {
  return {
    instructions: INSTRUCTIONS,
    get tools(): McpTool[] {
      return [LIST_AGENCIES, ...agencyTools('owner').map(t => ({ ...t, schema: { ...t.schema, type: 'object', properties: { ...((t.schema as { properties?: object }).properties ?? {}), agency: AGENCY_ARG } } }))];
    },
    async call(c: { name: string; args?: Record<string, unknown> }) {
      const all = list();
      const empty = await ownEmpty();
      if (c.name === 'list_agencies') {
        const rows = await Promise.all(all.map(async a => ({ id: a.id, name: a.name, role: a.role, ...(a.id === 'personal' ? { hasAgents: !empty } : {}), answering: await ping(a) })));
        return { content: JSON.stringify(rows, null, 2), error: false };
      }
      const { agency, ...args } = c.args ?? {};
      const picked = pickAgency(all, agency, empty);
      if ('ask' in picked) return { content: picked.ask, error: true };
      return forward(picked.agency, c.name, args);
    },
  };
}

let url = '';

// Its address on this computer: the same one each time (it's what AI apps were given).
export function routerUrl(): string {
  if (url) return url;
  let token = getSetting<string | null>(TOKEN_KEY, null);
  if (!token) {
    token = randomBytes(24).toString('hex');
    setSetting(TOKEN_KEY, token);
  }
  url = openBridge(routerBridge(() => mcpDirectory().agencies), token).url;
  setDirectoryRouter(url);
  return url;
}
