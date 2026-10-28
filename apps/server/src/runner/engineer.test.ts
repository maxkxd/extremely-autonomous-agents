import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parse } from 'yaml';
import { readFile } from 'node:fs/promises';
import { DATA } from '../files.js';
import {
  integrationToolIds,
  listIntegrations,
  loadIntegrations,
  publishIntegration,
  publishPreview,
  removeIntegration,
  testIntegrationTool,
  writeDraftIntegration,
} from '../integrations/index.js';
import { writePlugin } from '../integrations/plugins.js';
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
