import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULT_PLAN, type AgentDef } from './agent.js';
import { periodEnd, periodStart, setHostZone } from './clock.js';
import { all, one, resetDbForTests, run as exec } from './db.js';
import { bookGoalRuns, checkGoal, goalDue, goalFloor, goalInstructions, goalsOf, levelOf, MAX_GOAL_PARALLEL, noGoalInstructions, paceFor, setGoal, storePace } from './goals.js';
import { stateOf } from './run.js';
import { nextRun, noGoalRequest } from './scheduler.js';
import { execute } from './tools.js';

// Goals (goals.ts): what counts toward one, in which period, and the pace it calls for.

const NOW = Date.UTC(2026, 9, 20, 12); // Tuesday 20 October 2026, noon UTC: half the day left
const MIN = 60_000;
const HOUR = 60 * MIN;
const agent = {
  id: 'outreach',
  name: 'Outreach',
  output: [
    { action: 'gmail.send_email', label: 'Emails sent' },
    { action: 'crm.create_record', label: 'Leads researched' },
  ],
  ferocity: { ...DEFAULT_PLAN, counts: ['gmail.send_email', 'crm.create_record'] },
} as unknown as AgentDef;

let n = 0;
const did = (tool: string, output: number, outcome = 'ok', approval: string | null = null, at = NOW - MIN) =>
  exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, output, approval_id, at) VALUES ('r', 'outreach', ?, '[]', 'T1', ?, ?, ?, ?)", tool, outcome, output, approval, at);
const approval = (id: string, status: string) =>
  exec("INSERT INTO approvals (id, agent_id, run_id, tool, args, status, created_at, expires_at) VALUES (?, 'outreach', 'r', 'gmail.send_email', '{}', ?, ?, ?)", id, status, NOW, NOW + MIN);
const ran = (acts: number, minutes = 10, at = NOW - 60 * MIN) =>
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, ended_at, acts) VALUES (?, 'outreach', 'scheduled', 1, 'succeeded', ?, ?, ?)", `r${n++}`, at, at + minutes * MIN, acts);
const emails = (now = NOW) => goalsOf(agent, now).find(g => g.label === 'Emails sent')!;

beforeEach(() => {
  resetDbForTests();
  setHostZone('UTC');
});

test('an agent with no goal has no pace of its own', () => {
  assert.equal(paceFor(agent, NOW), null);
  assert.deepEqual(goalsOf(agent, NOW).map(g => [g.label, g.amount, g.period]), [['Emails sent', 0, 'day'], ['Leads researched', 0, 'day']]);
});

test("a builder's number on a KPI row is the goal until someone sets one; a per_day from before periods is a day", () => {
  const old = { ...agent, output: [{ action: 'gmail.send_email', label: 'Emails sent', per_day: 50 }] } as AgentDef;
  assert.deepEqual([goalsOf(old, NOW)[0].amount, goalsOf(old, NOW)[0].period], [50, 'day']);
  const built = { ...agent, output: [{ action: 'gmail.send_email', label: 'Emails sent', amount: 5, period: 'week' }] } as AgentDef;
  assert.deepEqual([goalsOf(built, NOW)[0].amount, goalsOf(built, NOW)[0].period], [5, 'week']);
  setGoal('outreach', 'Emails sent', 80, 'month', NOW);
  assert.deepEqual([goalsOf(built, NOW)[0].amount, goalsOf(built, NOW)[0].period], [80, 'month']);
});

test('a draft counts as soon as it is queued, and comes off if a person rejects it', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  did('gmail.send_email', 3);
  approval('a1', 'pending');
  did('gmail.send_email', 1, 'queued', 'a1');
  approval('a2', 'rejected');
  did('gmail.send_email', 1, 'queued', 'a2');
  did('gmail.send_email', 5, 'ok', null, NOW - 30 * HOUR); // yesterday
  did('gmail.send_email', 0, 'failed');
  did('crm.create_record', 7); // another goal's work
  const g = emails();
  assert.equal(g.done, 4);
  assert.equal(g.waiting, 1);
});

