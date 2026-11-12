import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { endBrowser, leftoverBrowsers, PROFILES_DIR, pagesToLetGo } from './browser.js';

// In the cloud a second agents' browser ran beside the first on the same profile
// for hours: about 1.5 GB.

test('leftover browsers: a second one on an agents profile', () => {
  const p1 = join(PROFILES_DIR, '1');
  const ps = [
    `  100     1 /usr/bin/google-chrome-stable --user-data-dir=${p1} --remote-debugging-port=0`, // ours
    `  200    35 /usr/bin/google-chrome-stable --user-data-dir=${p1} --remote-debugging-port=0`, // the stray
    `  201   200 /opt/google/chrome/chrome --type=renderer --user-data-dir=${p1}`, // goes with it
    `  300    35 /usr/bin/google-chrome-stable --user-data-dir=${join(PROFILES_DIR, 'person-1')}`, // an old person's copy: not an agents' profile
    `  500    99 /opt/google/chrome/chrome --user-data-dir=/tmp/playwright_chromiumdev_profile-x`, // someone else's
    `  600    35 claude -p --resume abc`,
  ].join('\n');
  assert.deepEqual(leftoverBrowsers(ps, new Set([100])), [200]);
});

test('a browser that ignores being asked to close is ended after the deadline', { skip: process.platform === 'win32' }, async () => {
  // Stands in for Chrome stuck shutting down: it ignores SIGTERM.
  const proc = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: 'ignore', detached: true });
  await new Promise(r => setTimeout(r, 300));
  const started = Date.now();
  await endBrowser(proc, undefined, 500);
  assert.notEqual(proc.signalCode ?? proc.exitCode, null, 'it was ended');
  assert.ok(Date.now() - started < 4_000);
});

test("pages no run is driving are stray; a running run's own page and its popups aren't", async () => {
  const { strayPages } = await import('./browser.js');
  const targets = [
    { targetId: 'run-a', type: 'page' }, // a run's own page
    { targetId: 'google-popup', type: 'page', openerId: 'run-a' }, // its sign-in popup, still in use
    { targetId: 'old-popup', type: 'page', openerId: 'ended-run' }, // a popup left by a run that ended
    { targetId: 'old-tab', type: 'page' }, // a site's new tab, nobody's
    { targetId: 'omnibox', type: 'browser_ui' },
    { targetId: 'sw', type: 'service_worker' },
  ];
  assert.deepEqual(strayPages(targets, new Set(['run-a'])), ['old-popup', 'old-tab']);
  assert.deepEqual(strayPages(targets, new Set()), ['run-a', 'google-popup', 'old-popup', 'old-tab']);
});

// On the person's own screen the agents' browser is theirs to use too: a tab they
// opened is never closed as a stray - only agents' windows and the popups those opened.
test("on the person's screen, only pages agents made are stray", async () => {
  const { strayPages } = await import('./browser.js');
  const targets = [
    { targetId: 'run-a', type: 'page' },
    { targetId: 'ended-run-window', type: 'page' }, // an agent's window whose run ended
    { targetId: 'old-popup', type: 'page', openerId: 'ended-run-window' },
    { targetId: 'persons-tab', type: 'page' }, // opened by the person
  ];
  assert.deepEqual(strayPages(targets, new Set(['run-a']), new Set(['run-a', 'ended-run-window'])), ['ended-run-window', 'old-popup']);
});

// A queued click's page is set aside for it; these are let go.
test('set-aside pages for waiting clicks: decided, unclaimed, day-old and over-the-limit ones go', () => {
  const now = 10 * 3_600_000;
  const min = 60_000;
  const pending = (id: string) => id !== 'decided' && id !== 'never-queued';
  // Just queued: kept even before its approval row is checked.
  assert.deepEqual(pagesToLetGo([{ id: 'never-queued', since: now - 10_000 }], pending, now), []);
  assert.deepEqual(pagesToLetGo([{ id: 'never-queued', since: now - 3 * min }], pending, now), ['never-queued']);
  assert.deepEqual(pagesToLetGo([{ id: 'decided', since: now - 3 * min }, { id: 'a', since: now - 3 * min }], pending, now), ['decided']);
  assert.deepEqual(pagesToLetGo([{ id: 'old', since: now - 25 * 3_600_000 }], pending, now + 0), ['old']);
  // Over the limit (8): the oldest go.
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, since: now - (12 - i) * min }));
  assert.deepEqual(pagesToLetGo(ten, pending, now).sort(), ['p0', 'p1']);
});
