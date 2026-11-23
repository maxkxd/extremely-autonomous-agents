import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULT_PLAN, type AgentDef } from './agent.js';
import { PERIOD_MS, rollingSince, setHostZone } from './clock.js';
import { all, one, resetDbForTests, run as exec } from './db.js';
import { bookGoalRuns, checkGoal, goalDue, goalFloor, goalInstructions, goalsOf, levelOf, MAX_GOAL_PARALLEL, noGoalInstructions, paceFor, setGoal, storePace } from './goals.js';
import { stateOf } from './run.js';
import { book, ensurePendingDue, nextRun, noGoalRequest, pendingMain, queueRunNow, RUN_NOW_IN_FLIGHT } from './scheduler.js';
import { execute } from './tools.js';

// Goals (goals.ts): what counts toward one, in which period, and the pace it calls for.

const NOW = Date.UTC(2026, 9, 20, 12); // Tuesday 20 October 2026, noon UTC
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
// A run toward its goal that ended well: what it was asked for (10 unless said) and what it
// made. Its work is dated before the last 24 hours unless said otherwise, so it is history
// and not part of the count.
const ran = (made: number, o: { asked?: number; minutes?: number; at?: number; madeAt?: number } = {}) => {
  const id = `r${n++}`;
  const at = o.at ?? NOW - 60 * MIN;
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, ended_at, acts, floor) VALUES (?, 'outreach', 'scheduled', 1, 'succeeded', ?, ?, ?, ?)", id, at, at + (o.minutes ?? 10) * MIN, made, o.asked ?? 10);
  if (made) exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, output, at) VALUES (?, 'outreach', 'gmail.send_email', '[]', 'T1', 'ok', ?, ?)", id, made, o.madeAt ?? NOW - 26 * HOUR);
  return id;
};
// Its main run, started then and still going, asked for 10.
const going = (at: number) => exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, floor) VALUES ('live', 'outreach', 'scheduled', 1, 'running', ?, 10)", at);
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

test('a draft comes off if a person lets it expire, the same as if they rejected it', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  did('gmail.send_email', 3);
  approval('a1', 'expired');
  did('gmail.send_email', 1, 'queued', 'a1');
  approval('a2', 'pending');
  did('gmail.send_email', 1, 'queued', 'a2');
  const g = emails();
  assert.equal(g.done, 4);
  assert.equal(g.waiting, 1);
  exec("UPDATE approvals SET status = 'expired' WHERE id = 'a2'");
  assert.equal(emails().done, 3);
  assert.equal(emails().waiting, 0);
});

test('a goal counts a trailing window, not a calendar period, and the host time zone does not matter', () => {
  assert.equal(rollingSince('hour', NOW), NOW - HOUR);
  assert.equal(rollingSince('day', NOW), NOW - 24 * HOUR);
  assert.equal(PERIOD_MS.week, 7 * 24 * HOUR);
  assert.equal(PERIOD_MS.month, 30 * 24 * HOUR);
  assert.equal(PERIOD_MS.year, 365 * 24 * HOUR);
  // Just inside / just outside each window, measured back from NOW.
  did('gmail.send_email', 1, 'ok', null, NOW - 10 * MIN); // last hour
  did('gmail.send_email', 1, 'ok', null, NOW - 2 * HOUR); // last 24 hours
  did('gmail.send_email', 1, 'ok', null, NOW - 2 * 24 * HOUR); // last 7 days
  did('gmail.send_email', 1, 'ok', null, NOW - 10 * 24 * HOUR); // last 30 days
  did('gmail.send_email', 1, 'ok', null, NOW - 40 * 24 * HOUR); // last 365 days
  did('gmail.send_email', 1, 'ok', null, NOW - 400 * 24 * HOUR); // older than a year
  const done = (['hour', 'day', 'week', 'month', 'year'] as const).map(period => {
    setGoal('outreach', 'Emails sent', 100, period, NOW);
    return emails(NOW).done;
  });
  assert.deepEqual(done, [1, 2, 3, 4, 5]);
  setHostZone('Australia/Sydney');
  assert.deepEqual(
    (['hour', 'day', 'week', 'month', 'year'] as const).map(period => {
      setGoal('outreach', 'Emails sent', 100, period, NOW);
      return emails(NOW).done;
    }),
    [1, 2, 3, 4, 5],
    'a trailing window does not move with the host time zone',
  );
});

test('at its goal nothing toward it is owed, and it drops back under if drafts are rejected', () => {
  setGoal('outreach', 'Emails sent', 2, 'day', NOW);
  approval('a1', 'pending');
  did('gmail.send_email', 1, 'queued', 'a1');
  did('gmail.send_email', 1);
  const hit = paceFor(agent, NOW)!;
  assert.equal(hit.status, 'goal hit');
  assert.equal(hit.everyMs, DEFAULT_PLAN.every_hours[0] * 3_600_000, 'it keeps its ordinary schedule');
  assert.equal(hit.nextAt, null, 'no run toward its goal is due');
  assert.equal(goalFloor(hit), null, 'nothing is asked of a run once the goal is reached');
  exec("UPDATE approvals SET status = 'rejected' WHERE id = 'a1'");
  const under = paceFor(agent, NOW)!;
  assert.equal(under.remaining, 1);
  assert.equal(under.perRun, 1);
});

