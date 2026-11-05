// EXTREMELY (Extremely Autonomous Agents) as an MCP server for any AI app:
// Claude Desktop, Cursor, VS Code, Claude Code, Windsurf...
//
// It holds nothing itself. It finds the Extremely Autonomous Agents app on this
// computer (the small file the app keeps, docs/mcp-server.md) and passes the AI
// app's messages to the agency there and back: your own agency directly, an
// organization through the app, end to end encrypted to its host. So it acts
// as you, with what your role allows, and your AI app decides which tools it
// may call without asking.
//
// Plain Node 18+, no packages. MCP over stdio: one JSON-RPC message per line.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const BUNDLED = JSON.parse(readFileSync(new URL('./tools.json', import.meta.url), 'utf8'));
export const APP = 'Extremely Autonomous Agents';
const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const APP_CLOSED = `Can't reach your agency. Open the ${APP} app on this computer (and sign in, for an organization), then try again.`;

// --- Finding the app ---

export function directoryFile(env = process.env, platform = process.platform, home = homedir()) {
  if (env.EAA_MCP_DISCOVERY) return env.EAA_MCP_DISCOVERY;
  const base = platform === 'win32' ? (env.APPDATA ?? join(home, 'AppData', 'Roaming')) : platform === 'darwin' ? join(home, 'Library', 'Application Support') : (env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return join(base, APP, 'agency-mcp.json');
}

// The agencies this person can reach: read fresh each time, so a restarted app,
// a new organization or a replaced address is picked up without restarting this.
export function agencies(env = process.env) {
  if (env.EXTREMELY_MCP_URL) return [{ id: 'agency', name: 'Your agency', role: 'unknown', url: env.EXTREMELY_MCP_URL }];
  try {
    const d = JSON.parse(readFileSync(directoryFile(env), 'utf8'));
    return Array.isArray(d.agencies) ? d.agencies.filter(a => a && typeof a.url === 'string') : [];
  } catch {
    return [];
  }
}

// Which agency a call is for: its id or name, else your own (or the only one).
export function pick(list, wanted) {
  const w = String(wanted ?? '').trim().toLowerCase();
  if (!w) return list.find(a => a.id === 'personal') ?? list[0] ?? null;
  return list.find(a => a.id.toLowerCase() === w) ?? list.find(a => a.name.toLowerCase() === w) ?? list.find(a => a.name.toLowerCase().includes(w)) ?? null;
}

async function post(url, msg, ms) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(msg), signal: ms ? AbortSignal.timeout(ms) : undefined });
  if (res.status === 202) return null;
  if (res.status === 404) throw new Error(`This address was replaced. Restart the ${APP} app, then try again.`);
  if (!res.ok) throw new Error(`The agency answered HTTP ${res.status}.`);
  return res.json();
}

// --- Tools ---

const AGENCY_ARG = { type: 'string', description: 'Which agency: an organization you are in, by name or id (list_agencies). Leave out for your own agency.' };
const LIST_AGENCIES = {
  name: 'list_agencies',
  title: 'List your agencies',
  description: 'Your own agency and every organization you are in, with your role in each and whether it answers right now. Pass one as `agency` to any other tool.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'List your agencies', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

const withAgencyArg = t => ({ ...t, inputSchema: { ...t.inputSchema, type: 'object', properties: { ...(t.inputSchema?.properties ?? {}), agency: AGENCY_ARG } } });

// The real list from your own agency (what your role there allows); the one
// bundled here when the app isn't running, so AI apps and registries still see them.
async function toolList() {
  let tools = BUNDLED;
  const own = pick(agencies());
  if (own) {
    try {
      const r = await post(own.url, { jsonrpc: '2.0', id: 'tools', method: 'tools/list' }, 5000);
      if (Array.isArray(r?.result?.tools)) tools = r.result.tools;
    } catch {
      // not running: the bundled list
    }
  }
  return [LIST_AGENCIES, ...tools.map(withAgencyArg)];
}

const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], isError });

async function listAgencies() {
  const list = agencies();
  if (!list.length) return text(APP_CLOSED, true);
  const rows = await Promise.all(
    list.map(async a => {
      let answers = false;
      try {
        answers = !!(await post(a.url, { jsonrpc: '2.0', id: 'ping', method: 'ping' }, 4000))?.result;
      } catch {
        // closed, offline or slow
      }
      return { id: a.id, name: a.name, role: a.role, answering: answers ? 'yes' : a.id === 'personal' ? 'no: the app is not running' : 'no: the app is closed or its host is offline' };
    }),
  );
  return text(JSON.stringify(rows, null, 2));
}

async function callTool(params) {
  const name = String(params?.name ?? '');
  const { agency, ...args } = params?.arguments ?? {};
  if (name === 'list_agencies') return listAgencies();
  const list = agencies();
  if (!list.length) return text(APP_CLOSED, true);
  const target = pick(list, agency);
  if (!target) return text(`No agency "${agency}". Yours: ${list.map(a => a.name).join(', ')}.`, true);
  try {
    const r = await post(target.url, { jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } });
    if (r?.error) return text(r.error.message ?? 'The agency refused that.', true);
    return r?.result ?? text('The agency gave no answer.', true);
  } catch (e) {
    // fetch itself failed: nothing listening there.
    return text(e instanceof TypeError ? APP_CLOSED : e.message, true);
  }
}

// --- MCP ---

export async function handle(msg) {
  const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'extremely-agency', title: 'EXTREMELY agency', version: VERSION },
        instructions:
          "Your EXTREMELY agency of AI agents, running in the Extremely Autonomous Agents app on this computer. agency_today and agent_activity say what agents did; list_approvals and decide_approval handle what's waiting on a person; list_requests, reply_to_request and answer_request handle agents' requests; give_task and run_agent put agents to work. For an organization you're in, pass its name as `agency` (list_agencies).",
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: await toolList() });
    case 'tools/call':
      return reply(await callTool(msg.params));
    case 'resources/list':
      return reply({ resources: [] });
    case 'resources/templates/list':
      return reply({ resourceTemplates: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    default:
      return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } };
  }
}

// One line from the AI app: its answer as a line, or nothing (a notification).
export async function serve(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  // Notifications (no id) get no answer.
  if (msg.id === undefined || msg.id === null) return null;
  try {
    return JSON.stringify(await handle(msg));
  } catch (e) {
    process.stderr.write(`agency-mcp: ${e?.stack ?? e}\n`);
    return JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}
