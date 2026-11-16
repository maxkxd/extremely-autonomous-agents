import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { pickAgency, routerBridge, type Agency } from './mcp-router.js';
import { rpc } from './mcp.js';

// One address for every agency the person can reach (mcp-router.ts): calls go
// to the one named, or the only obvious one; otherwise the AI is told to ask.

const own: Agency = { id: 'personal', name: 'Your agency', role: 'owner', url: '' };
const northside: Agency = { id: 'org_north', name: 'Northside Bikes', role: 'member', url: '' };
const acme: Agency = { id: 'org_acme', name: 'Acme', role: 'admin', url: '' };

test('pickAgency: named, the only one, or asks', () => {
  const both = [own, northside, acme];
  assert.equal((pickAgency(both, 'northside', false) as { agency: Agency }).agency.id, 'org_north', 'part of a name');
  assert.equal((pickAgency(both, 'ORG_ACME', false) as { agency: Agency }).agency.id, 'org_acme', 'an id, any case');
  assert.match((pickAgency(both, 'Zeta', false) as { ask: string }).ask, /no agency "Zeta".*Northside Bikes \(member\)/);
  assert.equal((pickAgency([own], undefined, true) as { agency: Agency }).agency.id, 'personal', 'only one: that one, even empty');
  assert.equal((pickAgency([own, northside], undefined, true) as { agency: Agency }).agency.id, 'org_north', 'an empty agency of your own beside one org: the org');
  assert.match((pickAgency([own, northside], undefined, false) as { ask: string }).ask, /Ask the person which agency/, 'your own has agents: not obvious');
  assert.match((pickAgency([own, northside, acme], '', true) as { ask: string }).ask, /Ask the person.*Northside Bikes.*Acme/, 'two orgs: ask');
});

// Two stand-in agencies answering MCP, recording what they were sent.
let a: Server;
let b: Server;
const got: { at: string; name: string; args: unknown }[] = [];
const agencyServer = (at: string) =>
  createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const msg = JSON.parse(raw);
    if (msg.method === 'ping') return void res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }));
    got.push({ at, name: msg.params.name, args: msg.params.arguments });
    const refused = msg.params.name === 'write_plugin';
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: refused ? 'Only an owner or admin can do that.' : `${at} did ${msg.params.name}` }], isError: refused } }));
  });
const listen = async (s: Server) => (await new Promise<void>(r => s.listen(0, '127.0.0.1', r)), `http://127.0.0.1:${(s.address() as { port: number }).port}/mcp/x`);
let list: Agency[] = [];

before(async () => {
  a = agencyServer('own');
  b = agencyServer('north');
  list = [{ ...own, url: await listen(a) }, { ...northside, url: await listen(b) }, { ...acme, url: 'http://127.0.0.1:1/mcp/closed' }];
});
after(() => {
  a.close();
  b.close();
});

const call = async (name: string, args: Record<string, unknown> = {}, empty = false) => {
  const r = (await rpc(routerBridge(() => list, async () => empty), { id: 1, method: 'tools/call', params: { name, arguments: args } })) as { result: { content: { text: string }[]; isError: boolean } };
  return { text: r.result.content[0].text, error: r.result.isError };
};

test('every tool takes agency; the AI app is told to ask', async () => {
  const init = (await rpc(routerBridge(() => list), { id: 1, method: 'initialize', params: {} })) as { result: { instructions: string } };
  assert.match(init.result.instructions, /ask them before acting/);
  const tools = ((await rpc(routerBridge(() => list), { id: 2, method: 'tools/list' })) as { result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] } }).result.tools;
  assert.equal(tools[0].name, 'list_agencies');
  const create = tools.find(t => t.name === 'create_agent')!;
  assert.ok(create.inputSchema.properties.agency && create.inputSchema.properties.name, 'its own fields, and agency');
});

test('routes to the agency named, without the agency argument', async () => {
  got.length = 0;
  assert.deepEqual(await call('create_agent', { agency: 'Northside', name: 'Lead Research' }), { text: 'north did create_agent', error: false });
  assert.deepEqual(got, [{ at: 'north', name: 'create_agent', args: { name: 'Lead Research' } }]);
  assert.deepEqual(await call('list_agents', { agency: 'personal' }), { text: 'own did list_agents', error: false });
});

test('not named and not obvious: asks, and sends nothing', async () => {
  got.length = 0;
  const r = await call('create_agent', { name: 'X' });
  assert.equal(r.error, true);
  assert.match(r.text, /Ask the person which agency/);
  assert.equal(got.length, 0);
});

test("the agency's own refusals and a closed one come back as errors", async () => {
  assert.deepEqual(await call('write_plugin', { agency: 'Northside' }), { text: 'Only an owner or admin can do that.', error: true });
  const closed = await call('list_agents', { agency: 'Acme' });
  assert.equal(closed.error, true);
  assert.match(closed.text, /Can't reach that agency/);
});

test('list_agencies: each one, whether it answers, and whether your own has agents', async () => {
  const rows = JSON.parse((await call('list_agencies', {}, true)).text) as { id: string; answering: boolean; hasAgents?: boolean }[];
  assert.deepEqual(rows.map(r => [r.id, r.answering]), [['personal', true], ['org_north', true], ['org_acme', false]]);
  assert.equal(rows[0].hasAgents, false);
});
