import type { AgentDef } from './agent.js';
import { PERIOD_MS, PERIODS, rollingSince, startOfDay, type Period } from './clock.js';
import { all, one, run as exec } from './db.js';
import { DRIVEN, HOUR, MAX_NUDGES, RELENTLESS, STEADY, stanceLines } from './ferocity.js';

// Goals (docs/runner.md, "Goals"): an agent's output, in plain words and a number for a
// period - "Emails sent: 100 a day", "Posts published: 5 a week". A goal is one of its KPI
// labels (KPI.yaml `output`), so what counts toward it is exactly the actions under that
// label. Nobody sets how hard the agent works: the pace is worked out from how far it is
// from its goals - how often it runs, how many runs of it go at once, and what each run is
// asked for. A goal of N a day is a steady rate of N over the last (and next) 24 hours, not
// a race to midnight: the rate does not change with how far behind it is. At its goal it
// eases off to its ordinary schedule (it is never stopped for reaching it).
// How that is worked out, and why each piece is as it is: paceFor below, and the simulator
// that holds it to its goals over days (goals-sim.test.ts).
//
// Every agent has a goal: one with none does not run until it is given one (scheduler.ts),
// so nothing here may leave an agent without a number (checkGoal).
//
// What counts: an action as soon as it is done or drafted (queued for a person's approval),
// and a draft a person rejects, withdraws or lets expire is taken off again - so an agent
// at its goal can drop under it.

export type Goal = { label: string; actions: string[]; amount: number; period: Period; done: number; waiting: number };

// The levers, as the scheduler and the run use them.
export type Pace = {
  everyMs: number; // its ordinary schedule: a run of its own at least this often, due or not
  gapMs: number; // from one run toward its goals to the next, all its lanes together
  nextAt: number | null; // when the next run toward its goals may start (null: nothing is short)
  parallel: number; // runs of it at once, its main run included
  perRun: number; // what a run starting now is asked for (0: nothing is due)
  runsPerDay: number; // about how many runs a day holding its goals comes to
  level: number; // 0-4, from runsPerDay: its card's effects and the tone of what it is told
  status: 'on pace' | 'speeding up' | 'pushing hard' | 'all out' | 'goal hit' | 'stuck';
  remaining: number;
  note: string | null; // the Agency Conductor's word to it
  other?: boolean; // this run is for something else (a person's message, a task, a decision), not its goal
};

export const MAX_GOAL_PARALLEL = 20;
export const MAX_AMOUNT = 1_000_000;
const DAY = 24 * HOUR;
const GAP_MS = 20_000; // a breath between back-to-back runs
const OWN_WORK = "('scheduled', 'apocalyptic', 'self-booked', 'request done', 'run now', 'parallel')";
// The Conductor's numbers hold this long; then the worked-out pace again until it next looks.
export const CONDUCTOR_HOLDS_MS = 45 * 60_000;
// The most runs a day the Conductor may give an agent, as a multiple of the worked-out pace.
const CONDUCTOR_MAX = 2;
// This many of its own runs in a row with nothing counted: more runs won't help.
const STUCK_RUNS = 5;
// The least and most of what a run is asked for that it is taken to make: a poor patch
// gets it at most five times its planned runs, never a hundred.
const MIN_SHARE = 1 / STUCK_RUNS;
const MAX_SHARE = 50;
// How many of its latest runs toward its goals what a run makes is worked out from.
const RECENT_RUNS = 20;
// Until it has a history, its runs are taken to make what they are asked for, weighted as
// this many runs (shareOf).
const PLAN_RUNS = 5;
// Within a tenth of every goal (or one short of a small one): it is on pace, however many
// runs a day holding that goal takes.
const NEAR = 0.1;

const count = (n: number) => n.toLocaleString('en-US');
// "70 of 100 in the last 24 hours", and "100 a day".
const NOW_WORDS: Record<Period, string> = {
  hour: 'in the last hour',
  day: 'in the last 24 hours',
  week: 'in the last 7 days',
  month: 'in the last 30 days',
  year: 'in the last 365 days',
};
const EACH_WORDS: Record<Period, string> = { hour: 'an hour', day: 'a day', week: 'a week', month: 'a month', year: 'a year' };
export const periodNow = (p: Period) => NOW_WORDS[p];
export const periodEach = (p: Period) => EACH_WORDS[p];
export const isPeriod = (v: unknown): v is Period => (PERIODS as readonly string[]).includes(String(v));
const whole = (v: unknown) => Math.max(0, Math.min(MAX_AMOUNT, Math.floor(Number(v) || 0)));

