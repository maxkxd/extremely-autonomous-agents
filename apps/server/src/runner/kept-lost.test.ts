import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { keptPageLost } from './browser.js';
import { all, one, resetDbForTests, run as exec } from './db.js';

// A page kept for a person, lost before they got to it (the browser closed): the
// request closes - it can't be done, everything filled in went with the page - and
// the agent is woken and told plainly that no person turned it down.

const AGENT = 'zz-kept-lost-test';

function openRequest(what = 'Solve the hCaptcha and submit the Code Story guest pitch') {
  const now = Date.now();
  exec(
    "INSERT INTO requests (agent_id, run_id, what, why, evidence, status, created_at, stage) VALUES (?, 'r_x', ?, 'Everything is filled in', 'Open in signed-in browser: https://www.codestory.co/guest-intake/', 'open', ?, 'person')",
    AGENT,
    what,
    now,
  );
  return one<{ id: number }>('SELECT MAX(id) AS id FROM requests')!.id;
}

beforeEach(() => resetDbForTests());

test('a lost kept page closes its request as the agency, not a person', async () => {
  const id = openRequest();
  await keptPageLost({ request: id, site: 'codestory.co', url: 'https://www.codestory.co/guest-intake/' }, 'the browser closed');
  const r = one<{ status: string; answer: string; stage: string | null; delivered_at: number | null; answered_by: string | null }>(
    'SELECT status, answer, stage, delivered_at, answered_by FROM requests WHERE id = ?',
    id,
  )!;
  assert.equal(r.status, 'withdrawn');
  assert.equal(r.stage, null);
  assert.equal(r.answered_by, null, 'no person answered it');
  assert.match(r.answer, /not by a person/);
  assert.ok(r.delivered_at, 'told in the wake, not again in the next run');
});

test('the agent is woken once, told it was not turned down, and how to redo it', async () => {
  const id = openRequest();
  await keptPageLost({ request: id, site: 'codestory.co', url: 'https://www.codestory.co/guest-intake/' }, 'the browser closed');
  const wakes = all<{ trigger: string; task: string }>('SELECT trigger, task FROM bookings WHERE agent_id = ?', AGENT);
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].trigger, 'request done');
  assert.match(wakes[0].task, /NOT turned down by a person/);
  assert.match(wakes[0].task, /https:\/\/www\.codestory\.co\/guest-intake\//);
  assert.match(wakes[0].task, /show_person/);
});

test('the same loss reported twice closes once and wakes once', async () => {
  const id = openRequest();
  const p = { request: id, site: 'codestory.co', url: 'https://www.codestory.co/guest-intake/' };
  await keptPageLost(p, 'the browser closed');
  await keptPageLost(p, 'the browser closed');
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM bookings WHERE agent_id = ?', AGENT)!.n, 1);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM request_messages WHERE request_id = ? AND from_who = 'engineer'", id)!.n, 1);
});

test('a request a person already answered is left alone', async () => {
  const id = openRequest();
  exec("UPDATE requests SET status = 'done', answer = 'Submitted it', answered_at = ? WHERE id = ?", Date.now(), id);
  await keptPageLost({ request: id, site: 'codestory.co', url: 'https://www.codestory.co/guest-intake/' }, 'the browser closed');
  assert.equal(one<{ status: string }>('SELECT status FROM requests WHERE id = ?', id)!.status, 'done');
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM bookings WHERE agent_id = ?', AGENT)!.n, 0);
});
