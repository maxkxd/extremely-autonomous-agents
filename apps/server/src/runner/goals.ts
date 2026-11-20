import type { AgentDef } from './agent.js';
import { periodEnd, PERIODS, periodStart, startOfDay, type Period } from './clock.js';
import { all, one, run as exec } from './db.js';
import { DRIVEN, HOUR, MAX_NUDGES, RELENTLESS, STEADY, stanceLines } from './ferocity.js';

// Goals (docs/runner.md, "Goals"): an agent's output, in plain words and a number for a
// period - "Emails sent: 100 a day", "Posts published: 5 a week". A goal is one of its KPI
// labels (KPI.yaml `output`), so what counts toward it is exactly the actions under that
// label. Nobody sets how hard the agent works: the pace is worked out from how far it is
// from its goals - how often it runs, how many runs of it go at once, and what each run is
// asked for - and changes as the period goes. Behind, it speeds up; at its goal it eases
// off to its ordinary schedule (it is never stopped for reaching it).
//
// Every agent has a goal: one with none does not run until it is given one (scheduler.ts),
// so nothing here may leave an agent without a number (checkGoal).
//
// What counts: an action as soon as it is done or drafted (queued for a person's approval),
// and a draft a person rejects is taken off again - so an agent at its goal can drop under it.

export type Goal = { label: string; actions: string[]; amount: number; period: Period; done: number; waiting: number };

// The levers, as the scheduler and the run use them.
export type Pace = {
  everyMs: number; // start to start of its own runs
  parallel: number; // runs of it at once, its main run included
  perRun: number; // what one run is asked for (0: none)
  runsPerDay: number; // about how many runs a day this pace comes to
  level: number; // 0-4, from runsPerDay: its card's effects and the tone of what it is told
  status: 'on pace' | 'speeding up' | 'pushing hard' | 'all out' | 'goal hit' | 'stuck';
  remaining: number;
  note: string | null; // the Agency Conductor's word to it
};

export const MAX_GOAL_PARALLEL = 20;
export const MAX_AMOUNT = 1_000_000;
const DAY = 24 * HOUR;
const GAP_MS = 20_000; // a breath between back-to-back runs
// However little of a period is left, the pace is worked out as if this much were.
const MIN_LEFT_MS = 5 * 60_000;
const OWN_WORK = "('scheduled', 'apocalyptic', 'self-booked', 'request done', 'run now', 'parallel')";
// The Conductor's numbers hold this long; then the worked-out pace again until it next looks.
export const CONDUCTOR_HOLDS_MS = 45 * 60_000;
// This many of its own runs in a row with nothing counted: more runs won't help.
const STUCK_RUNS = 5;