// --- The goals themselves -------------------------------------------------------

export function setGoal(agentId: string, label: string, amount: number, period: Period, now = Date.now()) {
  exec(
    'INSERT INTO agent_goals (agent_id, label, per_day, period, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (agent_id, label) DO UPDATE SET per_day = excluded.per_day, period = excluded.period, updated_at = excluded.updated_at',
    agentId,
    label,
    whole(amount),
    isPeriod(period) ? period : 'day',
    now,
  );
  // The Conductor's numbers were for the old goal.
  exec('DELETE FROM agent_pace WHERE agent_id = ?', agentId);
}

// Done or drafted since then under these actions, less what a person rejected; and how
// many of them still wait for a person.
function countSince(agentId: string, actions: string[], since: number): { done: number; waiting: number } {
  if (!actions.length) return { done: 0, waiting: 0 };
  const marks = actions.map(() => '?').join(', ');
  const row = one<{ done: number | null; waiting: number | null }>(
    `SELECT SUM(CASE WHEN p.status IN ('rejected', 'withdrawn', 'expired') THEN 0 ELSE a.output END) AS done,
            SUM(CASE WHEN p.status = 'pending' THEN a.output ELSE 0 END) AS waiting
       FROM actions a LEFT JOIN approvals p ON p.id = a.approval_id
      WHERE a.agent_id = ? AND a.at >= ? AND a.outcome IN ('ok', 'queued') AND a.tool IN (${marks})`,
    agentId,
    since,
    ...actions,
  );
  return { done: row?.done ?? 0, waiting: row?.waiting ?? 0 };
}

// A KPI row as its file has it: `amount` and `period`, or `per_day` from before periods.
type OutputRow = AgentDef['output'][number];

// Each label's number and period (in the KPI's order): from its card once anyone set
// it; before that, the builder's on that KPI row.
export function goalNumbers(agentId: string, output: OutputRow[]): Map<string, { actions: string[]; amount: number; period: Period }> {
  const set = new Map(all<{ label: string; per_day: number; period: string }>('SELECT label, per_day, period FROM agent_goals WHERE agent_id = ?', agentId).map(r => [r.label, r] as const));
  const byLabel = new Map<string, { actions: string[]; amount: number; period: Period }>();
  for (const o of output) {
    const g = byLabel.get(o.label) ?? { actions: [], amount: 0, period: 'day' as Period };
    g.actions.push(o.action);
    const seed = whole(o.amount ?? o.per_day);
    if (seed > g.amount) {
      g.amount = seed;
      g.period = isPeriod(o.period) ? o.period : 'day';
    }
    byLabel.set(o.label, g);
  }
  for (const [label, g] of byLabel) {
    const s = set.get(label);
    if (s) byLabel.set(label, { actions: g.actions, amount: s.per_day, period: isPeriod(s.period) ? s.period : 'day' });
  }
  return byLabel;
}
// Whether it has a goal at all: a label with a number.
export const hasGoal = (agentId: string, output: OutputRow[]) => [...goalNumbers(agentId, output).values()].some(g => g.amount > 0);

// Every goal it could have (one per KPI label), with the count in its trailing window.
export function goalsOf(agent: AgentDef, now = Date.now()): Goal[] {
  return [...goalNumbers(agent.id, agent.output)].map(([label, g]) => ({ label, ...g, ...countSince(agent.id, g.actions, rollingSince(g.period, now)) }));
}

// A number someone wants on a goal, checked before it is set: a whole number, a real
// period, and never the change that would leave the agent with no goal at all.
// No period given: the one that goal has now.
export function checkGoal(agent: AgentDef, label: string, amount: unknown, period?: unknown, now = Date.now()): { amount: number; period: Period } {
  const n = typeof amount === 'number' || (typeof amount === 'string' && amount.trim()) ? Math.floor(Number(amount)) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) throw new Error(`A goal's amount is a whole number from 1 to ${count(MAX_AMOUNT)}.`);
  if (period != null && period !== '' && !isPeriod(period)) throw new Error(`A goal's period is one of: ${PERIODS.join(', ')}.`);
  const goals = goalsOf(agent, now);
  if (n < 1 && !goals.some(g => g.label !== label && g.amount > 0))
    throw new Error(`Every agent needs a goal, and ${agent.name} would be left with none: "${label}" needs a number of 1 or more, unless another of its goals has one first. An agent with no goal does not run.`);
  return { amount: n, period: isPeriod(period) ? period : (goals.find(g => g.label === label)?.period ?? 'day') };
}

