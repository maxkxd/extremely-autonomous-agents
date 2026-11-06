import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { personWindowAfterExit, singletonPid } from './browser.js';

test("Chrome's profile lock names this machine's pid", () => {
  assert.equal(singletonPid('eaa-cloud-host-1979', 'eaa-cloud-host'), 1979);
  assert.equal(singletonPid('other-host-1979', 'eaa-cloud-host'), null);
  assert.equal(singletonPid(null, 'eaa-cloud-host'), null);
  assert.equal(singletonPid('eaa-cloud-host-', 'eaa-cloud-host'), null);
  assert.equal(singletonPid('eaa-cloud-host-nope', 'eaa-cloud-host'), null);
});

// The cloud browser disappeared from the page list this way: the Chrome we
// spawned exited because another one had taken the profile, and the exit
// handler dropped the screen while that other Chrome was still the window.
test('a live Chrome that kept the profile stays on screen after the process we started exits', () => {
  assert.equal(personWindowAfterExit(100, 1979, true), 'keep');
  assert.equal(personWindowAfterExit(1979, 1979, true), 'close');
  assert.equal(personWindowAfterExit(100, 1979, false), 'close');
  assert.equal(personWindowAfterExit(100, null, true), 'close');
  assert.equal(personWindowAfterExit(undefined, 1979, true), 'close');
});