test('a goal is a steady rate: runs toward it a fixed time apart, each asked for what its plan says a run makes', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  const p = paceFor(agent, NOW)!;
  assert.equal(p.parallel, 1);
  // Its plan says a run makes 10: 10 runs of 10, one every 2.4 hours - not 12, then 15, then 18.
  assert.equal(p.perRun, 10);
  assert.equal(Math.round(p.gapMs / MIN), 144);
  assert.equal(Math.round(p.runsPerDay), 10);
  assert.equal(p.status, 'on pace');
  assert.ok(p.nextAt! <= NOW, 'never run toward it: one is due now');
  // One just started: the next is due 2.4 hours after it, and nothing is owed until then.
  going(NOW);
  assert.equal(paceFor(agent, NOW + HOUR)!.perRun, 0);
  assert.equal(paceFor(agent, NOW + HOUR)!.nextAt, NOW + 144 * MIN);
  assert.equal(paceFor(agent, NOW + 145 * MIN)!.perRun, 10);
});

test('what a run made buys the time to the next, so the work comes at the goal\'s rate whatever each run makes', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  const at = NOW - 3 * HOUR;
  const next = () => Math.round((paceFor(agent, NOW)!.nextAt! - at) / MIN);
  const again = (made: number, o: Parameters<typeof ran>[1] = {}) => {
    exec('DELETE FROM runs');
    exec('DELETE FROM actions');
    return ran(made, { at, madeAt: at, ...o });
  };
  again(10);
  assert.equal(next(), 144, 'made the 10 it was asked for: 2.4 hours');
  again(5);
  assert.equal(next(), 72, 'made half: the next comes in half the time');
  again(30);
  assert.equal(next(), 144, 'made three times what it was asked for: still 2.4 hours, never days');
  again(0);
  assert.equal(next(), 29, 'made nothing: a breather (a fifth), not straight back');
  // The breather after an empty run is owed: the run after it pays it back by coming sooner.
  again(0, { at: at - HOUR });
  ran(10, { at, madeAt: at });
  assert.equal(next(), 115, '10 made, less the 2 the breather cost');
  // A run that failed bought only what it had made.
  again(3);
  exec("UPDATE runs SET status = 'failed'");
  assert.equal(next(), 43);
});

test('a weekly goal is a steady rate over the last and next 7 days', () => {
  setGoal('outreach', 'Emails sent', 150, 'week', NOW);
  did('gmail.send_email', 64, 'ok', null, NOW - 26 * HOUR); // still inside the last 7 days
  const goals = goalsOf(agent, NOW);
  const p = paceFor(agent, NOW, goals)!;
  // 86 still to go, but the pace is 150 / 7 days, not a sprint over what's left of a calendar week.
  assert.equal(p.remaining, 86);
  assert.equal(p.parallel, 1);
  assert.ok(p.gapMs > 11 * HOUR && p.gapMs < 11.3 * HOUR, `every ${p.gapMs / HOUR} h`);
  assert.equal(p.status, 'on pace');
  assert.match(goalInstructions(agent, goals, p), /Emails sent: 64 of 150 in the last 7 days/);
});

test('an hourly goal holds a steady rate, and a day goal does not sprint in the last hour', () => {
  setGoal('outreach', 'Emails sent', 30, 'hour', NOW + 30 * MIN);
  const goals = goalsOf(agent, NOW + 30 * MIN);
  const p = paceFor(agent, NOW + 30 * MIN, goals)!;
  // 3 runs of 10, one every 20 minutes, whether 30 minutes or 1 minute of a clock hour remains.
  assert.equal(p.parallel, 1);
  assert.equal(Math.round(p.gapMs / MIN), 20);
  assert.match(goalInstructions(agent, goals, p), /Emails sent: 0 of 30 in the last hour/);
  // 240 to go, one hour before "the end of the day": still 240 / 24 hours (10 an hour), not 240 in that hour.
  setGoal('outreach', 'Emails sent', 240, 'day', NOW + 23 * HOUR);
  const late = paceFor(agent, NOW + 23 * HOUR)!;
  assert.equal(late.parallel, 1);
  assert.equal(Math.round(late.gapMs / MIN), 60, 'not a last-hour sprint');
});