// --- The pace ---------------------------------------------------------------------

// Its latest runs that were asked for something toward its goals (their `floor`), and what
// they made. Only those: a run on its ordinary schedule while its goal was already reached
// was asked for nothing and made nothing, as it was told to - five of those used to read
// as "stuck", and it then never worked toward its goal again.
// Counted on the tools of its live goals only - never browser clicks, workspace files, or
// other tools that are not those outputs.
// A draft that expired before a person decided still counts here: the run made it, and
// a person not getting to it is no reason to give the agent more runs (which only queued
// more to expire). It still comes off its goal's count (countSince). A rejected or
// withdrawn one doesn't count: that work was no good.
type Recent = {
  runs: number; // how many of them (the ones that ended well)
  made: number; // what they made between them
  asked: number; // what they were asked for between them
  best: number; // the most one of them made
  mostAsked: number; // the most one of them was asked for
  ms: number; // how long one takes
  empty: number; // its latest in a row, since its goal was last set, that made nothing
  owed: number; // what its poor runs' breathers have cost its goals and its later runs have not yet paid back
  last: { at: number; asked: number; made: number; bought: number; failed: boolean; running: boolean } | null; // the latest, however it ended
};
function recent(agentId: string, tools: string[], since: number, hourly = Infinity): Recent {
  const rows = all<{ id: string; floor: number; at: number; ms: number | null }>(
    `SELECT id, floor, started_at AS at, ended_at - started_at AS ms FROM runs WHERE agent_id = ? AND status = 'succeeded' AND ended_at IS NOT NULL AND floor IS NOT NULL AND trigger IN ${OWN_WORK} ORDER BY started_at DESC LIMIT ${RECENT_RUNS}`,
    agentId,
  );
  const latest = one<{ id: string; floor: number; at: number; status: string }>(
    `SELECT id, floor, started_at AS at, status FROM runs WHERE agent_id = ? AND floor IS NOT NULL AND trigger IN ${OWN_WORK} ORDER BY started_at DESC LIMIT 1`,
    agentId,
  );
  const ids = [...new Set([...rows.map(r => r.id), ...(latest ? [latest.id] : [])])];
  const byRun = new Map<string, number>();
  if (tools.length && ids.length)
    for (const s of all<{ run_id: string; n: number | null }>(
      `SELECT a.run_id, SUM(CASE WHEN p.status IN ('rejected', 'withdrawn') THEN 0 ELSE a.output END) AS n
         FROM actions a LEFT JOIN approvals p ON p.id = a.approval_id
        WHERE a.agent_id = ? AND a.run_id IN (${ids.map(() => '?').join(', ')}) AND (a.outcome IN ('ok', 'queued') OR p.status = 'expired') AND a.tool IN (${tools.map(() => '?').join(', ')})
        GROUP BY a.run_id`,
      agentId,
      ...ids,
      ...tools,
    ))
      byRun.set(s.run_id, s.n ?? 0);
  const made = rows.map(r => byRun.get(r.id) ?? 0);
  const fresh = rows.filter(r => r.at >= since).map(r => byRun.get(r.id) ?? 0);
  const first = fresh.findIndex(n => n > 0);
  // Oldest first: what each bought (paceFor), and what is still owed after it.
  let owed = 0;
  let bought = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const floor = rows[i].floor || 1; // asked for 0: it could count nothing (run.ts)
    const earned = Math.min(made[i], floor);
    bought = Math.max(Math.min(MIN_SHARE * floor, hourly), earned - owed);
    owed = Math.max(0, owed + bought - earned);
  }
  return {
    runs: rows.length,
    made: made.reduce((s, n) => s + n, 0),
    asked: rows.reduce((s, r) => s + r.floor, 0),
    best: Math.max(0, ...made),
    mostAsked: Math.max(0, ...rows.map(r => r.floor)),
    ms: rows.length ? Math.max(30_000, rows.reduce((s, r) => s + (r.ms ?? 0), 0) / rows.length) : 10 * 60_000,
    empty: first === -1 ? fresh.length : first,
    owed,
    last: latest ? { at: latest.at, asked: latest.floor, made: byRun.get(latest.id) ?? 0, bought: rows[0]?.id === latest.id ? bought : 0, failed: latest.status === 'failed', running: latest.status === 'running' } : null,
  };
}

