import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { DATA_DIR } from '../paths.js';
import { DEFAULT_PLAN, type AgentDef } from './agent.js';
import { claim, paceMine, queueForPrompt, queueMine, scheduleMine } from './action-queue.js';
import { decideApproval, recoverInterruptedActions, runApprovedNow, runDueActions, scheduledApprovals } from './approvals.js';
import { all, one, resetDbForTests, run as exec } from './db.js';
import { APPROVAL_SETTLE_MS, book } from './scheduler.js';
import { execute, registerTools } from './tools.js';

// When approved actions run (action-queue.ts): the agent decides; the default is now.

const agent: AgentDef = {
  id: 'zz-queue-test',
  name: 'Media Outreach Test',
  department: 'marketing',
  owner: null,
  org: null,
  charter: '',
  models: [],
  tiers: { 'qmail.send': 'T2' },
  approvalHours: { 'qmail.send': 24 },
  newTools: [],
  events: [],
  newEvents: [],
  output: [],
  maxRunsPerDay: 24,
  ferocity: { ...DEFAULT_PLAN, counts: [] },
  limits: [],
};

// Every send, by approval: never two of one.
let sends: { to: string; from: string; at: number }[] = [];
let failTo = new Set<string>();
let failAfter = Infinity; // every send after this many fails (a mailbox blocked mid-burst)
let delayMs = 0;
// The most sends running at the same moment.
let inFlight = 0;
let maxInFlight = 0;
registerTools([
  {
    id: 'qmail.send',
    tier: 'T2',
    description: 'send an email',
    schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] },
    impl: async args => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      if (delayMs) await new Promise(r => setTimeout(r, delayMs)).finally(() => inFlight--);
      else inFlight--;
      if (failTo.has(String(args.to)) || sends.length >= failAfter) throw new Error('500 INTERNAL_SERVER_ERROR');
      sends.push({ to: String(args.to), from: String(args.from ?? ''), at: Date.now() });
      return `Sent to ${String(args.to)}.`;
    },
  },
]);

const woken: { agent: string; task: string }[] = [];
const wake = (agentId: string, _t: string, task: string) => void woken.push({ agent: agentId, task });
const load = async () => agent;

async function queue(to: string, from = 'pitches@example.com', now = Date.now()) {
  if (!one("SELECT 1 FROM runs WHERE id = 'r1'")) exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at) VALUES ('r1', ?, 'scheduled', 0, 'succeeded', ?)", agent.id, now);
  const ctx = { agent, runId: 'r1', level: 0, now: () => now, fleet: async () => [], wake: () => {} };
  const out = await execute(ctx, { id: to, name: 'qmail__send', args: { from, to, body: 'A pitch' } }, new Map([['qmail__send', 'qmail.send']]));
  assert.equal(out.outcome, 'queued');
  return out.approvalId!;
}
const stateOf = (id: string) => one<{ exec_state: string; due_at: number; ran_at: number | null }>('SELECT exec_state, due_at, ran_at FROM approvals WHERE id = ?', id)!;
// The queue runs in the background: wait until nothing is running.
async function idle() {
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, 5));
    if (!one("SELECT 1 FROM approvals WHERE exec_state = 'running'")) return;
  }
  throw new Error('still running');
}

beforeEach(() => {
  resetDbForTests();
  sends = [];
  failTo = new Set();
  failAfter = Infinity;
  delayMs = 0;
  inFlight = 0;
  maxInFlight = 0;
  woken.length = 0;
});

test('50 rapid approvals wake the agent exactly once, a short while after the last', async () => {
  const ids = [];
  for (let i = 0; i < 50; i++) ids.push(await queue(`editor${i}@outlet${i}.com`));
  const t = Date.now();
  // The real wake: the scheduler's booking. Decided over a minute-ish, as fast as a person clicks.
  for (const id of ids) await decideApproval(id, 'approved', null, (a, tr, task) => book(a, tr as 'approval', task), t, load);
  assert.equal(sends.length, 50);
  const bookings = all<{ due_at: number; task: string }>("SELECT due_at, task FROM bookings WHERE agent_id = ? AND trigger = 'approval'", agent.id);
  assert.equal(bookings.length, 1);
  // Not straight away: after the last decision has settled.
  assert.ok(bookings[0].due_at >= Date.now() + APPROVAL_SETTLE_MS - 5_000);
  assert.match(bookings[0].task, /APPROVED[\s\S]*editor0@outlet0/);
  // 50 outcomes don't make an unbounded task: the rest are pointed to.
  assert.ok(bookings[0].task.length < 20_000);
});

