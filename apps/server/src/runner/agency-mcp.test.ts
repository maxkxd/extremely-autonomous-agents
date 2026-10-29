import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { setAccessConfig, type Actor } from '../access.js';
import { forgetMembersForTests, mcpUrlFor } from './agency-mcp.js';
import { resetDbForTests, run as exec } from './db.js';
import { handleMcp } from './mcp.js';

// Everyone's own agency MCP address in an organisation acts as them. A stand-in
// for our backend answers "is this person still a member, and as what".

let backend: Server;
let mcp: Server;
let mcpBase = '';
const members = new Map<string, { role: string; name: string }>();
let asked: string[] = [];

before(async () => {
  resetDbForTests();
  backend = createServer((req, res) => {
    asked.push(`${req.headers.authorization} ${req.url}`);
    const m = members.get(decodeURIComponent((req.url ?? '').split('/').pop() ?? ''));
    res.writeHead(m ? 200 : 404, { 'content-type': 'application/json' }).end(JSON.stringify(m ?? { error: 'Not a member.' }));
  });
  await new Promise<void>(r => backend.listen(0, '127.0.0.1', r));
  setAccessConfig({ issuer: `http://127.0.0.1:${(backend.address() as { port: number }).port}`, orgId: 'org-1' });
  process.env.EAA_HOST_SECRET = 'host-secret';
  mcp = createServer((req, res) => void handleMcp(req, res, new URL(req.url ?? '/', 'http://x').pathname));
  await new Promise<void>(r => mcp.listen(0, '127.0.0.1', r));
  mcpBase = `http://127.0.0.1:${(mcp.address() as { port: number }).port}`;
});
after(() => {
  backend.close();
  mcp.close();
});

const rpc = async (url: string, method: string, params?: unknown) => {
  const path = new URL(url).pathname;
  const res = await fetch(mcpBase + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return ((await res.json()) as { result: { tools?: { name: string }[]; content?: { text: string }[]; isError?: boolean } }).result;
};
const call = async (url: string, name: string, args = {}) => {
  const r = await rpc(url, 'tools/call', { name, arguments: args });
  return { text: r.content?.[0]?.text ?? '', error: !!r.isError };
};

const priya: Actor = { id: 'user_priya', name: 'Priya', role: 'member', via: 'token' };
const cat: Actor = { id: 'user_cat', name: 'Cat', role: 'admin', via: 'token' };

test("a member's own address: member tools only, acting as them", async () => {
  members.set('user_priya', { role: 'member', name: 'Priya' });
  const url = mcpUrlFor(priya);
  assert.equal(mcpUrlFor(priya), url, 'the same address each time');
  assert.notEqual(mcpUrlFor(cat), url, 'everyone has their own');
  const names = (await rpc(url, 'tools/list')).tools!.map(t => t.name);
  assert.ok(names.includes('list_requests') && names.includes('create_agent'));
  assert.ok(!names.includes('write_plugin') && !names.includes('publish_integration'));
  assert.equal((await call(url, 'list_requests')).text, 'No requests.');
  const refused = await call(url, 'write_plugin', {});
  assert.equal(refused.error, true);
  assert.match(refused.text, /owner or an admin/);
});

test("answering a request: the agent's maker or an admin, as in the app", async () => {
  exec("INSERT INTO requests (id, agent_id, what, why, created_at) VALUES (5, 'someone-elses-agent', 'x', 'y', 0)");
  const r = await call(mcpUrlFor(priya), 'answer_request', { request_id: 5, status: 'done' });
  assert.equal(r.error, true);
  assert.match(r.text, /Only the person who made/);
});

test('removed from the organisation: the address stops working; a new role, new tools', async () => {
  const dan: Actor = { id: 'user_dan', name: 'Dan', role: 'member', via: 'token' };
  members.set('user_dan', { role: 'member', name: 'Dan' });
  const url = mcpUrlFor(dan);
  // Promoted to admin: once checked again, the admin tools are there too.
  members.set('user_dan', { role: 'admin', name: 'Dan' });
  forgetMembersForTests();
  asked = [];
  assert.equal((await call(url, 'list_requests')).error, false);
  assert.deepEqual(asked, ['Host host-secret /host/members/user_dan'], "asked with the host's secret");
  assert.ok((await rpc(url, 'tools/list')).tools!.some(t => t.name === 'write_plugin'));
  // Removed: the next check says so, and the address stops.
  members.delete('user_dan');
  forgetMembersForTests();
  const r = await call(url, 'list_requests');
  assert.equal(r.error, true);
  assert.match(r.text, /no longer in this organisation/);
  // A new address replaces the old.
  members.set('user_dan', { role: 'member', name: 'Dan' });
  const fresh = mcpUrlFor(dan, true);
  assert.notEqual(fresh, url);
  assert.equal((await fetch(mcpBase + new URL(url).pathname, { method: 'POST', body: '{}' })).status, 404);
});

test('the standing address is the host computer’s own person, with every tool', async () => {
  const local: Actor = { id: 'local', name: 'Ana', role: 'owner', via: 'local' };
  const names = (await rpc(mcpUrlFor(local), 'tools/list')).tools!.map(t => t.name);
  assert.ok(names.includes('write_plugin'));
});
