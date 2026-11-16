import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pagesToLetGo, strayPages } from './browser.js';

// Agent tabs no run is driving are closed; a running run's own tab and its popups aren't.
// Only agent tabs are ever listed (the extension never shows the person's own).
test("tabs no run is driving are stray; a running run's own tab and its popups aren't", () => {
  const targets = [
    { targetId: 'run-a', type: 'page' }, // a run's own tab
    { targetId: 'google-popup', type: 'page', openerId: 'run-a' }, // its sign-in popup, still in use
    { targetId: 'old-popup', type: 'page', openerId: 'ended-run' }, // a popup left by a run that ended
    { targetId: 'old-tab', type: 'page' }, // a site's new tab, nobody's
    { targetId: 'sw', type: 'service_worker' },
  ];
  assert.deepEqual(strayPages(targets, new Set(['run-a'])), ['old-popup', 'old-tab']);
  assert.deepEqual(strayPages(targets, new Set()), ['run-a', 'google-popup', 'old-popup', 'old-tab']);
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

test('A kept page goes once its request is closed some other way', async () => {
  const { keptForClosed } = await import('./browser.js');
  const open = new Set([174, 177]);
  const waits = [{ id: 'a', request: 174 }, { id: 'b', request: 176 }, { id: 'c' }, { id: 'd', request: 177 }];
  // #176 was settled by the Engineer: its page isn't waiting on anyone.
  assert.deepEqual(keptForClosed(waits, r => open.has(r)), ['b']);
});
