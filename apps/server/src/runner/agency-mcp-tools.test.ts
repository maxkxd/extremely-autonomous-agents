import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setAccessConfig, type Actor } from '../access.js';
import { DATA, writeMeta } from '../files.js';
import { agencyToolNames, HINTS, mcpUrlFor } from './agency-mcp.js';
import { bundledTools, BUNDLED_TOOLS_FILE } from './agency-mcp-bundle.js';
import { all, one, resetDbForTests, run as exec } from './db.js';
import { handleMcp } from './mcp.js';
import { mcpDirectory } from './mcp-directory.js';

// The tools the public MCP package (packages/agency-mcp) is mostly used for:
// what agents did, approvals, requests and jobs, as the host computer's own
// person and as a member who didn't make the agent.

let backend: Server;
let mcp: Server;
let mcpBase = '';

before(async () => {
  resetDbForTests();
  backend = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ role: 'member', name: 'Priya' })));
  await new Promise<void>(r => backend.listen(0, '127.0.0.1', r));
  setAccessConfig({ issuer: `http://127.0.0.1:${(backend.address() as { port: number }).port}`, orgId: 'org-1' });
  mcp = createServer((req, res) => void handleMcp(req, res, new URL(req.url ?? '/', 'http://x').pathname));
  await new Promise<void>(r => mcp.listen(0, '127.0.0.1', r));
  mcpBase = `http://127.0.0.1:${(mcp.address() as { port: number }).port}`;
  await mkdir(join(DATA, 'sales'), { recursive: true });
  await writeMeta('sales', { name: 'Sales Agent', department: 'sales', output: [], status: 'ready', owner: 'Sam Rivera', ownerId: 'user_sam' });
});
after(() => {
  backend.close();
  mcp.close();
});

const owner: Actor = { id: 'local', name: 'Sam Rivera', role: 'owner', via: 'local' };
const priya: Actor = { id: 'user_priya', name: 'Priya', role: 'member', via: 'token' };

const rpc = async (url: string, method: string, params?: unknown) => {
  const res = await fetch(mcpBase + new URL(url).pathname, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return ((await res.json()) as { result: Record<string, unknown> }).result;
};
const call = async (who: Actor, name: string, args = {}) => {
  const r = (await rpc(mcpUrlFor(who), 'tools/call', { name, arguments: args })) as { content: { text: string }[]; isError: boolean };
  return { text: r.content[0].text, error: r.isError };
};

test('every tool has a title and hints for AI apps, and the package’s bundled list is current', async () => {
  assert.deepEqual(
    agencyToolNames().filter(n => !HINTS[n]),
    [],
  );
  const tools = (await rpc(mcpUrlFor(owner), 'tools/list')).tools as { name: string; title?: string; annotations?: Record<string, boolean> }[];
  const decide = tools.find(t => t.name === 'decide_approval')!;
  assert.equal(decide.title, 'Approve or reject an action');
  assert.deepEqual([decide.annotations!.readOnlyHint, decide.annotations!.destructiveHint], [false, true]);
  assert.equal(tools.find(t => t.name === 'agency_today')!.annotations!.readOnlyHint, true);
  const bundled = JSON.parse(await readFile(BUNDLED_TOOLS_FILE, 'utf8'));
  assert.deepEqual(bundled, JSON.parse(JSON.stringify(bundledTools())), 'out of date: run npm run agency-mcp-tools in apps/server');
});

test('initialize answers in a version both sides speak', async () => {
  const url = mcpUrlFor(owner);
  assert.equal((await rpc(url, 'initialize', { protocolVersion: '2025-03-26' })).protocolVersion, '2025-03-26');
  assert.equal((await rpc(url, 'initialize', { protocolVersion: '2099-01-01' })).protocolVersion, '2025-11-25');
});

test('give_task: a job from a person, booked; agent_activity shows it; a member who didn’t make it can’t', async () => {
  const r = await call(owner, 'give_task', { agent_id: 'sales', task: 'Follow up with Northside Bikes' });
  assert.match(r.text, /task #\d+/);
  const task = { ...one<{ from_agent: string | null; task: string }>("SELECT from_agent, task FROM tasks WHERE agent_id = 'sales'") };
  assert.deepEqual(task, { from_agent: null, task: 'Follow up with Northside Bikes' });
  assert.ok(one("SELECT id FROM bookings WHERE agent_id = 'sales' AND trigger = 'handoff'"), 'it runs on it');
  const refused = await call(priya, 'give_task', { agent_id: 'sales', task: 'x' });
  assert.equal(refused.error, true);
  assert.match(refused.text, /Only the person who made Sales Agent/);
  const activity = JSON.parse((await call(owner, 'agent_activity', { agent_id: 'sales' })).text);
  assert.equal(activity.tasks[0].from, 'a person');
  // Recorded, as the app's own changes are; reads aren't.
  assert.ok(all<{ route: string }>('SELECT route FROM person_actions').some(a => a.route === 'MCP give_task'));
});

test('agency_today and latest_report: what ran today, and its write-up', async () => {
  const now = Date.now();
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, acts, summary) VALUES ('r1', 'sales', 'scheduled', 1, 'succeeded', ?, 3, 'Queued 3 leads.')", now);
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, acts, summary) VALUES ('r0', 'sales', 'scheduled', 1, 'succeeded', ?, 9, 'Last week.')", now - 8 * 86_400_000);
  exec("INSERT INTO dm (agent_id, kind, run_id, body, at) VALUES ('sales', 'run', 'r1', ?, ?)", JSON.stringify({ kind: 'run', text: 'Queued 3 leads for Jo Nguyen.', trigger: 'scheduled', outcome: 'ok', tools: [{ server: 'crm', tool: 'queue_leads', status: 'ok' }] }), now);
  const today = JSON.parse((await call(owner, 'agency_today')).text);
  const sales = today.agents.find((a: { agent: string }) => a.agent.startsWith('Sales Agent'));
  assert.deepEqual([sales.runs, sales.output_actions, sales.last_summary], [1, 3, 'Queued 3 leads.']);
  const week = JSON.parse((await call(owner, 'agency_today', { since: new Date(now - 10 * 86_400_000).toISOString() })).text);
  assert.equal(week.agents.find((a: { agent: string }) => a.agent.startsWith('Sales')).runs, 2);
  assert.equal((await call(owner, 'agency_today', { since: 'yesterday-ish' })).error, true);
  const activity = JSON.parse((await call(owner, 'agent_activity', { agent_id: 'sales' })).text);
  assert.deepEqual(activity.posts[0].tools, ['crm.queue_leads']);
  const report = await call(owner, 'latest_report', { agent_id: 'sales' });
  assert.match(report.text, /Queued 3 leads for Jo Nguyen\./);
  assert.match(report.text, /Where its reports go: not chosen yet/);
});