const count = (n: number) => n.toLocaleString('en-US');
// "70 of 100 today", and "100 a day".
const NOW_WORDS: Record<Period, string> = { hour: 'this hour', day: 'today', week: 'this week', month: 'this month', year: 'this year' };
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
    `SELECT SUM(CASE WHEN p.status IN ('rejected', 'withdrawn') THEN 0 ELSE a.output END) AS done,
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

// Every goal it could have (one per KPI label), with the count so far in its period.
export function goalsOf(agent: AgentDef, now = Date.now()): Goal[] {
  return [...goalNumbers(agent.id, agent.output)].map(([label, g]) => ({ label, ...g, ...countSince(agent.id, g.actions, periodStart(g.period, now)) }));
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

// Its own recent runs: what one makes, how long one takes, and whether they've stopped
// making anything.
function recent(agentId: string): { perRun: number | null; ms: number; stuck: boolean } {
  const rows = all<{ acts: number | null; ms: number | null }>(
    `SELECT acts, ended_at - started_at AS ms FROM runs WHERE agent_id = ? AND status = 'succeeded' AND ended_at IS NOT NULL AND trigger IN ${OWN_WORK} ORDER BY started_at DESC LIMIT 10`,
    agentId,
  );
  if (!rows.length) return { perRun: null, ms: 10 * 60_000, stuck: false };
  const acts = rows.map(r => r.acts ?? 0);
  const made = acts.filter(n => n > 0);
  return {
    perRun: made.length ? made.reduce((s, n) => s + n, 0) / made.length : null,
    ms: Math.max(30_000, rows.reduce((s, r) => s + (r.ms ?? 0), 0) / rows.length),
    stuck: rows.length >= STUCK_RUNS && acts.slice(0, STUCK_RUNS).every(n => n === 0),
  };
}

// The effect level comes from how many runs a day the pace is: nobody picks it, and it
// moves by itself whenever the pace does (the Conductor's numbers included).
export const levelOf = (runsPerDay: number) => (runsPerDay <= 2 ? 0 : runsPerDay <= 12 ? 1 : runsPerDay <= 48 ? 2 : runsPerDay <= 200 ? 3 : 4);
const STATUS = ['on pace', 'on pace', 'speeding up', 'pushing hard', 'all out'] as const;
function paced(p: Pick<Pace, 'everyMs' | 'parallel' | 'perRun' | 'remaining' | 'note'>, status?: Pace['status']): Pace {
  const runsPerDay = (p.parallel * DAY) / p.everyMs;
  const level = levelOf(runsPerDay);
  return { ...p, runsPerDay, level, status: status ?? STATUS[level] };
}

type Stored = { every_ms: number | null; parallel: number | null; per_run: number | null; note: string | null; sig: string; updated_at: number };
const sigOf = (goals: Goal[]) => goals.map(g => `${g.label}=${g.amount}/${g.period}`).join('|');

// The pace its goals call for right now; null when it has no goal (it does not run).
export function paceFor(agent: AgentDef, now = Date.now(), goals = goalsOf(agent, now)): Pace | null {
  const live = goals.filter(g => g.amount > 0);
  if (!live.length) return null;
  const steadyMs = agent.ferocity.every_hours[0] * HOUR;
  const remaining = live.reduce((s, g) => s + Math.max(0, g.amount - g.done), 0);
  const stored = one<Stored>('SELECT * FROM agent_pace WHERE agent_id = ?', agent.id);
  const held = stored && stored.sig === sigOf(goals) && now - stored.updated_at < CONDUCTOR_HOLDS_MS ? stored : null;
  const note = held?.note?.trim() || null;
  // At its goal: its ordinary schedule, nothing asked of a run. It carries on; it isn't stopped.
  if (remaining <= 0) return paced({ everyMs: steadyMs, parallel: 1, perRun: 0, remaining: 0, note }, 'goal hit');
  const r = recent(agent.id);
  // Runs that make nothing don't get more of them: an hour apart, one at a time, until one does.
  if (r.stuck) return paced({ everyMs: Math.min(steadyMs, HOUR), parallel: 1, perRun: 0, remaining, note }, 'stuck');
  const each = Math.max(1, r.perRun ?? agent.ferocity.floor);
  const lane = r.ms + GAP_MS;
  // Each goal by itself: the runs it still needs, over what is left of its own period
  // (aiming to be done a little before it ends). Added together they are the runs it
  // needs per millisecond, whatever mix of hours, days and weeks its goals are in.
  let rate = 0;
  let needed = 0;
  for (const g of live) {
    const runs = Math.ceil(Math.max(0, g.amount - g.done) / each);
    needed += runs;
    rate += runs / Math.max(MIN_LEFT_MS, (periodEnd(g.period, now) - now) * 0.9);
  }
  // One run after another keeps up with one lane's worth; more than that goes side by
  // side - never more of them than the runs it still needs.
  let parallel = Math.min(MAX_GOAL_PARALLEL, needed, Math.max(1, Math.ceil(rate * lane)));
  let everyMs = Math.max(lane, parallel / rate);
  let perRun = Math.min(remaining, Math.max(1, Math.ceil(each * 1.2)));
  // The Agency Conductor's call, kept inside what makes sense.
  if (held) {
    if (held.per_run) perRun = Math.min(remaining, Math.max(1, Math.floor(held.per_run)));
    if (held.parallel) parallel = Math.min(MAX_GOAL_PARALLEL, Math.max(1, Math.floor(held.parallel)));
    if (held.every_ms) everyMs = Math.max(GAP_MS, held.every_ms);
  }
  // Never slower than its ordinary schedule.
  everyMs = Math.min(everyMs, steadyMs);
  return paced({ everyMs, parallel, perRun, remaining, note });
}

// What a run of its own work is held to.
export function goalFloor(pace: Pace | null): { floor: number; nudges: number; soft: boolean } | null {
  return pace && pace.perRun > 0 ? { floor: pace.perRun, nudges: MAX_NUDGES, soft: false } : null;
}

// When its goals next want a run of its own (after its last one has ended and had a breath).
export function goalDue(pace: Pace, lastStartedAt: number | null, lastEndedAt: number | null, now: number): boolean {
  if (lastEndedAt && now - lastEndedAt < GAP_MS) return false;
  return lastStartedAt == null || lastStartedAt + pace.everyMs <= now;
}

// More than one run at once: the scheduler starts the others itself, each told to take a
// different slice. Booked only up to the number wanted, so nothing piles up.
export const GOAL_BATCH = 'Goal batch';
export function bookGoalRuns(agent: AgentDef, pace: Pace, now: number): number {
  if (pace.parallel <= 1) return 0;
  const going = one<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND trigger = 'parallel' AND status = 'running'", agent.id)?.n ?? 0;
  const queued = one<{ n: number }>("SELECT COUNT(*) AS n FROM bookings WHERE agent_id = ? AND trigger = 'parallel'", agent.id)?.n ?? 0;
  const want = pace.parallel - 1 - going - queued;
  for (let i = 0; i < want; i++)
    exec(
      "INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, 'parallel', ?, ?, ?)",
      agent.id,
      `${GOAL_BATCH} ${going + queued + i + 2} of ${pace.parallel}: work toward your goal. Other runs of you are doing the same right now, so take a different slice of the work (other leads, accounts, records or topics) - look at what is already done, queued or logged first, and never do a piece twice.`,
      now,
      now,
    );
  return Math.max(0, want);
}
export const isGoalBatch = (task: string | null) => !!task && task.startsWith(GOAL_BATCH);

// --- What the agent is told ---------------------------------------------------------

export function goalInstructions(agent: AgentDef, goals: Goal[], pace: Pace): string {
  const live = goals.filter(g => g.amount > 0);
  const lines = [
    '## Your goal',
    live.map(g => `- ${g.label}: ${count(g.done)} of ${count(g.amount)} ${NOW_WORDS[g.period]}${g.waiting ? ` (${count(g.waiting)} of those wait for a person's approval)` : ''}`).join('\n'),
    "Only the work named there moves your goal; anything else doesn't. Something counts as soon as you do it or queue it for approval, and comes off again if a person rejects it.",
  ];
  if (pace.status === 'goal hit')
    lines.push("Your goal is reached for now. Carry on at an easy pace with whatever is still useful - you aren't stopped, and there's nothing to push for until the count starts again.");
  else if (pace.status === 'stuck')
    lines.push('Your last runs made nothing toward it. More of the same will not help: find out what is in the way (a tool, a limit, nothing left to work on), fix what you can, and file a request for what you cannot.');
  else {
    lines.push(
      `You run many times${pace.parallel > 1 ? `, and ${pace.parallel} runs of you are working at once` : ''}, so the whole goal is not this run's job. This run: at least ${count(pace.perRun)} toward it - keep going until you reach that.`,
      pace.level >= RELENTLESS
        ? 'You are behind where you need to be by now. Volume of finished work matters more than token efficiency: move fast, and keep going while there is real work left.'
        : pace.level === DRIVEN
          ? 'You need to move a little faster than usual to get there in time.'
          : 'You are on pace.',
    );
  }
  if (pace.note) lines.push(`From the Agency Conductor, who keeps every agent on its goal: ${pace.note}`);
  lines.push('Never make work to fill the number: if a limit in your instructions is reached, or there is genuinely nothing real left to do, stop and say so.');
  lines.push(...stanceLines(agent, pace.status === 'goal hit' || pace.status === 'stuck' ? STEADY : pace.level, pace.parallel > 1));
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
const leftWords = (ms: number) => (ms >= 48 * HOUR ? `${(ms / DAY).toFixed(1)} days` : `${(Math.max(0, ms) / HOUR).toFixed(1)} h`);
export function paceFacts(agent: AgentDef, now: number): { sig: string; line: string } | null {
  const goals = goalsOf(agent, now);
  const pace = paceFor(agent, now, goals);
  if (!pace || pace.status === 'goal hit') return null;
  const r = recent(agent.id);
  const runsToday = one<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND started_at >= ?', agent.id, startOfDay(now))?.n ?? 0;
  const said = goals.filter(g => g.amount > 0).map(g => `${g.label} ${g.done}/${g.amount} ${NOW_WORDS[g.period]} (${leftWords(periodEnd(g.period, now) - now)} left)`);
  return {
    sig: sigOf(goals),
    line: `- ${agent.name} (id: ${agent.id}): ${said.join(', ')}. ${runsToday} runs so far today. A run makes about ${r.perRun == null ? 'unknown (no output yet)' : r.perRun.toFixed(1)} and takes about ${Math.round(r.ms / 60_000)} min.${r.stuck ? ' Its last runs made nothing.' : ''} Worked out for it now: a run every ${Math.max(1, Math.round(pace.everyMs / 60_000))} min, ${pace.parallel} at once, ${pace.perRun} per run (about ${Math.round(pace.runsPerDay)} runs a day).`,
  };
}