test('a period starts on the clock of the host: the top of the hour, midnight, Monday, the 1st, 1 January', () => {
  const at = NOW + 30 * MIN; // Tuesday 12:30
  assert.equal(periodStart('hour', at), NOW);
  assert.equal(periodEnd('hour', at), NOW + HOUR);
  assert.equal(periodStart('day', at), Date.UTC(2026, 9, 20));
  assert.equal(periodStart('week', at), Date.UTC(2026, 9, 19)); // Monday
  assert.equal(periodEnd('week', at), Date.UTC(2026, 9, 26));
  assert.equal(periodStart('week', Date.UTC(2026, 9, 25, 23)), Date.UTC(2026, 9, 19), 'Sunday night is still that week');
  assert.equal(periodStart('month', at), Date.UTC(2026, 9, 1));
  assert.equal(periodEnd('month', Date.UTC(2026, 11, 15)), Date.UTC(2027, 0, 1));
  assert.equal(periodStart('year', at), Date.UTC(2026, 0, 1));
  assert.equal(periodEnd('year', at), Date.UTC(2027, 0, 1));
  // Where the host is, not where the server is: Sydney is 11 hours ahead in October.
  setHostZone('Australia/Sydney');
  assert.equal(periodStart('day', at), Date.UTC(2026, 9, 19, 13));
  assert.equal(periodStart('week', at), Date.UTC(2026, 9, 18, 13));
});

test('a goal counts what was done in the period it is in', () => {
  const at = NOW + 30 * MIN; // Tuesday 12:30
  did('gmail.send_email', 1, 'ok', null, NOW + 10 * MIN); // this hour
  did('gmail.send_email', 1, 'ok', null, NOW - 10 * MIN); // today, the hour before
  did('gmail.send_email', 1, 'ok', null, Date.UTC(2026, 9, 19, 10)); // Monday
  did('gmail.send_email', 1, 'ok', null, Date.UTC(2026, 9, 18, 10)); // last week, this month
  did('gmail.send_email', 1, 'ok', null, Date.UTC(2026, 8, 30)); // September
  did('gmail.send_email', 1, 'ok', null, Date.UTC(2025, 11, 31)); // last year
  const done = (['hour', 'day', 'week', 'month', 'year'] as const).map(period => {
    setGoal('outreach', 'Emails sent', 100, period, at);
    return emails(at).done;
  });
  assert.deepEqual(done, [1, 2, 3, 4, 5]);
});

test('at its goal it eases off to its ordinary schedule, and drops back under if drafts are rejected', () => {
  setGoal('outreach', 'Emails sent', 2, 'day', NOW);
  approval('a1', 'pending');
  did('gmail.send_email', 1, 'queued', 'a1');
  did('gmail.send_email', 1);
  const hit = paceFor(agent, NOW)!;
  assert.equal(hit.status, 'goal hit');
  assert.equal(hit.parallel, 1);
  assert.equal(hit.everyMs, DEFAULT_PLAN.every_hours[0] * 3_600_000);
  assert.equal(goalFloor(hit), null, 'nothing is asked of a run once the goal is reached');
  exec("UPDATE approvals SET status = 'rejected' WHERE id = 'a1'");
  assert.equal(paceFor(agent, NOW)!.remaining, 1);
});

test('a small goal is spread over the rest of the day, one run at a time', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  ran(10);
  const p = paceFor(agent, NOW)!;
  assert.equal(p.parallel, 1);
  assert.equal(p.perRun, 12);
  // 10 runs in the 10.8 hours it aims to finish in.
  assert.ok(p.everyMs > 60 * MIN && p.everyMs < 70 * MIN, `every ${p.everyMs / MIN} min`);
  assert.ok(p.runsPerDay > 20 && p.runsPerDay < 24, `${p.runsPerDay} runs a day`);
  assert.equal(p.status, 'speeding up');
});

test('a goal for the week is spread over what is left of the week', () => {
  setGoal('outreach', 'Emails sent', 150, 'week', NOW);
  ran(10);
  did('gmail.send_email', 64, 'ok', null, Date.UTC(2026, 9, 19, 10)); // Monday's work counts
  const goals = goalsOf(agent, NOW);
  const p = paceFor(agent, NOW, goals)!;
  // 86 to go is 9 runs, in nine tenths of the 5.5 days to Monday: one about every 13 hours.
  assert.equal(p.remaining, 86);
  assert.equal(p.parallel, 1);
  assert.ok(p.everyMs > 13 * HOUR && p.everyMs < 13.5 * HOUR, `every ${p.everyMs / HOUR} h`);
  assert.equal(p.level, 0);
  assert.equal(p.status, 'on pace');
  assert.match(goalInstructions(agent, goals, p), /Emails sent: 64 of 150 this week/);
});

