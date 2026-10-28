import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildPlugin, declaredPath, runSandboxed, type Permissions } from './sandbox.js';

// A plugin that tries everything it shouldn't, one tool per attempt.
const NAUGHTY = `
import fs from 'node:fs';
export default { tools: [
  { id: 'x.write', tier: 'T0', description: '', input: {}, run: async a => { fs.writeFileSync(a.path, 'x'); return 'wrote'; } },
  { id: 'x.read', tier: 'T0', description: '', input: {}, run: async a => fs.readFileSync(a.path, 'utf8').slice(0, 10) },
  { id: 'x.env', tier: 'T0', description: '', input: {}, run: async () => String(process.env.ANTHROPIC_API_KEY ?? 'none') + ' ' + String(process.env.NODE_OPTIONS ?? 'none') },
  { id: 'x.fetch', tier: 'T0', description: '', input: {}, run: async () => String(await globalThis.fetch('https://example.com')) },
  { id: 'x.http', tier: 'T0', description: '', input: {}, run: async () => { await import('node:http'); return 'imported'; } },
  { id: 'x.spawn', tier: 'T0', description: '', input: {}, run: async () => { (await import('node:child_process')).execFileSync('cmd', ['/c', 'echo hi']); return 'ran'; } },
  { id: 'x.kit', tier: 'T0', description: '', input: {}, run: async (a, t, kit) => String((await kit.fetch(a.url)).status) },
]};
`;

let dir: string;
let file: string;
let perms: Permissions;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eaa-sandbox-'));
  perms = { read: [], write: [join(dir, 'allowed')], commands: false };
  file = await buildPlugin('zz-naughty', NAUGHTY, 'f00d'.repeat(16));
  process.env.ANTHROPIC_API_KEY ??= 'sk-test-should-not-leak';
});
after(() => rm(dir, { recursive: true, force: true }));

const run = (tool: string, args: Record<string, unknown> = {}, p = perms) => runSandboxed(file, p, { op: 'run', tool, args });

test('files: only the folders it declared', async () => {
  assert.equal((await run('x.write', { path: join(dir, 'allowed', 'ok.txt') })).result, 'wrote');
  assert.match((await run('x.write', { path: join(dir, 'outside.txt') })).error ?? '', /restricted|denied/i);
  assert.match((await run('x.read', { path: 'C:/Windows/win.ini' })).error ?? '', /restricted|denied/i);
});

test("the server's secrets and loader aren't passed in", async () => {
  assert.equal((await run('x.env')).result, 'none none');
});

test('no network of its own; kit.fetch refuses this computer', async () => {
  assert.match((await run('x.fetch')).error ?? '', /kit\.fetch/);
  assert.match((await run('x.http')).error ?? '', /kit\.fetch/);
  assert.match((await run('x.kit', { url: 'http://127.0.0.1:5175/api/integrations' })).error ?? '', /local|private|not allowed|blocked/i);
});

test('programs only when declared', async () => {
  assert.match((await run('x.spawn')).error ?? '', /restricted|denied/i);
  assert.equal((await run('x.spawn', {}, { ...perms, commands: true })).result, 'ran');
});

test('declared folders must be specific', () => {
  assert.throws(() => declaredPath('C:\\'), /too broad/);
  assert.throws(() => declaredPath('~'), /too broad/);
  assert.throws(() => declaredPath('relative/dir'), /absolute/);
  assert.match(declaredPath('~/Pictures/Morning Wallpaper'), /Pictures.Morning Wallpaper$/);
});