// The effect level comes from how many runs a day holding its goals takes: nobody picks it,
// and it moves the moment a goal's number does (the Conductor's changes included). It does
// not drop while the goal is reached for a moment - an agent holding 1,000 a day is at its
// goal every few minutes, and its card flickered between calm and red.
export const levelOf = (runsPerDay: number) => (runsPerDay <= 2 ? 0 : runsPerDay <= 12 ? 1 : runsPerDay <= 48 ? 2 : runsPerDay <= 200 ? 3 : 4);
const STATUS = ['on pace', 'on pace', 'speeding up', 'pushing hard', 'all out'] as const;
// The same, with some give at each boundary: an agent whose runs a day sit right on one
// (200 a day, give or take what its last few runs made) keeps the level it had, instead of
// its card changing colour several times a day. was: the level of its latest run.
const GIVE = 1.15;
function levelFrom(runsPerDay: number, was: number | null): number {
  const level = levelOf(runsPerDay);
  if (was == null || level === was) return level;
  return level > was ? Math.max(was, levelOf(runsPerDay / GIVE)) : Math.min(was, levelOf(runsPerDay * GIVE));
}

// What one run toward its goals is asked for: what its plan says a good run makes (its
// floor) - or, when its ordinary schedule alone would cover the goal, that schedule's share
// of it (5 a day on an hourly schedule is 1 a run, five times a day, not 5 at once).
// It is a fixed point, not an average of what its runs made: asked for a little more than
// its average each time, an agent that did as asked was asked for more and more (1,000 a
// day became three runs of hundreds), and one that fell a little short was asked for less
// and less (down to runs of 4, hundreds a day, "all out"). It only comes down on evidence -
// its runs were asked for more than any of them made - and goes back up when that evidence
// has aged out, so it tries its plan's number again now and then.
function askOf(agent: AgentDef, r: Recent, unitsPerMs: number, steadyMs: number): number {
  const plan = Math.max(1, Math.round(agent.ferocity.floor));
  const can = r.runs >= STUCK_RUNS && r.best > 0 && r.best < plan && r.mostAsked > r.best ? r.best : plan;
  return Math.min(can, Math.max(1, Math.floor(unitsPerMs * steadyMs)));
}

// How much of what a run is asked for it makes: all its recent asked runs made, over all
// they were asked for (the ones that made nothing included). A share, not a count: a run
// asked for the last 2 before its goal that made 2 did all of its job, and used to read
// as "a run only makes 2". Until it has a history it leans on doing as asked (a share of
// 1), weighted as PLAN_RUNS runs: one or two empty runs at the start must not read as "its
// runs make nothing" and send it all out. With RECENT_RUNS runs behind it, it is its own.
function shareOf(r: Recent, ask: number): number {
  const weight = PLAN_RUNS * Math.max(0, 1 - r.runs / RECENT_RUNS) * ask;
  const of = r.asked + weight;
  return of > 0 ? Math.max(MIN_SHARE, Math.min(MAX_SHARE, (r.made + weight) / of)) : 1;
}

type Stored = { every_ms: number | null; parallel: number | null; per_run: number | null; note: string | null; sig: string; updated_at: number };
const sigOf = (goals: Goal[]) => goals.map(g => `${g.label}=${g.amount}/${g.period}`).join('|');