test('a goal for the hour has only what is left of the hour', () => {
  const at = NOW + 30 * MIN;
  setGoal('outreach', 'Emails sent', 30, 'hour', at);
  ran(10);
  const goals = goalsOf(agent, at);
  const p = paceFor(agent, at, goals)!;
  // 3 runs of 10 min 20 s in 27 minutes do not fit one after another: two side by side.
  assert.equal(p.parallel, 2);
  assert.equal(p.everyMs, 18 * MIN);
  assert.equal(p.status, 'pushing hard');
  assert.match(goalInstructions(agent, goals, p), /Emails sent: 0 of 30 this hour/);
  // However little of the period is left, never more runs at once than runs it needs.
  const late = NOW + 59 * MIN;
  setGoal('outreach', 'Emails sent', 1, 'hour', late);
  assert.equal(paceFor(agent, late)!.parallel, 1);
});

test('several goals: the runs each one needs are added together', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  ran(10);
  const one = paceFor(agent, NOW)!.everyMs;
  setGoal('outreach', 'Leads researched', 100, 'day', NOW);
  assert.equal(Math.round(paceFor(agent, NOW)!.everyMs), Math.round(one / 2));
  // A slow goal beside it adds little: 10 more runs over the rest of the year.
  setGoal('outreach', 'Leads researched', 100, 'year', NOW);
  const mixed = paceFor(agent, NOW)!.everyMs;
  assert.ok(mixed < one && mixed > one * 0.95, `every ${mixed / MIN} min beside ${one / MIN}`);
});

test('a goal it cannot reach one run after another gets runs side by side, up to the most allowed', () => {
  setGoal('outreach', 'Emails sent', 600, 'day', NOW);
  ran(10);
  const hard = paceFor(agent, NOW)!;
  // 60 runs of 10 min 20 s just fit in 10.8 hours: back to back, one at a time.
  assert.equal(hard.parallel, 1);
  assert.equal(hard.status, 'pushing hard');
  setGoal('outreach', 'Emails sent', 2000, 'day', NOW);
  // 200 runs: 62 fit one after another, so 4 lanes.
  assert.equal(paceFor(agent, NOW)!.parallel, 4);
  setGoal('outreach', 'Emails sent', 90_000, 'day', NOW);
  const all = paceFor(agent, NOW)!;
  assert.equal(all.parallel, MAX_GOAL_PARALLEL);
  assert.equal(all.level, 4);
  assert.equal(all.status, 'all out');
});

test('the effect level comes from the runs a day the pace is, whoever set that pace', () => {
  assert.deepEqual([0, 2, 2.1, 12, 12.1, 48, 48.1, 200, 200.1, 5000].map(levelOf), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  ran(10);
  const worked = paceFor(agent, NOW)!;
  assert.equal(worked.level, levelOf(worked.runsPerDay));
  assert.equal(worked.level, 2);
  // The Conductor slows it to a run every 3 hours: 8 a day, so the level drops by itself.
  storePace('outreach', 'Emails sent=100/day|Leads researched=0/day', { every_min: 180 }, NOW);
  const slowed = paceFor(agent, NOW)!;
  assert.equal(slowed.runsPerDay, 8);
  assert.equal(slowed.level, 1);
  assert.equal(slowed.status, 'on pace');
  // At its goal, on a 24-hour schedule: one run a day, the calmest there is.
  did('gmail.send_email', 100);
  assert.deepEqual([paceFor(agent, NOW)!.level, paceFor(agent, NOW)!.status], [0, 'goal hit']);
});

test('runs that make nothing are not multiplied', () => {
  setGoal('outreach', 'Emails sent', 9000, 'day', NOW);
  for (let i = 0; i < 5; i++) ran(0);
  const p = paceFor(agent, NOW)!;
  assert.equal(p.status, 'stuck');
  assert.equal(p.parallel, 1);
  assert.equal(p.runsPerDay, 24, 'an hour apart');
});

test("the Conductor's numbers are kept in bounds, and only for the goal they were set for", () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  ran(10);
  const sig = 'Emails sent=100/day|Leads researched=0/day';
  storePace('outreach', sig, { parallel: 500, per_run: 40, every_min: 5, note: 'Use the new lead list first.' }, NOW);
  const p = paceFor(agent, NOW)!;
  assert.equal(p.parallel, MAX_GOAL_PARALLEL);
  assert.equal(p.perRun, 40);
  assert.equal(p.everyMs, 5 * MIN);
  assert.equal(p.note, 'Use the new lead list first.');
  assert.equal(p.status, 'all out', 'its level follows the pace the Conductor set');
  assert.equal(paceFor(agent, NOW + 46 * MIN)!.parallel, 1, 'after a while the worked-out pace stands again');
  storePace('outreach', sig, { parallel: 500 }, NOW);
  setGoal('outreach', 'Emails sent', 100, 'week', NOW);
  assert.equal(paceFor(agent, NOW)!.parallel, 1, 'a changed goal drops them');
});