test('several goals: the rates of each are added together', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  const one = paceFor(agent, NOW)!.gapMs;
  setGoal('outreach', 'Leads researched', 100, 'day', NOW);
  assert.equal(Math.round(paceFor(agent, NOW)!.gapMs), Math.round(one / 2));
  // A slow goal beside it adds little: 100 more over a year.
  setGoal('outreach', 'Leads researched', 100, 'year', NOW);
  const mixed = paceFor(agent, NOW)!.gapMs;
  assert.ok(mixed < one && mixed > one * 0.95, `every ${mixed / MIN} min beside ${one / MIN}`);
});

test('a small goal on a schedule that already covers it is one at a time, spread out - not all at once', () => {
  // 5 a day on an hourly schedule: 1 a run, every 4.8 hours.
  const hourly = { ...agent, ferocity: { ...agent.ferocity, every_hours: [1, 1, 1, 1] } } as AgentDef;
  setGoal('outreach', 'Emails sent', 5, 'day', NOW);
  const h = paceFor(hourly, NOW)!;
  assert.deepEqual([h.perRun, Math.round(h.gapMs / MIN), h.everyMs], [1, 288, HOUR]);
  // The same on a daily schedule is one run of 5 a day.
  const d = paceFor(agent, NOW)!;
  assert.deepEqual([d.perRun, Math.round(d.gapMs / HOUR)], [5, 24]);
  // 3 a week on a daily schedule: 1 every 56 hours. Its daily runs in between are asked for nothing.
  setGoal('outreach', 'Emails sent', 3, 'week', NOW);
  const w = paceFor(agent, NOW)!;
  assert.deepEqual([w.perRun, Math.round(w.gapMs / HOUR), w.everyMs], [1, 56, 24 * HOUR]);
  ran(1, { asked: 1, at: NOW, madeAt: NOW });
  const between = paceFor(agent, NOW + 24 * HOUR)!;
  assert.equal(between.perRun, 0);
  assert.equal(goalFloor(between), null);
  assert.equal(between.nextAt, NOW + 56 * HOUR);
  assert.match(goalInstructions(agent, goalsOf(agent, NOW + 24 * HOUR), between), /not due yet, so nothing toward it is owed this run/);
});

test('a goal it cannot hold one run after another gets runs side by side, up to the most allowed', () => {
  setGoal('outreach', 'Emails sent', 600, 'day', NOW);
  // 60 runs of 10 min 20 s over 24 hours fit one after another.
  assert.equal(paceFor(agent, NOW)!.parallel, 1);
  setGoal('outreach', 'Emails sent', 2000, 'day', NOW);
  // 200 runs: one lane does about 139 a day, so 2 lanes.
  assert.equal(paceFor(agent, NOW)!.parallel, 2);
  setGoal('outreach', 'Emails sent', 90_000, 'day', NOW);
  const allOut = paceFor(agent, NOW)!;
  assert.equal(allOut.parallel, MAX_GOAL_PARALLEL);
  assert.equal(allOut.level, 4);
  assert.equal(allOut.status, 'all out');
  // Hour-long runs: still a start every few seconds across its lanes, not one an hour.
  ran(10, { minutes: 60 });
  assert.ok(paceFor(agent, NOW)!.gapMs < 5 * MIN);
});

test('the effect level is what holding the goal takes: it moves when the goal does, not when the goal is reached for a moment', () => {
  assert.deepEqual([0, 2, 2.1, 12, 12.1, 48, 48.1, 200, 200.1, 5000].map(levelOf), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]);
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  const worked = paceFor(agent, NOW)!;
  assert.equal(worked.level, levelOf(worked.runsPerDay));
  assert.equal(worked.level, 1);
  // Reached: the word changes, the level does not (holding 100 a day still takes 10 runs a day).
  did('gmail.send_email', 100);
  assert.deepEqual([paceFor(agent, NOW)!.level, paceFor(agent, NOW)!.status], [1, 'goal hit']);
  // A bigger goal moves it at once, reached or not; so does a smaller one.
  setGoal('outreach', 'Emails sent', 1000, 'day', NOW);
  assert.equal(paceFor(agent, NOW)!.level, 3);
  setGoal('outreach', 'Emails sent', 10, 'day', NOW);
  assert.deepEqual([paceFor(agent, NOW)!.level, paceFor(agent, NOW)!.status], [0, 'goal hit']);
});

test('a level right on a boundary stays where it was instead of flickering', () => {
  // 130 a day at 10 a run is 13 runs a day: just over the 12 that separates level 1 from 2.
  setGoal('outreach', 'Emails sent', 130, 'day', NOW);
  assert.equal(paceFor(agent, NOW)!.level, 2, 'with nothing before it, 13 runs a day is level 2');
  ran(10); // its latest run was at level 1
  assert.equal(paceFor(agent, NOW)!.level, 1, 'not far enough over to change');
  setGoal('outreach', 'Emails sent', 150, 'day', NOW);
  assert.equal(paceFor(agent, NOW)!.level, 2, 'clearly over: it changes');
});

