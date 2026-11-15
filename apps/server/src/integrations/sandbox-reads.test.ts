import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { programReads } from './sandbox.js';
import { programsRoot } from './programs.js';

test('programs: the programs folder is always readable, system folders only on Linux and macOS', () => {
  for (const platform of ['linux', 'darwin', 'win32']) assert.ok(programReads(platform).includes(programsRoot()), platform);
  assert.deepEqual(programReads('win32'), [programsRoot()]);
  assert.ok(programReads('linux').includes('/opt') && programReads('linux').includes('/usr'));
  assert.ok(programReads('darwin').includes('/Applications'));
});

test('programs: never the home folder or the whole disk', () => {
  for (const platform of ['linux', 'darwin', 'win32']) for (const p of programReads(platform)) assert.notEqual(p, '/', `${platform}: ${p}`);
  const system = programReads('linux').filter(p => p !== programsRoot());
  assert.ok(!system.some(p => p.startsWith('/home') || p === '/etc' || p === '/data'));
});