test('when its goals next want a run', () => {
  const pace = { everyMs: 30 * MIN } as ReturnType<typeof paceFor> & object;
  assert.equal(goalDue(pace, null, null, NOW), true, 'never run: now');
  assert.equal(goalDue(pace, NOW - 20 * MIN, NOW - 10 * MIN, NOW), false);
  assert.equal(goalDue(pace, NOW - 31 * MIN, NOW - 10 * MIN, NOW), true);
  assert.equal(goalDue(pace, NOW - 31 * MIN, NOW - 5_000, NOW), false, 'a breath after the last one');
});

test('the runs beside its main one are booked up to the number wanted, once', () => {
  setGoal('outreach', 'Emails sent', 2000, 'day', NOW);
  ran(10);
  const p = paceFor(agent, NOW)!;
  assert.equal(bookGoalRuns(agent, p, NOW), 3);
  assert.equal(bookGoalRuns(agent, p, NOW), 0);
});

test('the agent is told its goal, how far it is and what this run owes', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  ran(10);
  did('gmail.send_email', 70);
  const goals = goalsOf(agent, NOW);
  const text = goalInstructions(agent, goals, paceFor(agent, NOW, goals)!);
  assert.match(text, /Emails sent: 70 of 100 today/);
  assert.match(text, /You run many times/);
  assert.match(text, /This run: at least 12/);
  assert.doesNotMatch(text, /Leads researched/, 'a label with no number is not a goal');
});

// --- Every agent has a goal ----------------------------------------------------------

test('a goal can never be left blank: the only one with a number cannot go to 0', async () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  assert.throws(() => checkGoal(agent, 'Emails sent', 0, 'day', NOW), /Every agent needs a goal/);
  assert.deepEqual(checkGoal(agent, 'Leads researched', 0, 'day', NOW), { amount: 0, period: 'day' }, 'another label may have no number');
  // Another label has a number: now this one may lose its own.
  setGoal('outreach', 'Leads researched', 20, 'week', NOW);
  assert.deepEqual(checkGoal(agent, 'Emails sent', 0, undefined, NOW), { amount: 0, period: 'day' });
  // Whole numbers from 1 to a million, and a real period. No period: the one it has.
  assert.deepEqual(checkGoal(agent, 'Leads researched', 30.9, undefined, NOW), { amount: 30, period: 'week' });
  assert.deepEqual(checkGoal(agent, 'Leads researched', '45', 'month', NOW), { amount: 45, period: 'month' });
  for (const bad of [-1, 1_000_001, Number.NaN, 'lots', null, undefined]) assert.throws(() => checkGoal(agent, 'Emails sent', bad, 'day', NOW), /whole number from 1 to 1,000,000/);
  assert.throws(() => checkGoal(agent, 'Emails sent', 5, 'fortnight', NOW), /period is one of: hour, day, week, month, year/);

  // The same rule when the agent is asked in its own chat (ops.set_my_goal).
  resetDbForTests();
  setGoal('outreach', 'Emails sent', 100, 'day', Date.now());
  const ctx = { agent: { ...agent, tiers: {}, limits: [], approvalHours: {}, newTools: [] } as AgentDef, runId: 'r_self', level: 0, now: () => Date.now(), fleet: async () => [], wake: () => {} };
  const call = (args: Record<string, unknown>) => execute(ctx, { id: 'c', name: 'ops__set_my_goal', args }, new Map());
  const refused = await call({ goal: 'emails sent', amount: 0 });
  assert.ok(refused.error);
  assert.match(String(refused.content), /Every agent needs a goal/);
  assert.equal(emails(Date.now()).amount, 100, 'nothing changed');
  const set = await call({ goal: 'emails sent', amount: 20, period: 'week' });
  assert.ok(!set.error, String(set.content));
  assert.match(String(set.content), /20 Emails sent a week/);
  assert.deepEqual([emails(Date.now()).amount, emails(Date.now()).period], [20, 'week']);
  assert.ok((await execute(ctx, { id: 'c', name: 'ops__set_my_ferocity', args: { level: 'Chill' } }, new Map())).error, 'nobody sets a level any more: the tool is gone');
});

