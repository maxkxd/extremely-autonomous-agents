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