test('pace counts only actions toward live goals, not files or browser clicks', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  // A full history of runs like this one (fewer would lean on its plan's number).
  for (let i = 0; i < 20; i++) {
    const id = ran(2, { at: NOW - (i + 1) * HOUR }); // asked for 10, made 2 emails - and a lot that is not its goal
    exec("UPDATE runs SET acts = 50 WHERE id = ?", id);
    exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, output, at) VALUES (?, 'outreach', 'files.write_file', '[]', 'T0', 'ok', 20, ?)", id, NOW - 26 * HOUR);
    exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, output, at) VALUES (?, 'outreach', 'browser.click', '[]', 'T0', 'ok', 28, ?)", id, NOW - 26 * HOUR);
  }
  const p = paceFor(agent, NOW)!;
  // Its runs were asked for 10 and none made more than 2: a run is asked for 2, not 50 workspace writes.
  assert.equal(p.perRun, 2);
  // 100 emails a day at 2 per run is 50 runs a day, not 2.
  assert.equal(Math.round(p.runsPerDay), 50);
});

test('what a run is asked for is a fixed point: it does not creep up or down with what its runs made', () => {
  setGoal('outreach', 'Emails sent', 1000, 'day', NOW);
  // Runs that did exactly as asked: the next is asked for the same, not a fifth more each time.
  for (let i = 0; i < 20; i++) ran(10, { at: NOW - (i + 1) * HOUR });
  assert.equal(paceFor(agent, NOW)!.perRun, 10);
  // Runs that fell a little short (7 to 9 of 10): asked for the 9 its best one made - never
  // its average, which would fall a little further every time - at more runs a day.
  exec('DELETE FROM runs');
  exec('DELETE FROM actions');
  for (let i = 0; i < 20; i++) ran(7 + (i % 3), { at: NOW - (i + 1) * HOUR });
  const short = paceFor(agent, NOW)!;
  assert.equal(short.perRun, 9);
  assert.ok(short.runsPerDay > 123 && short.runsPerDay < 128, `${short.runsPerDay} runs a day`);
  // Once every run in its history was asked for 9, it is asked for its plan's 10 again.
  exec('UPDATE runs SET floor = 9');
  assert.equal(paceFor(agent, NOW)!.perRun, 10);
  // Runs that made more than asked: not asked for more, just fewer of them.
  exec('DELETE FROM runs');
  exec('DELETE FROM actions');
  for (let i = 0; i < 20; i++) ran(20, { at: NOW - (i + 1) * HOUR });
  const eager = paceFor(agent, NOW)!;
  assert.equal(eager.perRun, 10);
  assert.equal(Math.round(eager.runsPerDay), 50);
  // A run asked for the last 2 before its goal that made 2 did its whole job.
  exec('DELETE FROM runs');
  exec('DELETE FROM actions');
  for (let i = 0; i < 20; i++) ran(2, { asked: 2, at: NOW - (i + 1) * HOUR });
  const topUps = paceFor(agent, NOW)!;
  assert.equal(topUps.perRun, 10, 'not "a run only makes 2"');
  assert.equal(Math.round(topUps.runsPerDay), 100);
});

test('runs that make nothing are not multiplied, and a run asked for nothing never counts as one', () => {
  setGoal('outreach', 'Emails sent', 9000, 'day', NOW - 30 * HOUR);
  for (let i = 0; i < 5; i++) ran(0);
  const p = paceFor(agent, NOW)!;
  assert.equal(p.status, 'stuck');
  assert.equal(p.parallel, 1);
  // Its ordinary schedule is once a day: stuck, it is never run more often than that.
  assert.equal(p.runsPerDay, 1, 'no more often than its own schedule');
  // It is still asked for one, gently: asked for nothing it would make nothing for good.
  assert.deepEqual(goalFloor(p), { floor: 1, nudges: 1, soft: true });
  // One whose schedule is hourly: an hour apart, then further apart with each empty run.
  const hourly = { ...agent, ferocity: { ...agent.ferocity, every_hours: [1, 1, 1, 1] } } as AgentDef;
  assert.equal(paceFor(hourly, NOW)!.everyMs, HOUR);
  for (let i = 0; i < 3; i++) ran(0);
  assert.equal(paceFor(hourly, NOW)!.everyMs, 8 * HOUR, '8 empty runs: 8 hours apart');
  for (let i = 0; i < 10; i++) ran(0);
  assert.equal(paceFor(hourly, NOW)!.everyMs, 24 * HOUR, 'at most a day apart');
  // One run that makes something and it is out.
  ran(1, { asked: 1, at: NOW - MIN });
  assert.notEqual(paceFor(hourly, NOW)!.status, 'stuck');
  // Runs it made while its goal was reached were asked for nothing and made nothing, as
  // told: they are not "its last runs made nothing".
  exec('DELETE FROM runs');
  exec('DELETE FROM actions');
  for (let i = 0; i < 8; i++) exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, ended_at, acts) VALUES (?, 'outreach', 'scheduled', 1, 'succeeded', ?, ?, 0)", `idle${i}`, NOW - (i + 1) * HOUR, NOW - (i + 1) * HOUR + 10 * MIN);
  const after = paceFor(agent, NOW)!;
  assert.notEqual(after.status, 'stuck');
  assert.equal(after.perRun, 10);
});