test('an agent with no goal is not started: no schedule, no bookings, no Run now - only a person is answered', () => {
  const st = () => stateOf('outreach', NOW);
  const booking = (trigger: string) => exec('INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, ?, ?, ?, ?)', 'outreach', trigger, 't', NOW, NOW);
  assert.equal(nextRun(agent, st(), NOW), null, 'never run, and still nothing: it has no goal');
  booking('self-booked');
  booking('handoff');
  booking('run now');
  assert.equal(nextRun(agent, st(), NOW), null, 'what is booked waits');
  booking('your message');
  assert.equal(nextRun(agent, st(), NOW)?.trigger, 'your message');
  exec("DELETE FROM bookings WHERE trigger = 'your message'");
  assert.match(noGoalInstructions(), /no goal yet/);
  // Given a goal, it runs: what a person asked for first, then the rest.
  setGoal('outreach', 'Emails sent', 20, 'day', NOW);
  assert.equal(nextRun(agent, st(), NOW)?.trigger, 'run now');
  exec('DELETE FROM bookings');
  assert.equal(nextRun(agent, st(), NOW)?.trigger, 'scheduled');
  // A built-in has no goal and needs none.
  assert.equal(nextRun({ ...agent, id: 'doctor' }, stateOf('doctor', NOW), NOW)?.trigger, 'scheduled');
});

test('the Agency Engineer is woken once for an agent with no goal, and the request closes when it has one', () => {
  const asked = () => all<{ id: number; status: string; stage: string | null; what: string; why: string }>("SELECT id, status, stage, what, why FROM requests WHERE agent_id = 'outreach' ORDER BY id");
  const wakes = () => one<{ n: number }>("SELECT COUNT(*) AS n FROM bookings WHERE agent_id = 'fleet'")!.n;
  const tick = () => noGoalRequest(agent, !!paceFor(agent, NOW), NOW);
  tick();
  tick();
  tick();
  assert.equal(asked().length, 1, 'one request, however many ticks');
  assert.equal(wakes(), 1, 'the Engineer is woken once');
  assert.deepEqual([asked()[0].status, asked()[0].stage], ['open', 'engineer']);
  assert.match(asked()[0].what, /Set a goal for Outreach/);
  assert.match(asked()[0].why, /engineer\.read_agent[\s\S]*engineer\.set_goal[\s\S]*only if the number really matters/);
  assert.match(one<{ task: string }>("SELECT task FROM bookings WHERE agent_id = 'fleet'")!.task, new RegExp(`Request #${asked()[0].id} from outreach`));
  // The Engineer closing it without setting one does not start a loop of new requests.
  exec("UPDATE requests SET status = 'done' WHERE agent_id = 'outreach'");
  tick();
  assert.equal(asked().length, 1);
  exec("UPDATE requests SET status = 'open' WHERE agent_id = 'outreach'");
  // It gets a goal (the Engineer, a person on its card, the agent in its chat): closed by itself.
  setGoal('outreach', 'Emails sent', 20, 'day', NOW);
  tick();
  assert.deepEqual(asked().map(r => r.status), ['done']);
  tick();
  assert.equal(asked().length, 1);
});
