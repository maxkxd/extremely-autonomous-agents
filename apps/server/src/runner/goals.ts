import type { AgentDef } from './agent.js';
import { startOfDay } from './clock.js';
import { all, one, run as exec } from './db.js';
import { APOCALYPTIC, DRIVEN, HOUR, MAX_NUDGES, RELENTLESS, STEADY, stanceLines } from './ferocity.js';

// Goals (docs/runner.md, "Goals"): an agent's output for the day, in plain words and a
// number - "Emails sent: 100". A goal is one of its KPI labels (KPI.yaml `output`), so what
// counts toward it is exactly the actions under that label. Nobody sets how hard the agent
// works: the pace is worked out from how far it is from its goals - how often it runs, how
// many runs of it go at once, and what each run is asked for - and changes as the day goes.
// Behind, it speeds up; at its goal it eases off to its ordinary schedule (it is never
// stopped for reaching it). An agent with no goal keeps its level and schedule (ferocity.ts).
//
// What counts: an action as soon as it is done or drafted (queued for a person's approval),
// and a draft a person rejects is taken off again - so an agent at its goal can drop under it.

export type Goal = { label: string; actions: string[]; perDay: number; done: number; waiting: number };

// The levers, as the scheduler and the run use them.
export type Pace = {
  everyMs: number; // start to start of its own runs
  parallel: number; // runs of it at once, its main run included
  perRun: number; // what one run is asked for (0: none)
  level: number; // the ferocity level it works like (its tone, its card)
  status: 'on pace' | 'speeding up' | 'pushing hard' | 'all out' | 'goal hit' | 'stuck';
  remaining: number;
  note: string | null; // the Agency Conductor's word to it
};

export const MAX_GOAL_PARALLEL = 20;
export const MAX_PER_DAY = 1_000_000;
const GAP_MS = 20_000; // a breath between back-to-back runs
const OWN_WORK = "('scheduled', 'apocalyptic', 'self-booked', 'request done', 'run now', 'parallel')";
// The Conductor's numbers hold this long; then the worked-out pace again until it next looks.
export const CONDUCTOR_HOLDS_MS = 45 * 60_000;
// This many of its own runs in a row with nothing counted: more runs won't help.
const STUCK_RUNS = 5;

const dayEnd = (now: number) => startOfDay(now) + 24 * HOUR;

// --- The goals themselves -------------------------------------------------------

export function setGoal(agentId: string, label: string, perDay: number, now = Date.now()) {
  const n = Math.max(0, Math.min(MAX_PER_DAY, Math.floor(Number(perDay) || 0)));
  exec(
    'INSERT INTO agent_goals (agent_id, label, per_day, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id, label) DO UPDATE SET per_day = excluded.per_day, updated_at = excluded.updated_at',
    agentId,
    label,
    n,
    now,
  );
  // The Conductor's numbers were for the old goal.
  exec('DELETE FROM agent_pace WHERE agent_id = ?', agentId);
}

// Done or drafted today under these actions, less what a person rejected; and how many
// of them still wait for a person.
function countToday(agentId: string, actions: string[], now: number): { done: number; waiting: number } {
  if (!actions.length) return { done: 0, waiting: 0 };
  const marks = actions.map(() => '?').join(', ');
  const row = one<{ done: number | null; waiting: number | null }>(
    `SELECT SUM(CASE WHEN p.status IN ('rejected', 'withdrawn') THEN 0 ELSE a.output END) AS done,
            SUM(CASE WHEN p.status = 'pending' THEN a.output ELSE 0 END) AS waiting
       FROM actions a LEFT JOIN approvals p ON p.id = a.approval_id
      WHERE a.agent_id = ? AND a.at >= ? AND a.outcome IN ('ok', 'queued') AND a.tool IN (${marks})`,
    agentId,
    startOfDay(now),
    ...actions,
  );
  return { done: row?.done ?? 0, waiting: row?.waiting ?? 0 };
}