test('a changed goal gets a fresh try: runs from before it do not count toward stuck', () => {
  setGoal('outreach', 'Emails sent', 50, 'day', NOW - 2 * HOUR);
  for (let i = 0; i < 9; i++) ran(0, { at: NOW - 90 * MIN + i * MIN });
  assert.equal(paceFor(agent, NOW)!.status, 'stuck');
  setGoal('outreach', 'Emails sent', 60, 'day', NOW);
  const fresh = paceFor(agent, NOW)!;
  assert.notEqual(fresh.status, 'stuck');
  assert.ok(fresh.perRun > 0 && fresh.nextAt! <= NOW, 'and a run toward it is due at once');
});

test("the Conductor's numbers are kept in bounds, and only for the goal they were set for", () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  const sig = 'Emails sent=100/day|Leads researched=0/day';
  storePace('outreach', sig, { per_run: 40, note: 'Use the new lead list first.' }, NOW);
  const bigger = paceFor(agent, NOW)!;
  // 40 a run instead of 10: a quarter of the runs, the same 100 a day.
  assert.equal(bigger.perRun, 40);
  assert.equal(bigger.note, 'Use the new lead list first.');
  assert.equal(bigger.runsPerDay, 2.5);
  // 500 at once every 5 minutes is 144,000 runs a day: held to twice the worked-out pace.
  storePace('outreach', sig, { parallel: 500, per_run: 40, every_min: 5 }, NOW);
  const p = paceFor(agent, NOW)!;
  assert.equal(p.runsPerDay, 5);
  assert.equal(p.parallel, MAX_GOAL_PARALLEL, 'lanes are only room: runs still start a gap apart');
  // Slowing it down is the Conductor's call, however far.
  storePace('outreach', sig, { every_min: 600 }, NOW);
  assert.equal(paceFor(agent, NOW)!.gapMs, 600 * MIN);
  going(NOW);
  assert.equal(paceFor(agent, NOW)!.nextAt, NOW + 600 * MIN, 'and the next run waits that long');
  assert.equal(Math.round(paceFor(agent, NOW + 46 * MIN)!.gapMs / MIN), 144, 'after a while the worked-out pace stands again');
  storePace('outreach', sig, { parallel: 500 }, NOW);
  setGoal('outreach', 'Emails sent', 100, 'week', NOW);
  assert.equal(paceFor(agent, NOW)!.parallel, 1, 'a changed goal drops them');
});

test('when a run of its own is due: its ordinary schedule, or a run toward its goals', () => {
  const pace = { everyMs: 30 * MIN, nextAt: null } as ReturnType<typeof paceFor> & object;
  assert.equal(goalDue(pace, null, null, NOW), true, 'never run: now');
  assert.equal(goalDue(pace, NOW - 20 * MIN, NOW - 10 * MIN, NOW), false);
  assert.equal(goalDue(pace, NOW - 31 * MIN, NOW - 10 * MIN, NOW), true);
  assert.equal(goalDue(pace, NOW - 31 * MIN, NOW - 5_000, NOW), false, 'a breath after the last one');
  const due = { ...pace, nextAt: NOW - MIN };
  assert.equal(goalDue(due, NOW - 20 * MIN, NOW - 10 * MIN, NOW), true, 'a run toward its goal is due');
  assert.equal(goalDue({ ...pace, nextAt: NOW + MIN }, NOW - 20 * MIN, NOW - 10 * MIN, NOW), false);
  assert.equal(goalDue(due, NOW - 20 * MIN, NOW - 10 * MIN, NOW, true), false, 'with lanes, that one is another lane\'s');
});

test('the runs beside its main one start a gap apart like any other, never back to back', () => {
  setGoal('outreach', 'Emails sent', 2000, 'day', NOW);
  const p = paceFor(agent, NOW)!;
  assert.equal(p.parallel, 2);
  assert.equal(bookGoalRuns(agent, p, NOW), 0, 'its main run is free: the run that is due is its');
  // Its main run started 8 minutes ago and is still going; the next is due (every 7.2 minutes).
  going(NOW - 8 * MIN);
  const due = paceFor(agent, NOW)!;
  assert.ok(due.nextAt! <= NOW);
  assert.equal(bookGoalRuns(agent, due, NOW), 1);
  assert.equal(bookGoalRuns(agent, due, NOW), 0, 'one waiting at most');
  // That one started: nothing more until the next is due, however free its lanes are.
  exec("DELETE FROM bookings WHERE agent_id = 'outreach'");
  exec("INSERT INTO runs (id, agent_id, trigger, task, ferocity, status, started_at, floor) VALUES ('p1', 'outreach', 'parallel', 'Goal batch', 1, 'running', ?, 10)", NOW);
  const later = paceFor(agent, NOW + MIN)!;
  assert.ok(later.nextAt! > NOW + MIN);
  assert.equal(bookGoalRuns(agent, later, NOW + MIN), 0);
});