// The pace its goals call for right now; null when it has no goal (it does not run).
// asked: a person asked for this run (Run now), so it works toward the goal whether or
// not a run toward it is due.
export function paceFor(agent: AgentDef, now = Date.now(), goals = goalsOf(agent, now), asked = false): Pace | null {
  const live = goals.filter(g => g.amount > 0);
  if (!live.length) return null;
  const steadyMs = agent.ferocity.every_hours[0] * HOUR;
  const remaining = live.reduce((s, g) => s + Math.max(0, g.amount - g.done), 0);
  const stored = one<Stored>('SELECT * FROM agent_pace WHERE agent_id = ?', agent.id);
  const held = stored && stored.sig === sigOf(goals) && now - stored.updated_at < CONDUCTOR_HOLDS_MS ? stored : null;
  const note = held?.note?.trim() || null;
  // Holding its goals is a steady rate: each one's amount over its window (100 a day is
  // 100 / 24 hours, not "whatever is left before midnight"), added together whatever mix of
  // hours, days and weeks they are in.
  const unitsPerMs = live.reduce((s, g) => s + g.amount / PERIOD_MS[g.period], 0);
  // When each goal was last set, and the latest of them. A goal just changed gets a fresh
  // try: runs from before it don't count toward "stuck".
  const setOf = new Map(all<{ label: string; t: number }>('SELECT label, updated_at AS t FROM agent_goals WHERE agent_id = ?', agent.id).map(x => [x.label, x.t] as const));
  const setAt = Math.max(0, ...setOf.values());
  const r = recent(agent.id, [...new Set(live.flatMap(g => g.actions))], setAt, HOUR * unitsPerMs);
  // Runs that make nothing don't get more of them: one at a time, never more often than its
  // ordinary schedule, and further apart with each further empty run (an hour, then 2, 4, 8,
  // 16, then a day) until one makes something. Each is still asked for one, gently: a run
  // asked for nothing would make nothing, and it would never leave "stuck".
  if (remaining > 0 && r.empty >= STUCK_RUNS) {
    const everyMs = Math.max(steadyMs, Math.min(DAY, HOUR * 2 ** (r.empty - STUCK_RUNS)));
    const runsPerDay = DAY / everyMs;
    return { everyMs, gapMs: everyMs, nextAt: null, parallel: 1, perRun: 1, runsPerDay, level: levelOf(runsPerDay), status: 'stuck', remaining, note };
  }
  let ask = askOf(agent, r, unitsPerMs, steadyMs);
  // The Agency Conductor's call, kept inside what makes sense. What a run is asked for is
  // its to change: fewer runs each asked for more (or the other way) still come to the same
  // goal, because the time between them follows what each is asked for.
  if (held?.per_run) ask = Math.max(1, Math.min(MAX_AMOUNT, Math.floor(held.per_run)));
  const share = shareOf(r, ask);
  // What a run asked for that is taken to make: its share of it - of what its runs have
  // been asked for, when that was more (runs asked for 10 that made 2 are taken to make 2
  // when asked for 2, not a fifth of 2).
  const usual = r.runs ? Math.max(ask, r.asked / r.runs) : ask;
  const each = Math.min(share * usual, ask * Math.max(1, share));
  // From one run toward its goals to the next, whichever lane it runs in.
  const worked = each / unitsPerMs;
  // The Conductor may slow an agent down as far as it likes, but never run it more than
  // CONDUCTOR_MAX times what the arithmetic says (it once read a stale "a tenth of a pitch a
  // run" and set 2 at once every 12 minutes, about 240 runs a day for a goal of 50).
  const gapMs = held?.every_ms ? Math.max(GAP_MS, worked / CONDUCTOR_MAX, held.every_ms / Math.max(1, Math.floor(held.parallel ?? 1))) : worked;
  // One run after another keeps up with one lane's worth; more than that goes side by side.
  // Lanes are only room: however many there are, runs start a gap apart.
  const lane = r.ms + GAP_MS;
  const parallel = Math.max(1, Math.min(MAX_GOAL_PARALLEL, Math.max(Math.ceil(lane / gapMs), Math.floor(held?.parallel ?? 1))));
  // Never slower than its ordinary schedule; and no more runs than its lanes can hold.
  const runsPerDay = Math.max(DAY / steadyMs, Math.min(DAY / gapMs, (parallel * DAY) / lane));
  const level = levelFrom(runsPerDay, one<{ ferocity: number }>('SELECT ferocity FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1', agent.id)?.ferocity ?? null);
  // What a run starting now is asked for: what will be short of its goals by the time it
  // has earned its next run - what is short now, and what leaves its windows until then.
  // So work about to drop out of the count is replaced as it goes, not after the count has
  // dipped (5 a day, made in one run, all left the window together: the count sat at 0
  // until the next run was done); and a run is not asked for a fraction of a batch that is
  // only halfway out of the window (runs of 10 broke up into runs of 8, 2, 7, 3...).
  // The longer it looks ahead the more it is asked for, and the more it is asked for the
  // longer until its next run: the smallest number that agrees with itself, from what will
  // be short while this run works, up to a full run's worth.
  //
  // A goal lowered below what its window already held (500 a day made, then set to 50):
  // that older work counts here only as far as a window would still hold of it at the new
  // rate. Otherwise it made nothing for a day while the 500 left the window, and then spent
  // another day starting again from an empty one - now it makes 50 a day from the moment
  // it is lowered. (Its card still shows the real count.)
  const shortOf = (g: Goal, at: number) => {
    const period = PERIOD_MS[g.period];
    const set = setOf.get(g.label) ?? 0;
    const all = countSince(agent.id, g.actions, at - period).done;
    if (set <= at - period || set >= at || all <= g.amount) return Math.max(0, g.amount - all);
    const since = countSince(agent.id, g.actions, set).done;
    const before = countSince(agent.id, g.actions, set - period).done - since;
    if (before <= g.amount * (1 + NEAR)) return Math.max(0, g.amount - all);
    return Math.max(0, g.amount - since - Math.min(all - since, g.amount * (1 - (at - set) / period)));
  };
  const shortBy = (ms: number) => Math.ceil(live.reduce((s, g) => s + shortOf(g, now + Math.min(ms, PERIOD_MS[g.period])), 0) - 1e-9);
  const stretch = gapMs / worked; // the Conductor's slower pace, if it set one
  let short = Math.min(ask, shortBy(r.ms));
  for (let i = 0; short > 0 && short < ask && i < 6; i++) {
    const more = Math.min(ask, shortBy(Math.max(r.ms, (short / unitsPerMs) * stretch)));
    if (more <= short) break;
    short = more;
  }
  // When its next run toward them may start: its last one bought the time that what it
  // made is worth, at the goal's rate - so the work comes at that rate whatever each run
  // makes, without waiting for an average to catch up. Never more than it was asked for (a
  // run that made 8 when asked for 1 does not buy a week: if the count allows, the next
  // comes as planned). One that made little or nothing still buys a breather - MIN_SHARE of
  // what it was asked for, an hour at most - so poor runs come at most five times as often;
  // what that breather cost the goal is owed (r.owed), and the next runs that do make
  // something pay it back by coming sooner. One still going is taken to make its share. One
  // that failed bought only what it had made, so a failure costs the goal nothing (its
  // retries are spaced by the failure backoff, scheduler.ts).
  const was = r.last ? r.last.asked || ask : 0;
  const least = Math.min(MIN_SHARE * was, HOUR * unitsPerMs);
  const bought = !r.last ? 0 : r.last.failed ? Math.min(r.last.made, was) : r.last.running ? Math.max(least, Math.min(1, share) * was - r.owed) : r.last.bought;
  // A run for a little (its last one fell a little short) is not worth its overhead: it
  // waits until enough is short - a full run's worth, half of one, or a tenth of the goal -
  // or until the time its last run was asked to cover has passed.
  const worth = Math.min(ask, Math.ceil(ask / 2), Math.max(1, Math.floor(live.reduce((s, g) => s + g.amount, 0) * NEAR)));
  // No faster for being behind (after an outage, or while a new goal fills): measured, a
  // faster patch bunches work in the window, and the bunch leaves it together a period
  // later - the count then swings between 80% and 115% for good, where a steady rate holds
  // 100% flat (goals-sim.test.ts).
  const paid = ((short >= worth ? bought : was) / unitsPerMs) * stretch;
  const nextAt = short > 0 ? (r.last ? r.last.at + paid : 0) : null;
  const perRun = short > 0 && (asked || nextAt! <= now) ? short : 0;
  // The word for it is how far it is from its goals, not how many runs they take: an agent
  // holding 9,000 a day runs all day and is still on pace.
  const near = live.every(g => g.amount - g.done <= Math.max(1, g.amount * NEAR));
  return { everyMs: steadyMs, gapMs, nextAt, parallel, perRun, runsPerDay, level, status: remaining <= 0 ? 'goal hit' : near ? 'on pace' : STATUS[level], remaining, note };
}

