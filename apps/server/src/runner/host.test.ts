import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crashCause } from './harness.js';
import { groupProcesses, hostHealth, HOST_TOOLS } from './host.js';
import { servedHere } from './tools.js';

// The Doctor once called a crash storm "cleared" minutes before it came back: it
// could only guess at the machine. These are the numbers it reads now.

test("what's using the machine, grouped: the agents' browser's threads stand out", () => {
  const ps = [
    '   29 315000 /usr/bin/google-chrome-stable --user-data-dir=/data/agency/browser-profiles/1 --remote-debugging-port=0',
    '   31 450000 /opt/google/chrome/chrome --type=renderer --user-data-dir=/data/agency/browser-profiles/1',
    '   30 200000 /opt/google/chrome/chrome --type=renderer --user-data-dir=/data/agency/browser-profiles/1',
    '   20 100000 /usr/bin/google-chrome-stable --user-data-dir=/data/agency/browser-profiles/person-1',
    '   18  90000 /opt/google/chrome/chrome --headless --user-data-dir=/tmp/playwright_chromiumdev_profile-x',
    '   12 200000 claude -p --resume abc --output-format json',
    '   11 450000 /usr/local/bin/node --import tsx /app/apps/server/src/index.ts',
    '    9  12000 /app/node_modules/@esbuild/linux-x64/bin/esbuild --service=0.28.2 --ping',
  ].join('\n');
  const g = groupProcesses(ps);
  assert.equal(g[0].what, 'agents’ browser');
  assert.deepEqual([g[0].processes, g[0].threads], [3, 90]);
  assert.equal(g.find(x => x.what === "person's sign-in window")?.processes, 1);
  assert.equal(g.find(x => x.what === 'throwaway browser')?.threads, 18);
  assert.equal(g.find(x => x.what === 'Claude Code')?.threads, 12);
  assert.ok(g.find(x => x.what.startsWith('Node')));
});

test("a Claude Code crash says why: the machine's thread limit, memory, or neither", () => {
  assert.match(crashCause('error: Failed to start HTTP Client thread', 'SIGABRT'), /machine's limit/);
  assert.match(crashCause('spawn /usr/local/bin/claude EAGAIN', 'exit 134'), /machine's limit/);
  assert.match(crashCause('FATAL ERROR: Reached heap limit', 'SIGABRT'), /out of memory/);
  assert.equal(crashCause('oh no: Bun has crashed', 'SIGABRT'), 'crashed (SIGABRT)');
});

test('the report reads on any machine, and the Doctor and Engineer can call both tools', async () => {
  const report = await hostHealth();
  assert.match(report, /^# (Healthy|Needs attention)/);
  assert.match(report, /## The machine\n- CPUs: \d+/);
  assert.match(report, /Memory: \d+ MB/);
  assert.match(report, /## Browsers/);
  for (const id of Object.keys(HOST_TOOLS)) assert.ok(servedHere(id), `${id} is registered`);
});
