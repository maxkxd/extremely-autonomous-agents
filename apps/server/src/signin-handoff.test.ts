import assert from 'node:assert/strict';
import { test } from 'node:test';
import { heldResult, heldSignIns, heldStatus, parkSignIn } from './signin-handoff.js';

test("a sign-in that came back for an organization hosted elsewhere waits for this computer's app, which sends it on and says how it went", () => {
  const q = new URLSearchParams({ code: 'c-1', state: 's-1' });
  assert.match(parkSignIn(q), /Finishing in the app/);
  assert.deepEqual(heldStatus('s-1'), { done: false });
  // The app collects it once, not twice.
  assert.deepEqual(heldSignIns(), [{ state: 's-1', query: 'code=c-1&state=s-1' }]);
  assert.deepEqual(heldSignIns(), []);
  heldResult('s-1', true, 'Connected');
  assert.deepEqual(heldStatus('s-1'), { done: true, ok: true, message: 'Connected' });
  // One nobody here started or held: said expired, not left waiting.
  assert.equal(heldStatus('s-unknown').done, true);
});