// What a run of its own work is held to. A stuck one is asked for one, gently.
export function goalFloor(pace: Pace | null): { floor: number; nudges: number; soft: boolean } | null {
  if (!pace || pace.perRun <= 0) return null;
  return pace.status === 'stuck' ? { floor: pace.perRun, nudges: 1, soft: true } : { floor: pace.perRun, nudges: MAX_NUDGES, soft: false };
}

// Whether a run of its own is due (after its last one has ended and had a breath): one
// toward its goals, or its ordinary schedule's.
// lanes: its goal runs go side by side, so one that is due while its main run is still
// going is another lane's (bookGoalRuns), not a second main run waiting behind this one.
export function goalDue(pace: Pace, lastStartedAt: number | null, lastEndedAt: number | null, now: number, lanes = false): boolean {
  if (lastEndedAt && now - lastEndedAt < GAP_MS) return false;
  if (lastStartedAt == null || lastStartedAt + pace.everyMs <= now) return true;
  return !lanes && pace.nextAt != null && pace.nextAt <= now;
}

// More than one run at once: the scheduler starts the others itself, each told to take a
// different slice. One is booked when a run toward its goals is due and its main run is
// busy - so the lanes together start runs a gap apart, as one lane would. They used to be
// kept full: every lane but the main one ran back to back, about half as many runs again
// as the goal called for.
export const GOAL_BATCH = 'Goal batch';
export function bookGoalRuns(agent: AgentDef, pace: Pace, now: number): number {
  const extra = pace.parallel - 1;
  const waiting = all<{ id: number }>("SELECT id FROM bookings WHERE agent_id = ? AND trigger = 'parallel' AND task LIKE ? ORDER BY id", agent.id, `${GOAL_BATCH}%`);
  const due = extra >= 1 && pace.nextAt != null && pace.nextAt <= now;
  // Never a backlog: one waiting at most, and none once nothing is due.
  const keep = due ? 1 : 0;
  if (waiting.length > keep)
    exec(`DELETE FROM bookings WHERE id IN (${waiting.slice(keep).map(() => '?').join(',')})`, ...waiting.slice(keep).map(b => b.id));
  if (!due || waiting.length) return 0;
  const going = all<{ parallel: number }>("SELECT trigger = 'parallel' AS parallel FROM runs WHERE agent_id = ? AND status = 'running'", agent.id);
  const beside = going.filter(g => g.parallel).length;
  // Its main run is free: this one is its (scheduler.ts nextRun).
  if (going.length === beside || beside >= extra) return 0;
  exec(
    "INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, 'parallel', ?, ?, ?)",
    agent.id,
    `${GOAL_BATCH}: work toward your goal. Other runs of you are doing the same right now (up to ${pace.parallel} at once), so take a different slice of the work (other leads, accounts, records or topics) - look at what is already done, queued or logged first, and never do a piece twice.`,
    now,
    now,
  );
  return 1;
}
export const isGoalBatch = (task: string | null) => !!task && task.startsWith(GOAL_BATCH);