test('surplus bookings for its lanes collapse to one waiting, and to none when nothing is due', () => {
  setGoal('outreach', 'Emails sent', 2000, 'day', NOW);
  const p = paceFor(agent, NOW)!;
  for (let i = 0; i < 8; i++) exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES ('outreach', 'parallel', 'Goal batch extra', ?, ?)", NOW, NOW);
  // A piece of work it split off itself (ops.start_parallel_run) is not one of these.
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES ('outreach', 'parallel', 'The film for Acme', ?, ?)", NOW, NOW);
  assert.equal(bookGoalRuns(agent, p, NOW), 0);
  assert.equal(all("SELECT id FROM bookings WHERE agent_id = 'outreach' AND task LIKE 'Goal batch%'").length, 1);
  going(NOW);
  assert.equal(bookGoalRuns(agent, paceFor(agent, NOW)!, NOW), 0);
  assert.equal(all("SELECT id FROM bookings WHERE agent_id = 'outreach' AND task LIKE 'Goal batch%'").length, 0, 'nothing is due: none wait');
  assert.equal(all("SELECT id FROM bookings WHERE agent_id = 'outreach'").length, 1, 'its own piece is left alone');
});

test('the agent is told its goal, how far it is and what this run owes', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  did('gmail.send_email', 70);
  const goals = goalsOf(agent, NOW);
  const text = goalInstructions(agent, goals, paceFor(agent, NOW, goals)!);
  assert.match(text, /Emails sent: 70 of 100 in the last 24 hours/);
  assert.match(text, /You run many times/);
  assert.match(text, /This run: 10 toward it/);
  assert.doesNotMatch(text, /Leads researched/, 'a label with no number is not a goal');
  // Reached: told not to add to it, and what to do instead.
  did('gmail.send_email', 30);
  const hit = goalInstructions(agent, goalsOf(agent, NOW), paceFor(agent, NOW)!);
  assert.match(hit, /Your goal is reached for now, so nothing toward it is owed this run\. Don't add to it now/);
  assert.doesNotMatch(hit, /This run:/);
  // A run for something else (a person's message, a task) is never told to hold back.
  const other = goalInstructions(agent, goalsOf(agent, NOW), { ...paceFor(agent, NOW)!, perRun: 0, other: true });
  assert.match(other, /This run is for what you were just asked or told, not for your goal/);
  assert.doesNotMatch(other, /Don't add to it/);
});

test('work about to leave the window is replaced as it goes, not after the count has dipped', () => {
  setGoal('outreach', 'Emails sent', 5, 'day', NOW);
  // All 5 were made in one run, 24 hours ago less two minutes: still 5 of 5 right now.
  const at = NOW - 24 * HOUR + 2 * MIN;
  ran(5, { asked: 5, at: at - 10 * MIN, madeAt: at });
  const p = paceFor(agent, NOW)!;
  assert.equal(p.status, 'goal hit');
  assert.equal(p.perRun, 5, 'a run starting now makes the 5 that leave while it works');
  assert.match(goalInstructions(agent, goalsOf(agent, NOW), p), /You are at your goal, and that many are about to drop out of the count/);
  // An hour earlier nothing was leaving yet: nothing owed.
  assert.equal(paceFor(agent, NOW - HOUR)!.perRun, 0);
});

test('a run for a little waits until it is worth one; Run now works toward the goal whenever it is short', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  did('gmail.send_email', 93, 'ok', null, NOW - 2 * HOUR);
  // Its last run was asked for 10 and made 4: 3 short of the goal now.
  ran(4, { at: NOW - HOUR, madeAt: NOW - HOUR });
  const little = paceFor(agent, NOW)!;
  assert.equal(little.remaining, 3);
  assert.equal(little.perRun, 0, '3 is not worth a run yet');
  assert.equal(little.nextAt, NOW - HOUR + 144 * MIN, 'it waits out the time its last run was asked to cover');
  assert.equal(paceFor(agent, NOW + 90 * MIN)!.perRun, 3);
  // A person pressing Run now gets a run that works toward it.
  assert.equal(paceFor(agent, NOW, undefined, true)!.perRun, 3);
  // 8 short is worth one as soon as its last run's 4 have bought their time (58 minutes).
  exec("DELETE FROM actions WHERE at = ?", NOW - 2 * HOUR);
  did('gmail.send_email', 88, 'ok', null, NOW - 2 * HOUR);
  assert.equal(paceFor(agent, NOW)!.perRun, 8);
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
  // It gets a goal (the Engineer, a person on its card, the agent in its chat): closed by itself.
  setGoal('outreach', 'Emails sent', 20, 'day', NOW);
  tick();
  assert.deepEqual(asked().map(r => r.status), ['done']);
  tick();
  assert.equal(asked().length, 1);
});