test('by default every approved action runs at once - 100 mailboxes in parallel, one mailbox back to back', async () => {
  delayMs = 20;
  const ids = [];
  for (let i = 0; i < 100; i++) ids.push(await queue(`p${i}@press.com`, `box${i}@example.com`));
  const outs = await Promise.all(ids.map(id => decideApproval(id, 'approved', null, wake, Date.now(), load)));
  assert.ok(outs.every(o => o.ok && o.ran));
  assert.equal(sends.length, 100);
  // Different accounts don't wait on each other: many were sending at the same moment.
  assert.ok(maxInFlight >= 50, `at most ${maxInFlight} at once`);
  assert.ok(ids.every(id => stateOf(id).exec_state === 'done' && stateOf(id).due_at <= stateOf(id).ran_at!));
  // One account, no pace: each runs as it's approved, with nothing scheduled for later.
  delayMs = 0;
  const same = [];
  for (let i = 0; i < 10; i++) same.push(await queue(`s${i}@press.com`));
  for (const id of same) assert.equal((await decideApproval(id, 'approved', null, wake, Date.now(), load)).ran, true);
  assert.equal(sends.length, 110);
  assert.equal((await scheduledApprovals()).length, 0);
});

test('a spread schedule runs each at its time, across a restart', async () => {
  const file = join(DATA_DIR, `queue-restart-${process.pid}.db`);
  resetDbForTests(file);
  const t = Date.now();
  // The agent, queuing a batch of cold pitches from one mailbox, paces it before it's approved.
  assert.match(paceMine(agent.id, { tool: 'qmail.send', account: 'pitches@example.com', every_minutes: 10, why: 'Cold pitches from one mailbox: Zoho blocks bursts' }, t), /10 minutes apart/);
  const ids = [await queue('a@press.com'), await queue('b@press.com'), await queue('c@press.com'), await queue('d@other.com', 'news@example.com')];
  const outs = [];
  for (const id of ids) outs.push(await decideApproval(id, 'approved', null, wake, t, load));
  // The first goes now; the next two wait their turn; another mailbox isn't paced.
  assert.deepEqual(outs.map(o => o.ran), [true, false, false, true]);
  assert.match(String(outs[1].result), /spaces these 10 minutes apart: Cold pitches/);
  // Ten minutes after the one before it ran.
  const first = stateOf(ids[0]).ran_at!;
  assert.deepEqual([stateOf(ids[1]).due_at - first, stateOf(ids[2]).due_at - first], [600_000, 1_200_000]);
  // The card can say when (and why): scheduled, with its time.
  const shown = await scheduledApprovals();
  assert.deepEqual(shown.map(s => [s.id, s.state, s.runsAt]), [[ids[1], 'queued', first + 600_000], [ids[2], 'queued', first + 1_200_000]]);
  assert.match(String(shown[0].why), /Zoho blocks bursts/);

  // The agency restarts: the store is opened again, nothing is in memory.
  resetDbForTests(file);
  assert.equal(recoverInterruptedActions(t + 60_000, wake), 0);
  const at = (ms: number) => ({ wake, load, now: () => first + ms });
  runDueActions(at(5 * 60_000));
  await idle();
  assert.equal(sends.length, 2);
  runDueActions(at(10 * 60_000));
  await idle();
  assert.deepEqual([sends.length, stateOf(ids[1]).ran_at], [3, first + 600_000]);
  assert.equal(stateOf(ids[2]).exec_state, 'queued');
  runDueActions(at(20 * 60_000));
  await idle();
  assert.deepEqual([sends.length, stateOf(ids[2]).ran_at], [4, first + 1_200_000]);
  // The scheduled ones tell the agent once, when the last has run - not once each.
  const told = woken.filter(w => /scheduled approved actions have all run/.test(w.task));
  assert.equal(told.length, 1);
  assert.match(told[0].task, /2 done/);
  resetDbForTests();
});

test('schedule_mine spreads them per account over the time it gives, or runs them now', async () => {
  const t = Date.now();
  failTo = new Set(['first@press.com']);
  const ids = [await queue('first@press.com')];
  await decideApproval(ids[0], 'approved', null, wake, t, load);
  // Held after that failure: these wait for the agent.
  for (const to of ['a@press.com', 'b@press.com', 'c@press.com']) {
    const id = await queue(to);
    ids.push(id);
    assert.equal((await decideApproval(id, 'approved', null, wake, t, load)).ran, false);
  }
  assert.equal(sends.length, 0);
  assert.match(queueForPrompt(agent.id, t), /3 PAUSED after a failure/);
  assert.match(queueMine(agent.id, t), /Holding qmail\.send on pitches@example.com[\s\S]*500 INTERNAL_SERVER_ERROR/);
  assert.match(scheduleMine(agent.id, { run: 'spread', over_minutes: 60, why: 'Zoho blocked the burst; slower now' }, t + 1_000), /3 spread over 60 minutes/);
  assert.deepEqual(ids.slice(1).map(id => stateOf(id).due_at - t), [1_000, 1_801_000, 3_601_000]);
  // A new approval now follows its decision (it isn't held any more): it runs at once.
  const later = await queue('d@press.com');
  assert.equal((await decideApproval(later, 'approved', null, wake, t + 2_000, load)).ran, true);
  // And a person can still say "run now" to one of the spread.
  assert.equal((await runApprovedNow(ids[3], wake, load, t + 3_000)).ran, true);
  assert.equal(stateOf(ids[3]).exec_state, 'done');
  assert.ok(sends.some(s => s.to === 'c@press.com'));
});

