import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interviewDone, overWritten, type Profile } from './org.js';

// The organisation profile chat: once per organisation, starting from what's written.

const blank = (o: Partial<Profile> = {}): Profile => ({ name: 'Acme', what_it_does: '', customers: '', offering: '', voice: '', people: [], notes: [], ...o });

test('the chat runs until it has been done once', () => {
  assert.equal(interviewDone(null), false, 'no profile yet');
  assert.equal(interviewDone(blank({ what_it_does: 'Sells widgets' })), false, 'a few words typed in Settings');
  assert.equal(interviewDone(blank({ what_it_does: 'x', interviewed: true })), true);
  // Before the mark existed, the chat always filled every core field.
  assert.equal(interviewDone(blank({ what_it_does: 'a', customers: 'b', offering: 'c', voice: 'd' })), true);
});

test("the chat's profile keeps what was typed where it left a gap", () => {
  const typed = blank({ what_it_does: 'Sells widgets', notes: ['Founded 2020'], people: [{ name: 'Max', role: 'Sales' }] });
  const chat = blank({ customers: 'Builders', offering: 'Widgets', voice: 'Plain', notes: ['Ships weekly'], interviewed: true });
  const out = overWritten(typed, chat);
  assert.equal(out.what_it_does, 'Sells widgets');
  assert.equal(out.customers, 'Builders');
  assert.deepEqual(out.people, [{ name: 'Max', role: 'Sales' }]);
  assert.deepEqual(out.notes, ['Founded 2020', 'Ships weekly']);
  assert.equal(out.interviewed, true);
  // What the person changed in the chat wins.
  assert.equal(overWritten(typed, blank({ what_it_does: 'Sells gadgets now' })).what_it_does, 'Sells gadgets now');
});