// Every goal it could have (one per KPI label, in the KPI's order), with today's count.
// A label's number comes from its card; before anyone set one, from the builder's
// `per_day` on that KPI row.
export function goalsOf(agent: AgentDef, now = Date.now()): Goal[] {
  const set = new Map(all<{ label: string; per_day: number }>('SELECT label, per_day FROM agent_goals WHERE agent_id = ?', agent.id).map(r => [r.label, r.per_day] as const));
  const byLabel = new Map<string, { actions: string[]; seed: number }>();
  for (const o of agent.output) {
    const g = byLabel.get(o.label) ?? { actions: [], seed: 0 };
    g.actions.push(o.action);
    g.seed = Math.max(g.seed, Math.floor(Number((o as { per_day?: number }).per_day) || 0));
    byLabel.set(o.label, g);
  }
  return [...byLabel].map(([label, g]) => ({ label, actions: g.actions, perDay: set.get(label) ?? g.seed, ...countToday(agent.id, g.actions, now) }));
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

const levelOf = (parallel: number, everyMs: number, steadyMs: number) => (parallel >= 8 ? APOCALYPTIC : parallel > 1 ? RELENTLESS : everyMs < steadyMs / 2 ? DRIVEN : STEADY);
const STATUS = ['on pace', 'on pace', 'speeding up', 'pushing hard', 'all out'] as const;

type Stored = { every_ms: number | null; parallel: number | null; per_run: number | null; note: string | null; sig: string; updated_at: number };
const sigOf = (goals: Goal[]) => goals.map(g => `${g.label}=${g.perDay}`).join('|');

// The pace its goals call for right now; null when it has no goal (its level decides).
export function paceFor(agent: AgentDef, now = Date.now(), goals = goalsOf(agent, now)): Pace | null {
  const live = goals.filter(g => g.perDay > 0);
  if (!live.length) return null;
  const steadyMs = agent.ferocity.every_hours[0] * HOUR;
  const remaining = live.reduce((s, g) => s + Math.max(0, g.perDay - g.done), 0);
  const stored = one<Stored>('SELECT * FROM agent_pace WHERE agent_id = ?', agent.id);
  const held = stored && stored.sig === sigOf(goals) && now - stored.updated_at < CONDUCTOR_HOLDS_MS ? stored : null;
  const note = held?.note?.trim() || null;
  // At its goal: its ordinary schedule, nothing asked of a run. It carries on; it isn't stopped.
  if (remaining <= 0) return { everyMs: steadyMs, parallel: 1, perRun: 0, level: STEADY, status: 'goal hit', remaining: 0, note };
  const r = recent(agent.id);
  // Runs that make nothing don't get more of them: an hour apart, one at a time, until one does.
  if (r.stuck) return { everyMs: Math.min(steadyMs, HOUR), parallel: 1, perRun: 0, level: STEADY, status: 'stuck', remaining, note };
  const each = Math.max(1, r.perRun ?? agent.ferocity.floor);
  // Aim to be done a little before the day ends.
  const left = Math.max(30 * 60_000, (dayEnd(now) - now) * 0.9);
  const lane = r.ms + GAP_MS;
  let needed = Math.ceil(remaining / each);
  let parallel = Math.min(MAX_GOAL_PARALLEL, Math.max(1, Math.ceil(needed / Math.max(1, Math.floor(left / lane)))));
  let everyMs = Math.max(lane, (left * parallel) / needed);
  let perRun = Math.min(remaining, Math.max(1, Math.ceil(each * 1.2)));
  // The Agency Conductor's call, kept inside what makes sense.
  if (held) {
    if (held.per_run) perRun = Math.min(remaining, Math.max(1, Math.floor(held.per_run)));
    if (held.parallel) parallel = Math.min(MAX_GOAL_PARALLEL, Math.max(1, Math.floor(held.parallel)));
    if (held.every_ms) everyMs = Math.max(GAP_MS, held.every_ms);
    needed = Math.ceil(remaining / perRun);
  }
  // Never slower than its ordinary schedule.
  everyMs = Math.min(everyMs, steadyMs);
  const level = levelOf(parallel, everyMs, steadyMs);
  return { everyMs, parallel, perRun, level, status: STATUS[level], remaining, note };
}

// The level it works like: its goals' when it has any, else the one on its row.
export const levelFor = (agent: AgentDef, stored: number, now = Date.now()) => paceFor(agent, now)?.level ?? stored;

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
      `${GOAL_BATCH} ${going + queued + i + 2} of ${pace.parallel}: work toward today's goal. Other runs of you are doing the same right now, so take a different slice of the work (other leads, accounts, records or topics) - look at what is already done, queued or logged first, and never do a piece twice.`,
      now,
      now,
    );
  return Math.max(0, want);
}
export const isGoalBatch = (task: string | null) => !!task && task.startsWith(GOAL_BATCH);