test('a failure mid-batch pauses the rest on that account and wakes the agent once - not a broken tool', async () => {
  const t = Date.now();
  const mine = [];
  for (let i = 0; i < 10; i++) mine.push(await queue(`e${i}@press.com`));
  const other = await queue('x@press.com', 'news@example.com');
  // Zoho blocks the mailbox after the third send.
  failAfter = 3;
  const outs = [];
  for (const id of mine) outs.push(await decideApproval(id, 'approved', null, (a, tr, task) => book(a, tr as 'approval', task), t, load));
  assert.deepEqual(outs.map(o => o.ran), [true, true, true, true, false, false, false, false, false, false]);
  assert.equal(outs[3].ok, false);
  // Only the one failure: the other six never went out to fail too.
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE exec_state = 'failed'")!.n, 1);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE exec_state = 'paused'")!.n, 6);
  const bookings = all<{ task: string }>("SELECT task FROM bookings WHERE agent_id = ? AND trigger = 'approval'", agent.id);
  assert.equal(bookings.length, 1);
  assert.equal(bookings[0].task.match(/running it failed/g)?.length, 1);
  assert.match(bookings[0].task, /3 of the same ran fine on pitches@example.com[\s\S]*sending or rate limit than a broken tool[\s\S]*PAUSED/);
  // No "for any input" verdict, no request to fix the tool, off one burst.
  assert.doesNotMatch(bookings[0].task, /for any input/);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE what LIKE 'Fix the tool qmail.send%'")!.n, 0);
  // Another mailbox isn't held.
  failAfter = Infinity;
  assert.equal((await decideApproval(other, 'approved', null, wake, t, load)).ran, true);
  // A scheduled batch failing part-way (no person waiting on it) pauses the rest too, and wakes once.
  woken.length = 0;
  scheduleMine(agent.id, { run: 'now', why: 'Unblocked now' }, t + 60_000);
  failAfter = sends.length + 2;
  runDueActions({ wake, load, now: () => t + 60_000 });
  await idle();
  assert.equal(sends.length, 6);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE exec_state = 'paused'")!.n, 3);
  assert.equal(woken.filter(w => /running it failed/.test(w.task)).length, 1);
  assert.equal(woken.filter(w => /have all run/.test(w.task)).length, 0);
});

test('no action ever runs twice: one claim per row, however many try at once', async () => {
  const t = Date.now();
  delayMs = 15;
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await queue(`d${i}@press.com`, i % 2 ? 'pitches@example.com' : 'news@example.com'));
  paceMine(agent.id, { tool: 'qmail.send', every_minutes: 1, why: 'test' }, t);
  for (const id of ids) await decideApproval(id, 'approved', null, wake, t, load);
  // Everything due at once, and every way of starting them racing.
  const deps = { wake, load, now: () => t + 3_600_000 };
  const racing = [runDueActions(deps), runDueActions(deps), runDueActions(deps)];
  const nows = await Promise.allSettled(ids.map(id => runApprovedNow(id, wake, load, t + 3_600_000)));
  runDueActions(deps);
  await idle();
  assert.ok(racing.length);
  const perTo = new Map<string, number>();
  for (const s of sends) perTo.set(s.to, (perTo.get(s.to) ?? 0) + 1);
  assert.equal(sends.length, 6);
  assert.ok([...perTo.values()].every(n => n === 1));
  assert.ok(nows.some(n => n.status === 'rejected' || n.value.ran !== undefined));
  // The claim itself: exactly once.
  exec("UPDATE approvals SET exec_state = 'queued', due_at = ? WHERE id = ?", t, ids[0]);
  assert.equal(claim(ids[0], t), true);
  assert.equal(claim(ids[0], t), false);
  // Running when the agency stopped: never run again by itself; its agent is told, its account held.
  const left = await queue('z@press.com', 'news@example.com');
  await decideApproval(left, 'approved', null, wake, t, load);
  const more = await queue('z2@press.com', 'news@example.com');
  exec("UPDATE approvals SET status = 'approved', exec_state = 'queued', due_at = ?, account = 'news@example.com' WHERE id = ?", t + 9e6, more);
  woken.length = 0;
  assert.equal(recoverInterruptedActions(t, wake), 1);
  assert.equal(stateOf(ids[0]).exec_state, 'interrupted');
  assert.equal(stateOf(more).exec_state, 'paused');
  assert.match(woken[0].task, /may or may not have happened[\s\S]*won't run again by itself/);
  const before = sends.length;
  runDueActions({ wake, load, now: () => t + 9e7 });
  await idle();
  assert.equal(sends.length, before);
});
