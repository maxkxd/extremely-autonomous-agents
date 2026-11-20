import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULT_PLAN, FLEET_ENGINEER, type AgentDef } from './agent.js';
import { all, one, resetDbForTests, run as exec } from './db.js';
import { runAgent, stateOf, type RunDeps } from './run.js';
import { book, dropStaleRequestRuns, nextRun } from './scheduler.js';
import { MAX_WAKE_CHARS, MERGED_INTRO, parseWake, WAKE_WINDOWS } from './wakes.js';
import type { Adapter } from './providers.js';

// Every event-driven wake is debounced and joins the one waiting (wakes.ts).

const ID = 'zz-debounce';
const agent = (id = ID): AgentDef => ({
  id,
  name: 'Debounce Agent',
  department: 'research',
  owner: null,
  org: null,
  charter: '# CHARTER - Debounce Agent\nDo things.',
  models: [{ connection: 'a', model: 'm1', effort: 'medium' }],
  tiers: {},
  approvalHours: {},
  newTools: [],
  events: [],
  newEvents: [],
  output: [{ action: 'zz.made_thing', label: 'things made', amount: 1 }], // a goal: an agent with none does not run
  maxRunsPerDay: 24,
  ferocity: { ...DEFAULT_PLAN, counts: [] },
  limits: [],
});
type Row = { id: number; trigger: string; task: string; due_at: number; created_at: number; person_id: string | null };
const bookings = (id = ID) => all<Row>('SELECT id, trigger, task, due_at, created_at, person_id FROM bookings WHERE agent_id = ? ORDER BY id', id);
const T = 1_800_000_000_000;
const { settleMs: SETTLE, maxMs: MAX } = WAKE_WINDOWS.handoff;

beforeEach(() => resetDbForTests());

test('the windows: a minute to settle and five at most; approvals 45 s / 10 min; a DM 8 s / 30 s', () => {
  assert.deepEqual(WAKE_WINDOWS.handoff, { settleMs: 60_000, maxMs: 300_000 });
  assert.deepEqual(WAKE_WINDOWS['request done'], { settleMs: 60_000, maxMs: 300_000 });
  assert.deepEqual(WAKE_WINDOWS.approval, { settleMs: 45_000, maxMs: 600_000 });
  assert.deepEqual(WAKE_WINDOWS['your message'], { settleMs: 8_000, maxMs: 30_000 });
});

test('10 handoffs in 30 s: one booking, due a minute after the last', () => {
  for (let i = 0; i < 10; i++) book(ID, 'handoff', `Task #${i} from a: do ${i}`, T + i * 3_333);
  const b = bookings();
  assert.equal(b.length, 1);
  assert.equal(b[0].trigger, 'handoff');
  assert.equal(b[0].due_at, T + 9 * 3_333 + SETTLE);
  const parts = parseWake(b[0].trigger, b[0].task);
  assert.equal(parts.length, 10);
  assert.ok(parts.every((p, i) => p.trigger === 'handoff' && p.text === `Task #${i} from a: do ${i}`));
  assert.ok(b[0].task.startsWith(MERGED_INTRO));
});

test('a steady stream is still heard: never later than five minutes after the first', () => {
  for (let i = 0; i < 20; i++) book(ID, 'handoff', `Task #${i} from a: x`, T + i * 30_000); // one every 30 s, for 10 minutes
  const b = bookings();
  assert.equal(b.length, 1);
  assert.equal(b[0].due_at, T + MAX);
  // Nothing due before the cap, and it is due at it.
  assert.equal(nextRun(agent(), stateOf(ID), T + MAX - 1)?.bookingId, undefined); // (its schedule may be due: never run)
  assert.equal(nextRun(agent(), stateOf(ID), T + MAX)?.trigger, 'handoff');
});

