import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAUDE_UNSURE_LIMIT, settleClaudeCheck } from './connections.js';

// Claude Code's sign-in check: one that got no answer (timed out on a busy
// computer) isn't a sign-out while Claude Code is still there; Claude Code
// gone from the computer is, once it's happened a few times in a row.

const signedIn = { installed: true, version: '2.1.300', loggedIn: true, authMethod: 'claude.ai' };
const noAnswer = { installed: true, version: '2.1.300', loggedIn: false, unsure: true };
const notFound = { installed: false, loggedIn: false, unsure: true };

test('a check with no answer keeps the last signed-in answer', () => {
  const r = settleClaudeCheck(noAnswer, signedIn, 0);
  assert.equal(r.facts.loggedIn, true);
  assert.equal(r.unsureInARow, 1);
});

test('Claude Code not found for a moment keeps it too', () => {
  const r = settleClaudeCheck(notFound, signedIn, 0);
  assert.equal(r.facts.installed, true);
  assert.equal(r.facts.loggedIn, true);
});

test('Claude Code not found enough checks in a row counts as lost', () => {
  let n = 0;
  let facts = signedIn as typeof signedIn | ReturnType<typeof settleClaudeCheck>['facts'];
  for (let i = 1; i < CLAUDE_UNSURE_LIMIT; i++) {
    ({ facts, unsureInARow: n } = settleClaudeCheck(notFound, facts, n));
    assert.equal(facts.loggedIn, true, `still signed in after ${i}`);
  }
  ({ facts, unsureInARow: n } = settleClaudeCheck(notFound, facts, n));
  assert.equal(facts.loggedIn, false);
  assert.equal('unsure' in facts, false, 'the flag is not kept on the stored answer');
});

test('a slow Claude Code never counts as a sign-out, however many times', () => {
  let n = 0;
  let facts = signedIn as typeof signedIn | ReturnType<typeof settleClaudeCheck>['facts'];
  for (let i = 0; i < CLAUDE_UNSURE_LIMIT * 3; i++) ({ facts, unsureInARow: n } = settleClaudeCheck(noAnswer, facts, n));
  assert.equal(facts.loggedIn, true);
});

test('a real sign-out shows at once', () => {
  const r = settleClaudeCheck({ installed: true, version: '2.1.300', loggedIn: false, authMethod: 'none' }, signedIn, 2);
  assert.equal(r.facts.loggedIn, false);
  assert.equal(r.unsureInARow, 0);
});

test('an answer resets the count', () => {
  const r = settleClaudeCheck(signedIn, signedIn, 3);
  assert.equal(r.unsureInARow, 0);
  assert.equal(settleClaudeCheck(noAnswer, r.facts, r.unsureInARow).facts.loggedIn, true);
});

test('nothing to keep when it was never signed in', () => {
  assert.equal(settleClaudeCheck(noAnswer, null, 0).facts.loggedIn, false);
  assert.equal(settleClaudeCheck(noAnswer, { installed: true, loggedIn: false }, 0).facts.loggedIn, false);
});
