import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectTicket, handInTicket, startHandoff } from './handoff.js';

test("the desktop app's browser sign-in: a ticket only with the app's code, collected once, and not after ten minutes", () => {
  const t0 = 1_000_000;
  const { state } = startHandoff(t0);
  assert.throws(() => handInTicket('someone-else', 'tk', t0), /expired/); // the wrong code: refused
  assert.deepEqual(collectTicket(state, t0), { ticket: null, expired: false }); // not there yet
  handInTicket(state, 'tk_123', t0 + 1000);
  assert.deepEqual(collectTicket(state, t0 + 2000), { ticket: 'tk_123', expired: false });
  assert.equal(collectTicket(state, t0 + 3000).ticket, null); // once only
  const again = startHandoff(t0);
  assert.throws(() => handInTicket(again.state, 'tk', t0 + 11 * 60_000), /expired/);
  assert.equal(startHandoff(t0).state === again.state, false); // a new code each time
});
