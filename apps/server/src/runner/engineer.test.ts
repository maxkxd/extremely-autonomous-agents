import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parse } from 'yaml';
import { readFile } from 'node:fs/promises';
import { DATA } from '../files.js';
import {
  discardDraft,
  draftsForRequest,
  integrationToolIds,
  listIntegrations,
  loadIntegrations,
  publishIntegration,
  publishPreview,
  removeIntegration,
  testIntegrationTool,
  writeDraftIntegration,
} from '../integrations/index.js';
import { readPlugin, writePlugin } from '../integrations/plugins.js';
import { resetDbForTests } from './db.js';
import { giveTools } from './engineer.js';

const MOD = 'zz-test-plugin';
const ID = 'zz-test-integration';
const AGENT = 'zz-engineer-test-agent';
const PLUGIN = (greeting: string) => `export default { tools: [{ id: 'zztest.echo', tier: 'T0', description: 'Echo', input: { type: 'object' }, run: async args => '${greeting}:' + args.x }] };\n`;
const DEF = `kind: code\nid: ${ID}\nname: ZZ Test\nwhat: test\nmodule: ${MOD}\nauth: { type: none }\ntest: { tool: zztest.echo, args: { x: hi } }\n`;

before(async () => {
  resetDbForTests();
  await loadIntegrations();
});
after(async () => {
  await removeIntegration(ID).catch(() => {});
  await rm(join(DATA, '..', 'plugins', `${MOD}.ts`), { force: true });
  await rm(join(DATA, AGENT), { recursive: true, force: true });
});

test("a draft is never an agent's; a plugin runs only as approved", async () => {
  await writePlugin(MOD, PLUGIN('hello'));
  await writeDraftIntegration(DEF, 'fleet', 7);
  const listed = (await listIntegrations()).find(i => i.id === ID)!;
  assert.equal(listed.draft, true);
  assert.equal(integrationToolIds().includes('zztest.echo'), false);
  await assert.rejects(testIntegrationTool(ID, 'zztest.echo', { x: 1 }), /only after a person approves/);

  const preview = await publishPreview(ID);
  assert.match(preview.code ?? '', /hello/);
  // Changed after the person saw it: refused.
  await writePlugin(MOD, PLUGIN('sneaky'));
  await assert.rejects(publishIntegration(ID, preview.codeHash), /changed after it was approved/);
  assert.equal(integrationToolIds().includes('zztest.echo'), false);

  await writePlugin(MOD, PLUGIN('hello'));
  const out = await publishIntegration(ID, preview.codeHash);
  assert.deepEqual(out.tools, [{ id: 'zztest.echo', tier: 'T0' }]);
  assert.equal(integrationToolIds().includes('zztest.echo'), true);
  assert.equal(await testIntegrationTool(ID, 'zztest.echo', { x: 'there' }), 'hello:there');
  assert.equal((await listIntegrations()).find(i => i.id === ID)!.draft, false);
});

test('a person-added integration id is not the engineer\'s to overwrite; bad YAML is explained', async () => {
  await assert.rejects(writeDraftIntegration('kind: http\nid: brave-search\nname: x', 'fleet'), /fit the format|built-in/);
  await assert.rejects(writeDraftIntegration('kind: [unclosed', 'fleet'), /valid YAML/);
});

