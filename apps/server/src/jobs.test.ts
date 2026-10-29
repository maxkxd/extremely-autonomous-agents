import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enqueue, resume, waitingSetups } from './jobs.js';
import { resetDbForTests, setSetting } from './runner/db.js';

test('pack set-up waits while the agency is stopped, and carries on when it is resumed', async () => {
  resetDbForTests();
  setSetting('agency_stopped', true);
  enqueue('zz-not-an-agent');
  assert.equal(waitingSetups(), 1); // held, not started
  setSetting('agency_stopped', false);
  await resume();
  assert.equal(waitingSetups(), 0); // started (it has no files, so it ends at once)
});
