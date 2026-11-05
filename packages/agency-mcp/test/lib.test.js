import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The package against a stand-in for the app: two agencies (your own, and an
// organization) answering MCP at the addresses the app's directory file lists.

const dir = mkdtempSync(join(tmpdir(), 'agency-mcp-'));
const file = join(dir, 'agency-mcp.json');
process.env.EAA_MCP_DISCOVERY = file;
delete process.env.EXTREMELY_MCP_URL;
const { agencies, directoryFile, handle, pick, serve } = await import('../lib.js');

const seen = [];
let server;
let base = '';
before(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const msg = JSON.parse(raw);
    const who = req.url.endsWith('own') ? 'own' : req.url.endsWith('org') ? 'org' : null;
    if (!who) return void res.writeHead(404).end();
    seen.push({ who, method: msg.method, params: msg.params });
    const reply = result => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    if (msg.method === 'ping') return reply({});
    if (msg.method === 'tools/list') return reply({ tools: [{ name: 'list_agents', description: 'Every agent', inputSchema: { type: 'object', properties: {} } }] });
    if (msg.method === 'tools/call') {
      if (who === 'org' && msg.params.name === 'write_plugin')
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'For the owner or an admin.' } }));
      return reply({ content: [{ type: 'text', text: `${who}:${msg.params.name}:${JSON.stringify(msg.params.arguments)}` }], isError: false });
    }
    reply({});
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/mcp`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const directory = list => writeFileSync(file, JSON.stringify({ v: 1, agencies: list }));
const both = () =>
  directory([
    { id: 'personal', name: 'Your agency', role: 'owner', url: `${base}/own` },
    { id: 'org_1', name: 'Northside Bikes', role: 'member', url: `${base}/org` },
  ]);
const rpc = (method, params) => handle({ jsonrpc: '2.0', id: 7, method, params });

test('the directory file: the same place the app writes it', () => {
  assert.equal(directoryFile({}, 'win32', 'C:\\home').replaceAll('/', '\\'), 'C:\\home\\AppData\\Roaming\\Extremely Autonomous Agents\\agency-mcp.json');
  assert.equal(directoryFile({ APPDATA: 'D:\\roam' }, 'win32', 'x').replaceAll('/', '\\'), 'D:\\roam\\Extremely Autonomous Agents\\agency-mcp.json');
  assert.equal(directoryFile({}, 'darwin', '/Users/sam').replaceAll('\\', '/'), '/Users/sam/Library/Application Support/Extremely Autonomous Agents/agency-mcp.json');
  assert.equal(directoryFile({ EAA_MCP_DISCOVERY: '/x.json' }), '/x.json');
});

test('picking an agency: your own by default, an organization by name or id', () => {
  both();
  const list = agencies();
  assert.equal(pick(list).id, 'personal');
  assert.equal(pick(list, 'northside bikes').id, 'org_1');
  assert.equal(pick(list, 'org_1').id, 'org_1');
  assert.equal(pick(list, 'north').id, 'org_1');
  assert.equal(pick(list, 'nowhere'), null);
  assert.equal(agencies({ EXTREMELY_MCP_URL: 'http://127.0.0.1:1/mcp/x' })[0].url, 'http://127.0.0.1:1/mcp/x');
});

test('initialize: our own answer, the client’s version when we speak it', async () => {
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion, '2025-06-18');
  assert.equal((await rpc('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-11-25');
  assert.equal((await rpc('initialize', {})).result.serverInfo.name, 'extremely-agency');
  assert.equal((await rpc('nonsense')).error.code, -32601);
  assert.deepEqual((await rpc('prompts/list')).result, { prompts: [] });
});

test('tools: your agency’s own list, each with `agency`; the bundled list when the app is closed', async () => {
  both();
  const live = (await rpc('tools/list')).result.tools;
  assert.deepEqual(
    live.map(t => t.name),
    ['list_agencies', 'list_agents'],
  );
  assert.ok(live[1].inputSchema.properties.agency);
  directory([{ id: 'personal', name: 'Your agency', role: 'owner', url: 'http://127.0.0.1:1/mcp/closed' }]);
  const bundled = (await rpc('tools/list')).result.tools;
  assert.ok(bundled.length > 25, 'the whole bundled list');
  assert.ok(bundled.find(t => t.name === 'decide_approval').annotations.destructiveHint);
  rmSync(file);
  assert.ok((await rpc('tools/list')).result.tools.length > 25, 'no directory at all: still listed');
});

test('calls go to the agency asked for, without `agency` in the arguments', async () => {
  both();
  seen.length = 0;
  const own = (await rpc('tools/call', { name: 'list_agents', arguments: {} })).result;
  assert.equal(own.content[0].text, 'own:list_agents:{}');
  const org = (await rpc('tools/call', { name: 'give_task', arguments: { agency: 'Northside Bikes', agent_id: 'sales', task: 'Call Jo' } })).result;
  assert.equal(org.content[0].text, 'org:give_task:{"agent_id":"sales","task":"Call Jo"}');
  const refused = (await rpc('tools/call', { name: 'write_plugin', arguments: { agency: 'org_1' } })).result;
  assert.deepEqual([refused.isError, refused.content[0].text], [true, 'For the owner or an admin.']);
  const nowhere = (await rpc('tools/call', { name: 'list_agents', arguments: { agency: 'Elsewhere' } })).result;
  assert.match(nowhere.content[0].text, /No agency "Elsewhere"\. Yours: Your agency, Northside Bikes/);
});

test('list_agencies: each with your role and whether it answers', async () => {
  directory([
    { id: 'personal', name: 'Your agency', role: 'owner', url: `${base}/own` },
    { id: 'org_2', name: 'Elsewhere', role: 'admin', url: 'http://127.0.0.1:1/mcp/closed' },
  ]);
  const rows = JSON.parse((await rpc('tools/call', { name: 'list_agencies', arguments: {} })).result.content[0].text);
  assert.deepEqual(
    rows.map(r => [r.name, r.role, r.answering.slice(0, 3)]),
    [
      ['Your agency', 'owner', 'yes'],
      ['Elsewhere', 'admin', 'no:'],
    ],
  );
});

test('the app not running: the call says to open it, as a tool result the model can read', async () => {
  directory([{ id: 'personal', name: 'Your agency', role: 'owner', url: 'http://127.0.0.1:1/mcp/closed' }]);
  const r = (await rpc('tools/call', { name: 'list_agents', arguments: {} })).result;
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Open the Extremely Autonomous Agents app/);
  directory([{ id: 'personal', name: 'Your agency', role: 'owner', url: `${base}/replaced` }]);
  assert.match((await rpc('tools/call', { name: 'list_agents', arguments: {} })).result.content[0].text, /replaced/);
});

test('lines: notifications get nothing, bad JSON a parse error', async () => {
  assert.equal(await serve('{"jsonrpc":"2.0","method":"notifications/initialized"}'), null);
  assert.equal(JSON.parse(await serve('{nope')).error.code, -32700);
  assert.equal(JSON.parse(await serve('{"jsonrpc":"2.0","id":3,"method":"ping"}')).id, 3);
});

test('as a program: stdio in and out, as an AI app runs it', async () => {
  both();
  const bin = fileURLToPath(new URL('../index.js', import.meta.url));
  const child = spawn(process.execPath, [bin], { env: { ...process.env, EAA_MCP_DISCOVERY: file }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => (out += d));
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_agents', arguments: {} } },
  ];
  child.stdin.write(lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const deadline = Date.now() + 10_000;
  while (out.split('\n').filter(Boolean).length < 3 && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  child.stdin.end();
  const replies = out
    .split('\n')
    .filter(Boolean)
    .map(l => JSON.parse(l))
    .sort((a, b) => a.id - b.id);
  assert.deepEqual(
    replies.map(r => r.id),
    [1, 2, 3],
  );
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.equal(replies[2].result.content[0].text, 'own:list_agents:{}');
});