test("giving tools adds them to the agent's TOOLS.yaml, keeping the builder's tier", async () => {
  await mkdir(join(DATA, AGENT), { recursive: true });
  await writeFile(join(DATA, AGENT, 'TOOLS.yaml'), '# a comment the builder wrote\nagent_id: x\nservers: [tasks]\ntools_allowed: [tasks.list_my_tasks]\ntool_tiers:\n  tasks.list_my_tasks: T0\n  images.search_photos: T0\n');
  await giveTools(AGENT, [
    { id: 'images.search_photos', tier: 'T1' },
    { id: 'pexels.get_photo', tier: 'T0' },
  ]);
  const text = await readFile(join(DATA, AGENT, 'TOOLS.yaml'), 'utf8');
  const y = parse(text);
  assert.match(text, /# a comment the builder wrote/);
  assert.deepEqual(y.tools_allowed, ['tasks.list_my_tasks', 'images.search_photos', 'pexels.get_photo']);
  assert.equal(y.tool_tiers['images.search_photos'], 'T0');
  assert.equal(y.tool_tiers['pexels.get_photo'], 'T0');
  assert.deepEqual(y.servers, ['tasks', 'images', 'pexels']);
});

test('a plugin reaches the network only through kit.fetch', async () => {
  const { networkProblems } = await import('../integrations/plugins.js');
  assert.deepEqual(networkProblems("const r = await kit.fetch('https://x.com')"), []);
  assert.equal(networkProblems("const r = await fetch('http://192.168.1.1')").length, 1);
  assert.equal(networkProblems("import http from 'node:http'").length, 1);
  assert.equal(networkProblems("run('Invoke-WebRequest -Uri $u')").length, 1);
  await assert.rejects(writePlugin('zz-test-net', "export default { tools: [] }; fetch('http://localhost')"), /only through kit.fetch/);
});

test("the engineer can't add an MCP server that runs on this computer", async () => {
  await assert.rejects(writeDraftIntegration('kind: mcp\nid: zz-local\nname: L\nwhat: x\nauth: { type: none }\ncommand: [cmd, /c, calc]\n', 'fleet'), /only be added by a person/);
  await assert.rejects(writeDraftIntegration('kind: mcp\nid: zz-local\nname: L\nwhat: x\nauth: { type: none }\nurl: http://localhost:3000/mcp\nlocal: true\n', 'fleet'), /only be added by a person/);
});

test('a turned-down draft is discarded with its plugin code; a redraft of a live one keeps the live one working, then puts it back', async () => {
  const id = 'zz-test-discard';
  const mod = 'zz-test-discard-plugin';
  await writePlugin(mod, PLUGIN('bye'));
  await writeDraftIntegration(DEF.replaceAll(ID, id).replaceAll(MOD, mod), 'fleet', 42);
  assert.deepEqual(draftsForRequest(42), [id]);
  assert.equal(await discardDraft(id), true);
  assert.equal((await listIntegrations()).some(i => i.id === id), false);
  assert.equal(await readPlugin(mod), null);
  assert.deepEqual(draftsForRequest(42), []);

  // The first test made this one live: a turned-down redraft puts the live version back.
  await writePlugin(MOD, PLUGIN('rewritten'));
  await writeDraftIntegration(DEF.replace('name: ZZ Test', 'name: ZZ Test v2'), 'fleet', 7);
  // Meanwhile agents keep the live version; the new code can't be tried before approval.
  assert.equal(integrationToolIds().includes('zztest.echo'), true);
  await assert.rejects(testIntegrationTool(ID, 'zztest.echo', { x: 1 }), /only after a person approves/);
  await loadIntegrations(); // a restart mid-redraft still loads the live code
  assert.equal(integrationToolIds().includes('zztest.echo'), true);
  assert.equal(await discardDraft(ID), true);
  const back = (await listIntegrations()).find(i => i.id === ID)!;
  assert.equal(back.draft, false);
  assert.equal(back.name, 'ZZ Test');
  assert.equal(await testIntegrationTool(ID, 'zztest.echo', { x: 'again' }), 'hello:again');

  // Approved instead: the new code replaces the live one.
  await writePlugin(MOD, PLUGIN('v2'));
  await writeDraftIntegration(DEF, 'fleet', 7);
  const preview = await publishPreview(ID);
  await publishIntegration(ID, preview.codeHash);
  assert.equal(await testIntegrationTool(ID, 'zztest.echo', { x: 'new' }), 'v2:new');
});

test("a field that picks the server's host needs a fixed list of values", async () => {
  const def = (region: string) => `kind: http
id: zz-region
name: Z
what: x
auth:
  type: fields
  fields:
    - name: key
      label: Key
    - name: region
      label: Region
      secret: false
${region}  token:
    url: https://accounts.example.{{region}}/token
    form: { k: "{{key}}" }
base_url: https://api.example.{{region}}
test: { tool: zz.get, args: {} }
tools:
  - id: zz.get
    tier: T0
    description: d
    input: { type: object, properties: {} }
    request: { method: GET, path: /x }
`;
  await assert.rejects(writeDraftIntegration(def(''), 'fleet'), /part of the address's host/);
  await writeDraftIntegration(def('      options: [com, eu, com.au]\n'), 'fleet');
});
