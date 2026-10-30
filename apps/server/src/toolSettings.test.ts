import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Settings > Tools, against a throwaway data folder (never the real agents).
const dir = mkdtempSync(join(tmpdir(), 'eaa-tools-'));
process.env.EAA_DATA_DIR = dir;
const { listTools, setToolTier } = await import('./toolSettings.js');

const agent = (id: string, name: string, tiers: Record<string, string>, extra = {}) => {
  mkdirSync(join(dir, 'agents', id), { recursive: true });
  writeFileSync(join(dir, 'agents', id, 'meta.json'), JSON.stringify({ name, department: 'sales', output: [], status: 'ready', ...extra }));
  const header = Object.entries(tiers).map(([t, tier]) => `#   ${t} [${tier}] - why`).join('\n');
  writeFileSync(join(dir, 'agents', id, 'TOOLS.yaml'), `# TOOLS - ${name}\n${header}\nagent_id: ${id}\ntool_tiers:\n${Object.entries(tiers).map(([t, tier]) => `  ${t}: ${tier}`).join('\n')}\n`);
};
agent('outreach', 'Outreach', { 'gmail.send_message': 'T1', 'web.web_search': 'T0' });
agent('lead-research', 'Lead Research', { 'web.web_search': 'T0', 'crm.create_lead': 'T1' });
agent('fleet', 'Agency Engineer', { 'engineer.publish_integration': 'T2' }, { builtIn: true });

test('every tool the agents use, by a plain name, with who uses it', async () => {
  const tools = await listTools();
  assert.ok(!tools.some(t => t.id.startsWith('engineer.')), "built-ins' own tools aren't a choice to make");
  const search = tools.find(t => t.id === 'web.web_search')!;
  assert.equal(search.name, 'Web search');
  assert.equal(search.source, 'Web');
  assert.ok(search.does.length > 0, 'described from the catalogue');
  assert.deepEqual(search.agents.map(a => a.name).sort(), ['Lead Research', 'Outreach']);
  assert.equal(tools.find(t => t.id === 'gmail.send_message')!.name, 'Send message');
});

test("setting a tool's level sets it for every agent that has it", async () => {
  await setToolTier('web.web_search', 'T2');
  const tools = await listTools();
  assert.equal(tools.find(t => t.id === 'web.web_search')!.tier, 'T2');
  const yaml = readFileSync(join(dir, 'agents', 'outreach', 'TOOLS.yaml'), 'utf8');
  assert.match(yaml, /web\.web_search: T2/);
  assert.match(yaml, /#\s+web\.web_search \[T2\]/, 'the header says so too');
  assert.match(yaml, /approval_windows:[\s\S]*web\.web_search:[\s\S]*window_seconds: 86400/, 'T2 waits a day by default');
  assert.match(yaml, /gmail\.send_message: T1/, 'other tools untouched');
  // One agent changed by hand: mixed.
  writeFileSync(join(dir, 'agents', 'lead-research', 'TOOLS.yaml'), readFileSync(join(dir, 'agents', 'lead-research', 'TOOLS.yaml'), 'utf8').replace('web.web_search: T2', 'web.web_search: T0'));
  assert.equal((await listTools()).find(t => t.id === 'web.web_search')!.tier, 'mixed');
});

test('only real levels, only tools in use', async () => {
  await assert.rejects(setToolTier('web.web_search', 'T3'), /T0, T1 or T2/);
  await assert.rejects(setToolTier('nobody.uses_this', 'T1'), /No agent uses/);
});
