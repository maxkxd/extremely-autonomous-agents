import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULT_PLAN, type AgentDef } from './agent.js';
import { setHostZone } from './clock.js';
import { resetDbForTests, run as exec } from './db.js';
import { APOCALYPTIC, RELENTLESS, STEADY } from './ferocity.js';
import { bookGoalRuns, goalDue, goalFloor, goalInstructions, goalsOf, MAX_GOAL_PARALLEL, paceFor, setGoal, storePace } from './goals.js';

// Goals (goals.ts): what counts toward one, and the pace it calls for.

const NOW = Date.UTC(2026, 9, 20, 12); // 20 October 2026, noon UTC: half the day left
const MIN = 60_000;
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
const emails = () => goalsOf(agent, NOW).find(g => g.label === 'Emails sent')!;

beforeEach(() => {
  resetDbForTests();
  setHostZone('UTC');
});

test('an agent with no goal has no pace of its own', () => {
  assert.equal(paceFor(agent, NOW), null);
  assert.deepEqual(goalsOf(agent, NOW).map(g => [g.label, g.perDay]), [['Emails sent', 0], ['Leads researched', 0]]);
});

test("a builder's per_day on a KPI row is the goal until someone sets one", () => {
  const built = { ...agent, output: [{ action: 'gmail.send_email', label: 'Emails sent', per_day: 50 }] } as AgentDef;
  assert.equal(goalsOf(built, NOW)[0].perDay, 50);
  setGoal('outreach', 'Emails sent', 80, NOW);
  assert.equal(goalsOf(built, NOW)[0].perDay, 80);
});

test('a draft counts as soon as it is queued, and comes off if a person rejects it', () => {
  setGoal('outreach', 'Emails sent', 100, NOW);
  did('gmail.send_email', 3);
  approval('a1', 'pending');
  did('gmail.send_email', 1, 'queued', 'a1');
  approval('a2', 'rejected');
  did('gmail.send_email', 1, 'queued', 'a2');
  did('gmail.send_email', 5, 'ok', null, NOW - 30 * 3_600_000); // yesterday
  did('gmail.send_email', 0, 'failed');
  did('crm.create_record', 7); // another goal's work
  const g = emails();
  assert.equal(g.done, 4);
  assert.equal(g.waiting, 1);
});

test('at its goal it eases off to its ordinary schedule, and drops back under if drafts are rejected', () => {
  setGoal('outreach', 'Emails sent', 2, NOW);
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
  setGoal('outreach', 'Emails sent', 100, NOW);
  ran(10);
  const p = paceFor(agent, NOW)!;
  assert.equal(p.parallel, 1);
  assert.equal(p.perRun, 12);
  // 10 runs in the 10.8 hours it aims to finish in.
  assert.ok(p.everyMs > 60 * MIN && p.everyMs < 70 * MIN, `every ${p.everyMs / MIN} min`);
  assert.equal(p.status, 'speeding up');
});

test('a goal it cannot reach one run after another gets runs side by side, up to the most allowed', () => {
  setGoal('outreach', 'Emails sent', 2000, NOW);
  ran(10);
  const p = paceFor(agent, NOW)!;
  // 200 runs of 10 min 20 s in 10.8 hours: 62 fit one after another, so 4 lanes.
  assert.equal(p.parallel, 4);
  assert.equal(p.level, RELENTLESS);
  setGoal('outreach', 'Emails sent', 90_000, NOW);
  const all = paceFor(agent, NOW)!;
  assert.equal(all.parallel, MAX_GOAL_PARALLEL);
  assert.equal(all.level, APOCALYPTIC);
  assert.equal(all.status, 'all out');
});

test('runs that make nothing are not multiplied', () => {
  setGoal('outreach', 'Emails sent', 9000, NOW);
  for (let i = 0; i < 5; i++) ran(0);
  const p = paceFor(agent, NOW)!;
  assert.equal(p.status, 'stuck');
  assert.equal(p.parallel, 1);
  assert.equal(p.level, STEADY);
});

test("the Conductor's numbers are kept in bounds, and only for the goal they were set for", () => {
  setGoal('outreach', 'Emails sent', 100, NOW);
  ran(10);
  const sig = 'Emails sent=100|Leads researched=0';
  storePace('outreach', sig, { parallel: 500, per_run: 40, every_min: 5, note: 'Use the new lead list first.' }, NOW);
  const p = paceFor(agent, NOW)!;
  assert.equal(p.parallel, MAX_GOAL_PARALLEL);
  assert.equal(p.perRun, 40);
  assert.equal(p.everyMs, 5 * MIN);
  assert.equal(p.note, 'Use the new lead list first.');
  assert.equal(paceFor(agent, NOW + 46 * MIN)!.parallel, 1, 'after a while the worked-out pace stands again');
  setGoal('outreach', 'Emails sent', 120, NOW);
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
  setGoal('outreach', 'Emails sent', 2000, NOW);
  ran(10);
  const p = paceFor(agent, NOW)!;
  assert.equal(bookGoalRuns(agent, p, NOW), 3);
  assert.equal(bookGoalRuns(agent, p, NOW), 0);
});

test('the agent is told its goal, how far it is and what this run owes', () => {
  setGoal('outreach', 'Emails sent', 100, NOW);
  ran(10);
  did('gmail.send_email', 70);
  const goals = goalsOf(agent, NOW);
  const text = goalInstructions(agent, goals, paceFor(agent, NOW, goals)!);
  assert.match(text, /Emails sent: 70 of 100/);
  assert.match(text, /You run many times a day/);
  assert.match(text, /This run: at least 12/);
  assert.doesNotMatch(text, /Leads researched/, 'a label with no number is not a goal');
});
