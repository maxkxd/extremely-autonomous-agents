import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { DATA_DIR } from '../paths.js';
import { COMPUTER_TOOLS, computerPath } from './computer.js';
import { BUILTIN_IDS, registeredToolIds } from './tools.js';

const dir = await mkdtemp(join(tmpdir(), 'eaa-computer-'));
after(() => rm(dir, { recursive: true, force: true }));

test("never the agency's own data, key stores or secrets files, whatever the tier", () => {
  for (const p of [
    join(DATA_DIR, 'vault.key'),
    join(DATA_DIR, 'x', '..', 'vault.json'),
    '~/.ssh/config',
    join(homedir(), '.aws', 'credentials'),
    join(dir, '.env'),
    join(dir, '.env.local'),
    join(dir, 'id_ed25519'),
    join(dir, 'server.pem'),
  ])
    assert.throws(() => computerPath(p), /never/, p);
  assert.throws(() => computerPath('reports/x.md'), /full path/);
  assert.equal(computerPath('~/Documents/Reports/a.md'), join(homedir(), 'Documents', 'Reports', 'a.md'));
});

test('saves, adds to, reads and lists files on the computer - each use approved by default', async () => {
  assert.ok(registeredToolIds().has('computer_files.write_file'));
  assert.ok(!BUILTIN_IDS.has('computer_files.write_file')); // not plumbing: an agent has it only when given it
  assert.ok(COMPUTER_TOOLS.every(t => t.tier === 'T2'));
  const call = (id: string, args: Record<string, unknown>) => COMPUTER_TOOLS.find(t => t.id === id)!.impl(args, {} as never);
  const file = join(dir, 'Reports', 'payouts.md');
  assert.match(String(await call('computer_files.write_file', { path: file, content: 'Monday: A$100\n' })), /Saved/);
  await call('computer_files.write_file', { path: file, content: 'Tuesday: A$200\n', append: true });
  assert.equal(await call('computer_files.read_file', { path: file }), 'Monday: A$100\nTuesday: A$200\n');
  assert.match(String(await call('computer_files.list_folder', { path: join(dir, 'Reports') })), /payouts\.md - \d+ bytes/);
  await assert.rejects(Promise.resolve().then(() => call('computer_files.read_file', { path: join(dir, 'nothing.md') })), /Nothing at/);
});