// --- What the agent is told ---------------------------------------------------------

export function goalInstructions(agent: AgentDef, goals: Goal[], pace: Pace): string {
  const live = goals.filter(g => g.amount > 0);
  const lines = [
    '## Your goal',
    live.map(g => `- ${g.label}: ${count(g.done)} of ${count(g.amount)} ${NOW_WORDS[g.period]}${g.waiting ? ` (${count(g.waiting)} of those wait for a person's approval)` : ''}`).join('\n'),
    "Only the work named there moves your goal; anything else doesn't. Something counts as soon as you do it or queue it for approval, and comes off again if a person rejects it. The count is of a moving window: older work drops out of it as time passes, so a goal is held by a steady rate, not reached once.",
  ];
  const hit = pace.status === 'goal hit';
  if (pace.other) lines.push('This run is for what you were just asked or told, not for your goal: do that fully. Nothing toward your goal is owed in it.');
  else if (pace.status === 'stuck')
    lines.push(
      'Your last runs made nothing toward it. More of the same will not help: find out what is in the way (a tool, a limit, nothing left to work on), fix what you can, and file a request for what you cannot. If the way is clear, make one this run to show it.',
    );
  else if (pace.perRun > 0)
    lines.push(
      `You run many times${pace.parallel > 1 ? `, and up to ${pace.parallel} runs of you work at once` : ''}, so the whole goal is not this run's job. This run: ${count(pace.perRun)} toward it. Keep going until you reach that, then leave the rest to your next runs: your goal is held by an even flow of work, not a burst.`,
      hit
        ? 'You are at your goal, and that many are about to drop out of the count: this run keeps you there.'
        : pace.status === 'on pace'
          ? 'You are on pace.'
          : pace.level >= RELENTLESS
            ? 'Your goal takes a lot of runs. Volume of finished work matters more than token efficiency: move fast, and waste nothing on what does not count.'
            : pace.level === DRIVEN
              ? 'You are short of your goal: move a little faster than usual.'
              : 'You are short of your goal: keep a steady pace.',
    );
  else
    lines.push(
      hit
        ? "Your goal is reached for now, so nothing toward it is owed this run. Don't add to it now: more would only run past the number you were given. Use this run for the rest of your job (replies, follow-ups, checking results, getting the next batch ready) and stop when that is done. You aren't stopped: your next run toward it comes when older work drops out of the count."
        : "You are on pace: your next batch toward it is not due yet, so nothing toward it is owed this run. Use this run for the rest of your job (replies, follow-ups, checking results, getting the next batch ready) and stop when that is done.",
    );
  if (pace.note) lines.push(`From the Agency Conductor, who keeps every agent on its goal: ${pace.note}`);
  lines.push('Never make work to fill the number: if a limit in your instructions is reached, or there is genuinely nothing real left to do, stop and say so.');
  lines.push(...stanceLines(agent, pace.perRun > 0 && pace.status !== 'stuck' ? pace.level : STEADY, pace.parallel > 1 && pace.perRun > 0));
  return lines.filter(Boolean).join('\n\n');
}

// An agent with no goal runs only to answer a person (scheduler.ts): what that run is told.
export function noGoalInstructions(): string {
  return [
    '## You have no goal yet',
    'Every agent works toward a goal: a number of one of its outputs an hour, a day, a week, a month or a year. You have none, so you are not running by yourself, and the Agency Engineer has been asked to set one. Answer what you were asked now, and start no other work of your own in this run.',
    'When a person tells you the number they want ("20 leads a day"), set it yourself with ops.set_my_goal and say what you set. You start running once it is set.',
  ].join('\n\n');
}

// --- The Agency Conductor's numbers (conductor.ts) -----------------------------------

export function storePace(agentId: string, sig: string, p: { every_min?: number; parallel?: number; per_run?: number; note?: string }, now: number) {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  exec(
    'INSERT INTO agent_pace (agent_id, every_ms, parallel, per_run, note, sig, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET every_ms = excluded.every_ms, parallel = excluded.parallel, per_run = excluded.per_run, note = excluded.note, sig = excluded.sig, updated_at = excluded.updated_at',
    agentId,
    num(p.every_min) ? num(p.every_min)! * 60_000 : null,
    num(p.parallel),
    num(p.per_run),
    typeof p.note === 'string' ? p.note.trim().slice(0, 400) || null : null,
    sig,
    now,
  );
}

// One agent's line for the Conductor: its goals, what its runs make, the pace worked out for it.
export function paceFacts(agent: AgentDef, now: number): { sig: string; line: string } | null {
  const goals = goalsOf(agent, now);
  const pace = paceFor(agent, now, goals);
  if (!pace || pace.status === 'goal hit') return null;
  const setAt = one<{ t: number | null }>('SELECT MAX(updated_at) AS t FROM agent_goals WHERE agent_id = ?', agent.id)?.t ?? 0;
  const r = recent(agent.id, [...new Set(goals.filter(g => g.amount > 0).flatMap(g => g.actions))], setAt);
  const runsToday = one<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND started_at >= ?', agent.id, startOfDay(now))?.n ?? 0;
  const said = goals.filter(g => g.amount > 0).map(g => `${g.label} ${g.done}/${g.amount} ${NOW_WORDS[g.period]}`);
  const history = r.runs
    ? `Its last ${r.runs} runs toward its goals were asked for ${r.asked} between them and made ${r.made}${r.runs < RECENT_RUNS ? ' (too few runs yet to go by alone)' : ''}; one takes about ${Math.round(r.ms / 60_000)} min.`
    : `No runs toward its goals yet: its plan says one makes ${agent.ferocity.floor}.`;
  return {
    sig: sigOf(goals),
    line: `- ${agent.name} (id: ${agent.id}): ${said.join(', ')}. ${runsToday} runs so far today. ${history}${pace.status === 'stuck' ? ' Its last runs made nothing.' : ''} Worked out for it now: a run toward its goals every ${Math.max(1, Math.round(pace.gapMs / 60_000))} min, up to ${pace.parallel} at once, each asked for ${pace.perRun || Math.min(pace.remaining, Math.max(1, Math.round(agent.ferocity.floor)))} (about ${Math.round(pace.runsPerDay)} runs a day).`,
  };
}