// --- What the agent is told ---------------------------------------------------------

const count = (n: number) => n.toLocaleString('en-US');

export function goalInstructions(agent: AgentDef, goals: Goal[], pace: Pace): string {
  const live = goals.filter(g => g.perDay > 0);
  const lines = [
    '## Your goal today',
    live.map(g => `- ${g.label}: ${count(g.done)} of ${count(g.perDay)}${g.waiting ? ` (${count(g.waiting)} of those wait for a person's approval)` : ''}`).join('\n'),
    "Only the work named there moves your goal; anything else doesn't. Something counts as soon as you do it or queue it for approval, and comes off again if a person rejects it.",
  ];
  if (pace.status === 'goal hit')
    lines.push("Today's goal is reached. Carry on at an easy pace with whatever is still useful - you aren't stopped, and there's nothing to push for until tomorrow.");
  else if (pace.status === 'stuck')
    lines.push('Your last runs made nothing toward it. More of the same will not help: find out what is in the way (a tool, a limit, nothing left to work on), fix what you can, and file a request for what you cannot.');
  else {
    lines.push(
      `You run many times a day${pace.parallel > 1 ? `, and ${pace.parallel} runs of you are working at once` : ''}, so the whole goal is not this run's job. This run: at least ${count(pace.perRun)} toward it - keep going until you reach that.`,
      pace.level >= RELENTLESS
        ? 'You are behind where you need to be for this time of day. Volume of finished work matters more than token efficiency: move fast, and keep going while there is real work left.'
        : pace.level === DRIVEN
          ? 'You need to move a little faster than usual to get there today.'
          : 'You are on pace.',
    );
  }
  if (pace.note) lines.push(`From the Agency Conductor, who keeps every agent on its goal: ${pace.note}`);
  lines.push('Never make work to fill the number: if a limit in your instructions is reached, or there is genuinely nothing real left to do, stop and say so.');
  lines.push(...stanceLines(agent, pace.status === 'goal hit' || pace.status === 'stuck' ? STEADY : pace.level, pace.parallel > 1));
  return lines.filter(Boolean).join('\n\n');
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
  const r = recent(agent.id);
  const hoursLeft = Math.max(0, (dayEnd(now) - now) / HOUR);
  const runsToday = one<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND started_at >= ?', agent.id, startOfDay(now))?.n ?? 0;
  return {
    sig: sigOf(goals),
    line: `- ${agent.name} (id: ${agent.id}): ${goals.filter(g => g.perDay > 0).map(g => `${g.label} ${g.done}/${g.perDay}`).join(', ')}. ${hoursLeft.toFixed(1)} h left today, ${runsToday} runs so far. A run makes about ${r.perRun == null ? 'unknown (no output yet)' : r.perRun.toFixed(1)} and takes about ${Math.round(r.ms / 60_000)} min.${r.stuck ? ' Its last runs made nothing.' : ''} Worked out for it now: a run every ${Math.max(1, Math.round(pace.everyMs / 60_000))} min, ${pace.parallel} at once, ${pace.perRun} per run.`,
  };
}