test('different kinds join one wake, each under its heading; the run hears them as several events', async () => {
  book(ID, 'handoff', 'Task #3 from a: write it', T);
  book(ID, 'request done', 'Request #12 is answered: yes', T + 1_000);
  book(ID, 'request done', 'Request #13 is done - you now have x.y', T + 2_000);
  book(ID, 'approval', 'A person APPROVED your queued x.send (q1).', T + 3_000);
  const b = bookings();
  assert.equal(b.length, 1);
  assert.equal(b[0].trigger, 'handoff'); // the first one's, for ordering and labels
  assert.match(b[0].task, /— Handoff:\nTask #3[\s\S]*— Request #12 done:\nRequest #12 is answered[\s\S]*— Request #13 done:[\s\S]*— Approval:\nA person APPROVED/);
  // Never pulled earlier by a shorter settle: still a minute after the last request done.
  assert.equal(b[0].due_at, T + 2_000 + SETTLE);

  stateOf(ID);
  let opening = '';
  const adapter: Adapter = async req => {
    const first = req.messages[0];
    opening ||= first.role === 'user' ? first.text : '';
    return { text: 'Done.', calls: [], usage: { input: 1, output: 1 } };
  };
  const deps: RunDeps = { now: () => Date.now(), adapter: () => adapter, harness: () => null, modelInfo: () => ({ usable: true, efforts: [] }), cost: async () => 0, wake: () => {}, compact: false };
  await runAgent(agent(), 'handoff', b[0].task, deps);
  assert.match(opening, /4 things came in for you together/);
  // Each told as it would be on its own: the handoff with how to close it.
  assert.match(opening, /— Handoff:\nTask #3 from a: write it\n\nDo it, then close it with tasks\.complete_task\./);
  assert.match(opening, /— Request #12 done:\nRequest #12 is answered: yes Then anything else your job needs\./);
  assert.match(opening, /— Approval:\nA person APPROVED/);
});

test("DMs settle a few seconds and join only the same person's", () => {
  book(ID, 'your message', 'first', T, 'u_jo');
  book(ID, 'your message', 'second', T + 2_000, 'u_jo');
  book(ID, 'your message', 'hello', T + 3_000, 'u_alex');
  const b = bookings();
  assert.equal(b.length, 2);
  assert.deepEqual(
    b.map(x => [x.person_id, x.task, x.due_at]),
    [
      ['u_jo', 'first\n\nsecond', T + 2_000 + 8_000],
      ['u_alex', 'hello', T + 3_000 + 8_000],
    ],
  );
  // Someone typing for a long time is still answered within 30 s of the first.
  for (let i = 1; i <= 10; i++) book(ID, 'your message', `more ${i}`, T + 2_000 + i * 5_000, 'u_jo');
  assert.equal(bookings().find(x => x.person_id === 'u_jo')!.due_at, T + 30_000);
});

test("a person's message is answered first, and stays apart from other events", () => {
  book(ID, 'handoff', 'Task #1 from a: x', T);
  book(ID, 'your message', 'are you there?', T + 1_000, 'u_jo');
  book(ID, 'request done', 'Request #5 is answered: ok', T + 2_000);
  const b = bookings();
  assert.equal(b.length, 2, 'the handoff and the request done together; the message on its own');
  assert.deepEqual(b.map(x => x.trigger), ['handoff', 'your message']);
  const next = nextRun(agent(), stateOf(ID), T + 2_000 + SETTLE);
  assert.equal(next?.trigger, 'your message');
  assert.equal(next?.task, 'are you there?');
});

test("Run now isn't delayed, nor joined", () => {
  book(ID, 'handoff', 'Task #1 from a: x', T);
  book(ID, 'run now', null, T);
  const b = bookings();
  assert.equal(b.length, 2);
  assert.equal(b[1].due_at, T);
  assert.equal(nextRun(agent(), stateOf(ID), T)?.trigger, 'run now');
});

test('on standby, a merged wake runs only what a person set off; the rest stays booked', () => {
  book(ID, 'handoff', 'Task #1 from a: x', T);
  book(ID, 'approval', 'A person REJECTED your queued x.send (q1).', T + 1_000);
  stateOf(ID);
  exec("UPDATE agent_state SET state = 'draining' WHERE agent_id = ?", ID);
  const next = nextRun(agent(), stateOf(ID), T + MAX);
  assert.equal(next?.trigger, 'approval');
  assert.equal(next?.task, 'A person REJECTED your queued x.send (q1).');
  assert.deepEqual(next?.rest?.map(p => p.trigger), ['handoff']);
});

test('an over-long merge gets one pointer to where the rest is listed', () => {
  const long = 'x'.repeat(2_000);
  for (let i = 0; i < 12; i++) book(ID, 'handoff', `Task #${i} from a: ${long}`, T + i);
  const b = bookings();
  assert.equal(b.length, 1);
  assert.ok(b[0].task.length <= MAX_WAKE_CHARS + 400, `${b[0].task.length}`);
  assert.equal(b[0].task.match(/— More:/g)?.length, 1);
  assert.match(b[0].task, /tasks\.list_my_tasks/);
  // Still pushes the due time out.
  assert.equal(b[0].due_at, T + 11 + SETTLE);
});

test('the Agency Engineer: 5 requests in a minute are one run; closing 2 first drops only those', () => {
  const ids = Array.from({ length: 5 }, (_, i) => Number(exec("INSERT INTO requests (agent_id, what, why, created_at) VALUES (?, 'x', 'y', ?)", `a${i}`, T).lastInsertRowid));
  ids.forEach((id, i) => book(FLEET_ENGINEER, 'request', `Request #${id} from a${i}: need a thing`, T + i * 12_000));
  let b = bookings(FLEET_ENGINEER);
  assert.equal(b.length, 1);
  assert.equal(parseWake(b[0].trigger, b[0].task).length, 5);

  exec("UPDATE requests SET status = 'rejected' WHERE id IN (?, ?)", ids[1], ids[3]);
  dropStaleRequestRuns();
  b = bookings(FLEET_ENGINEER);
  assert.equal(b.length, 1);
  const left = parseWake(b[0].trigger, b[0].task);
  assert.deepEqual(
    left.map(p => p.text),
    [ids[0], ids[2], ids[4]].map(id => `Request #${id} from a${ids.indexOf(id)}: need a thing`),
  );
  assert.match(b[0].task, new RegExp(`— New request #${ids[0]}:`));

  // All of them closed: the booking goes.
  exec("UPDATE requests SET status = 'done' WHERE id IN (?, ?, ?)", ids[0], ids[2], ids[4]);
  dropStaleRequestRuns();
  assert.equal(bookings(FLEET_ENGINEER).length, 0);
});

test("the Engineer: a closed request's part goes, a part about none stays, and one left is told plainly", () => {
  const open = Number(exec("INSERT INTO requests (agent_id, what, why, created_at) VALUES ('a', 'x', 'y', ?)", T).lastInsertRowid);
  const closed = Number(exec("INSERT INTO requests (agent_id, what, why, status, created_at) VALUES ('b', 'x', 'y', 'done', ?)", T).lastInsertRowid);
  book(FLEET_ENGINEER, 'request', `Request #${closed} from b: x`, T);
  book(FLEET_ENGINEER, 'turned down', `A person turned down a's ask (#${open}): "x", without saying why.`, T + 1);
  dropStaleRequestRuns();
  const b = bookings(FLEET_ENGINEER);
  assert.equal(b.length, 1);
  // One part left: an ordinary booking of its kind again.
  assert.equal(b[0].trigger, 'turned down');
  assert.equal(b[0].task, `A person turned down a's ask (#${open}): "x", without saying why.`);
});

test('a run a person stopped is booked again with the merged text, and still splits', () => {
  book(ID, 'handoff', 'Task #1 from a: x', T);
  book(ID, 'task done', 'Task #2 from b is done.', T + 1);
  const task = bookings()[0].task;
  exec('DELETE FROM bookings');
  // What run.ts does for a run stopped part-way: the same trigger and text, resume_from set.
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at, resume_from) VALUES (?, 'handoff', ?, ?, ?, 'r_x')", ID, task, T + 5, T + 5);
  book(ID, 'handoff', 'Task #3 from c: y', T + 10);
  const b = one<{ task: string; resume_from: string | null }>('SELECT task, resume_from FROM bookings WHERE agent_id = ?', ID)!;
  assert.equal(b.resume_from, 'r_x');
  assert.deepEqual(
    parseWake('handoff', b.task).map(p => p.trigger),
    ['handoff', 'task done', 'handoff'],
  );
});