test('decide_approval: as on the Approvals screen, by whoever may decide it', async () => {
  const later = Date.now() + 3_600_000;
  exec("INSERT INTO approvals (id, agent_id, run_id, tool, args, created_at, expires_at) VALUES ('a1', 'sales', 'r1', 'gmail.send', '{\"to\":\"jo@northside.test\"}', ?, ?)", Date.now(), later);
  const listed = await call(owner, 'list_approvals');
  assert.match(listed.text, /gmail\.send/);
  assert.equal((await call(priya, 'decide_approval', { approval_id: 'a1', decision: 'rejected' })).error, true, 'not hers to decide');
  const r = await call(owner, 'decide_approval', { approval_id: 'a1', decision: 'rejected', note: 'Not yet' });
  assert.deepEqual([r.error, r.text], [false, 'Rejected; the agent is told.']);
  // The standing address acts as the host computer's own person.
  assert.deepEqual({ ...one("SELECT status, decided_by FROM approvals WHERE id = 'a1'") }, { status: 'rejected', decided_by: 'The host' });
  assert.match((await call(owner, 'decide_approval', { approval_id: 'a1', decision: 'approved' })).text, /already rejected/);
});

test('reply_to_request: in the thread, and the Agency Engineer woken', async () => {
  exec("INSERT INTO requests (id, agent_id, what, why, created_at) VALUES (9, 'sales', 'A CRM key', 'To queue leads', 0)");
  const r = await call(owner, 'reply_to_request', { request_id: 9, text: 'Use the sandbox account' });
  assert.equal(r.error, false);
  assert.deepEqual({ ...one('SELECT from_who, text FROM request_messages WHERE request_id = 9') }, { from_who: 'you', text: 'Use the sandbox account' });
  assert.ok(one("SELECT id FROM bookings WHERE trigger = 'request reply'"));
});

test('the directory: your own agency, then each organization the app said you’re in', () => {
  const d = mcpDirectory();
  assert.equal(d.agencies[0].id, 'personal');
  assert.equal(d.agencies[0].url, mcpUrlFor(owner));
});
