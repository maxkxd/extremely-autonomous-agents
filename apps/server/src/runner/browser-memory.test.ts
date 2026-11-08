import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { endBrowser, leftoverBrowsers, PROFILES_DIR } from './browser.js';

// In the cloud a second agents' browser ran beside the first on the same profile
// for hours, and a throwaway browser outlived its run: about 1.5 GB between them.

test('leftover browsers: a stray on an agents profile, and a throwaway one nobody is using', () => {
  const p1 = join(PROFILES_DIR, '1');
  const ps = [
    `  100     1 /usr/bin/google-chrome-stable --user-data-dir=${p1} --remote-debugging-port=0`, // ours
    `  200    35 /usr/bin/google-chrome-stable --user-data-dir=${p1} --remote-debugging-port=0`, // the stray
    `  201   200 /opt/google/chrome/chrome --type=renderer --user-data-dir=${p1}`, // goes with it
    `  300    35 /usr/bin/google-chrome-stable --user-data-dir=${join(PROFILES_DIR, 'person-1')}`, // the person's window
    `  400    35 /opt/google/chrome/chrome --headless --user-data-dir=/tmp/playwright_chromiumdev_profile-4w4FhU`,
    `  500    99 /opt/google/chrome/chrome --user-data-dir=/tmp/playwright_chromiumdev_profile-x`, // someone else's
    `  600    35 claude -p --resume abc`,
  ].join('\n');
  assert.deepEqual(leftoverBrowsers(ps, 35, new Set([100]), false), [200, 400]);
  assert.deepEqual(leftoverBrowsers(ps, 35, new Set([100]), true), [200], 'a throwaway browser in use stays');
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