test('a no-goal request is re-filed after backoff if the Engineer closes it without setting one, and the backoff resets once it has a goal', () => {
  const asked = () => all<{ id: number; status: string }>("SELECT id, status FROM requests WHERE agent_id = 'outreach' ORDER BY id");
  const tick = (at: number, has = false) => noGoalRequest(agent, has, at);
  tick(NOW);
  tick(NOW);
  assert.equal(asked().length, 1, 'still one while it is open');
  exec("UPDATE requests SET status = 'done' WHERE agent_id = 'outreach'");
  tick(NOW);
  tick(NOW + 59 * MIN);
  assert.equal(asked().length, 1, 'not again until the 1-hour cooldown is over');
  tick(NOW + HOUR);
  assert.equal(asked().length, 2);
  assert.equal(asked()[1].status, 'open');
  exec("UPDATE requests SET status = 'done' WHERE status = 'open'");
  tick(NOW + HOUR);
  tick(NOW + 7 * HOUR - 1);
  assert.equal(asked().length, 2, 'the second close waits 6 hours');
  tick(NOW + 7 * HOUR);
  assert.equal(asked().length, 3);
  exec("UPDATE requests SET status = 'done' WHERE status = 'open'");
  tick(NOW + 7 * HOUR);
  tick(NOW + 31 * HOUR - 1);
  assert.equal(asked().length, 3, 'then at most daily');
  tick(NOW + 31 * HOUR);
  assert.equal(asked().length, 4);
  // A goal resets the backoff: losing it later asks again immediately, not after another day.
  setGoal('outreach', 'Emails sent', 20, 'day', NOW + 31 * HOUR);
  tick(NOW + 31 * HOUR, true);
  assert.ok(asked().every(r => r.status === 'done'));
  exec("DELETE FROM agent_goals WHERE agent_id = 'outreach'");
  tick(NOW + 31 * HOUR + 1);
  assert.equal(asked().length, 5);
  assert.equal(asked()[4].status, 'open');
  tick(NOW + 31 * HOUR + 1);
  assert.equal(asked().length, 5, 'still only one open');
});

test('due ticks during a long run collapse into one pending start, not a backlog and not dropped', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  const started = NOW - 5 * HOUR;
  going(started);
  const p = paceFor(agent, NOW)!;
  assert.ok(p.nextAt! < NOW && p.parallel === 1);
  const st = () => stateOf('outreach', NOW);
  st(); // ensure the row exists
  exec('UPDATE agent_state SET last_scheduled_at = ? WHERE agent_id = ?', started, 'outreach');
  ensurePendingDue(agent, p, st(), NOW);
  ensurePendingDue(agent, p, st(), NOW);
  ensurePendingDue(agent, p, st(), NOW);
  const pending = all<{ trigger: string }>("SELECT trigger FROM bookings WHERE agent_id = 'outreach'");
  assert.equal(pending.length, 1, 'one pending, however many ticks came due');
  assert.equal(pending[0].trigger, 'scheduled');
  // The in-flight run is still going: the pending one waits for it.
  assert.equal(pendingMain('outreach')?.trigger, 'scheduled');
  // Once it finishes (and has had a breath), that one pending run is what starts.
  exec("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = 'live'", NOW - 30_000);
  assert.equal(nextRun(agent, st(), NOW)?.trigger, 'scheduled');
  assert.equal(nextRun(agent, st(), NOW)?.bookingId, pendingMain('outreach')?.id);
  // With lanes, a run toward its goal that comes due while its main run is going is another
  // lane's: no second main run is queued behind this one.
  exec("DELETE FROM bookings WHERE agent_id = 'outreach'");
  exec("UPDATE runs SET status = 'running', ended_at = NULL, started_at = ? WHERE id = 'live'", NOW - 20 * MIN);
  exec('UPDATE agent_state SET last_scheduled_at = ? WHERE agent_id = ?', NOW - 20 * MIN, 'outreach');
  setGoal('outreach', 'Emails sent', 2000, 'day', NOW);
  const lanes = paceFor(agent, NOW)!;
  assert.ok(lanes.parallel > 1 && lanes.nextAt! <= NOW);
  ensurePendingDue(agent, lanes, st(), NOW);
  assert.equal(pendingMain('outreach'), undefined);
});

