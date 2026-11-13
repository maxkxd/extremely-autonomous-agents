import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { singletonPid } from './browser.js';

test("Chrome's profile lock names this machine's pid", () => {
  assert.equal(singletonPid('eaa-cloud-host-1979', 'eaa-cloud-host'), 1979);
  assert.equal(singletonPid('other-host-1979', 'eaa-cloud-host'), null);
  assert.equal(singletonPid(null, 'eaa-cloud-host'), null);
  assert.equal(singletonPid('eaa-cloud-host-', 'eaa-cloud-host'), null);
  assert.equal(singletonPid('eaa-cloud-host-nope', 'eaa-cloud-host'), null);
});

test('In the cloud a kept page opens as its own tab, not the profile screen', async () => {
  const { keptPageView } = await import('./browser.js');
  // The screen shows whichever window is on top; the kept tab streams on its own.
  assert.deepEqual(keptPageView(true, 'T1'), { live: 'T1', tab: 'T1' });
  // On the person's own screen its window is brought in front: nothing to show in the app.
  assert.deepEqual(keptPageView(false, 'T1'), { tab: 'T1' });
});

test("A kept page goes once its request is closed some other way", async () => {
  const { keptForClosed } = await import('./browser.js');
  const open = new Set([174, 177]);
  const waits = [{ id: 'a', request: 174 }, { id: 'b', request: 176 }, { id: 'c' }, { id: 'd', request: 177 }];
  // #176 was settled by the Engineer: its page isn't waiting on anyone. A click's page (no request) is the sweep's.
  assert.deepEqual(keptForClosed(waits, r => open.has(r)), ['b']);
});