test('Run now behind an in-flight run leaves one pending start and says so; repeats do not pile up', () => {
  setGoal('outreach', 'Emails sent', 20, 'day', NOW);
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, ended_at, acts) VALUES ('live', 'outreach', 'scheduled', 1, 'running', ?, NULL, 0)", NOW);
  const first = queueRunNow('outreach', NOW);
  const again = queueRunNow('outreach', NOW);
  const third = queueRunNow('outreach', NOW);
  assert.equal(first.message, RUN_NOW_IN_FLIGHT);
  assert.equal(again.message, RUN_NOW_IN_FLIGHT);
  assert.equal(third.queued, true);
  assert.equal(all("SELECT id FROM bookings WHERE agent_id = 'outreach' AND trigger = 'run now'").length, 1);
  // With no run in flight, Run now is booked rather than eaten.
  exec("UPDATE runs SET status = 'succeeded', ended_at = ? WHERE id = 'live'", NOW);
  exec("DELETE FROM bookings WHERE agent_id = 'outreach'");
  const fresh = queueRunNow('outreach', NOW);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.queued, undefined);
  assert.equal(all("SELECT id FROM bookings WHERE agent_id = 'outreach' AND trigger = 'run now'").length, 1);
  book('outreach', 'run now', null, NOW);
  book('outreach', 'scheduled', null, NOW);
  assert.equal(all("SELECT id FROM bookings WHERE agent_id = 'outreach'").length, 1, 'a later book joins the same slot');
});

test('runs that made nothing count in what a run makes, so the rate still reaches the goal', () => {
  setGoal('outreach', 'Emails sent', 100, 'day', NOW);
  // Every other run makes 10, the rest nothing: 5 a run on average, over a full history.
  for (let i = 0; i < 20; i++) ran(i % 2 ? 10 : 0, { at: NOW - (i + 1) * HOUR });
  const p = paceFor(agent, NOW)!;
  // 100 a day at 5 a run is 20 runs a day, not the 10 that would leave it at half its goal.
  assert.equal(Math.round(p.runsPerDay), 20);
  // A run that does make something makes 10: that is still what one run is asked for.
  assert.equal(p.perRun, 10);
});

test('a draft a person let expire still counts as what its run made, though it comes off the goal', () => {
  setGoal('outreach', 'Emails sent', 50, 'day', NOW - 30 * HOUR);
  // 20 runs, each queuing the 10 it was asked for, which expired before anyone decided (an
  // expired draft's action is settled as refused, as approvals.ts does).
  for (let i = 0; i < 20; i++) {
    const id = ran(0, { at: NOW - (i + 1) * HOUR });
    approval(`x${i}`, 'expired');
    exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, output, approval_id, at) VALUES (?, 'outreach', 'gmail.send_email', '[]', 'T1', 'refused', 10, ?, ?)", id, `x${i}`, NOW - (i + 1) * HOUR);
  }
  assert.equal(emails().done, 0);
  const p = paceFor(agent, NOW)!;
  // Its runs did what they were asked: 50 a day at 10 a run is 5 runs a day, not hundreds
  // as if its runs made nothing.
  assert.equal(Math.round(p.runsPerDay), 5);
  assert.notEqual(p.status, 'stuck');
  // A rejected one is no good: that run made nothing.
  exec("UPDATE approvals SET status = 'rejected'");
  assert.equal(paceFor(agent, NOW)!.status, 'stuck');
});

test('with only a few runs behind it, a poor start does not send it all out', () => {
  setGoal('outreach', 'Emails sent', 50, 'day', NOW);
  // Three runs asked for 10, one of which made 1: on its own that is a thirtieth of what
  // they were asked for, 150 runs a day.
  for (let i = 0; i < 3; i++) ran(i ? 0 : 1, { at: NOW - (i + 1) * HOUR });
  const few = paceFor(agent, NOW)!;
  assert.ok(few.runsPerDay < 10, `${Math.round(few.runsPerDay)} runs a day`);
  assert.equal(few.level, 1);
  // The same poor yield kept up over 20 runs is its own answer: its runs make 1, so 50 a day.
  for (let i = 3; i < 20; i++) ran(i % 3 === 0 ? 1 : 0, { at: NOW - (i + 1) * HOUR });
  const many = paceFor(agent, NOW)!;
  assert.equal(many.perRun, 1);
  assert.ok(many.runsPerDay >= 50, `${Math.round(many.runsPerDay)} runs a day`);
});

test('the word for its pace is how far it is from its goal, not how many runs the goal takes', () => {
  setGoal('outreach', 'Emails sent', 9000, 'day', NOW);
  did('gmail.send_email', 8950);
  const holding = paceFor(agent, NOW)!;
  // Holding 9,000 a day takes hundreds of runs: its card glows, and it is on pace.
  assert.equal(holding.level, 4);
  assert.equal(holding.status, 'on pace');
  assert.match(goalInstructions(agent, goalsOf(agent, NOW), holding), /You are on pace/);
  // Half way there, the same goal is all out, and the agent is told to move.
  exec('DELETE FROM actions');
  did('gmail.send_email', 4500);
  const short = paceFor(agent, NOW)!;
  assert.equal(short.status, 'all out');
  assert.match(goalInstructions(agent, goalsOf(agent, NOW), short), /Your goal takes a lot of runs/);
});
