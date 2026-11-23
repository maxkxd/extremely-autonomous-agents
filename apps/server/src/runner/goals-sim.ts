import { DEFAULT_PLAN, type AgentDef } from './agent.js';
import { PERIOD_MS, setHostZone, type Period } from './clock.js';
import { one, resetDbForTests, run as exec } from './db.js';
import { backoffMs, parallelSlots, STEADY } from './ferocity.js';
import { bookGoalRuns, GOAL_BATCH, goalFloor, goalsOf, paceFor, setGoal, type Pace } from './goals.js';
import { stateOf } from './run.js';
import { ensurePendingDue, nextRun } from './scheduler.js';

// A simulator for the goal pace (goals.ts), for its tests only: the real pace arithmetic
// and the real scheduler decisions (nextRun, ensurePendingDue, bookGoalRuns), driven by a
// made-up clock and a made-up agent that makes whatever its `make` says. It answers what
// no single-call test can: over days, does the count in the goal's window get to the goal
// and stay near it, whatever the agent, the goal and the interruptions?

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TICK = 5_000; // scheduler.ts TICK_MS
const TOOL = 'gmail.send_email';
const LABEL = 'Emails sent';
export const SIM_START = Date.UTC(2026, 9, 20, 12);

export type RunCtx = { asked: number; status: Pace['status'] | 'none'; remaining: number; parallel: boolean; t: number; rng: () => number };
export type Scenario = {
  // The plan: what a run is taken to make before it has a history, and its ordinary schedule.
  floor?: number;
  everyHours?: number;
  // Its goal over time: hours from the start, and the number.
  goals: { atHour: number; amount: number; period: Period }[];
  days: number;
  seed?: number;
  // What one run makes, and how long it takes (minutes).
  make: (c: RunCtx) => number;
  minutes?: (made: number, c: RunCtx) => number;
  // A run that fails outright (nothing made, counted as a failure).
  fails?: (c: RunCtx) => boolean;
  // Drafts for a person: the share of its output that waits for approval, when the person
  // gets to one (minutes after it was drafted) and what they decide.
  approval?: { share: number; afterMin: (rng: () => number) => number; verdict: (rng: () => number) => 'approved' | 'rejected' | 'expired' };
  // The agency is off (a computer asleep): nothing ticks. Hours from the start.
  off?: (hour: number) => boolean;
  // The Conductor's numbers, set now and then (hours from the start).
  conductor?: { atHour: number; every_min?: number; parallel?: number; per_run?: number }[];
};

export type Sample = { hour: number; done: number; amount: number; level: number; status: string; runsPerDay: number; parallel: number; perRun: number };
export type SimRun = { start: number; end: number; made: number; asked: number; parallel: boolean; failed: boolean; status: string };
export type SimResult = { samples: Sample[]; runs: SimRun[] };

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Going = { id: string; parallel: boolean; start: number; end: number; made: number; emitted: number; asked: number; failed: boolean; status: string };

export function simulate(s: Scenario): SimResult {
  resetDbForTests();
  setHostZone('UTC');
  const rng = mulberry(s.seed ?? 1);
  const plan = { ...DEFAULT_PLAN, floor: s.floor ?? DEFAULT_PLAN.floor, counts: [TOOL] };
  plan.every_hours = [s.everyHours ?? 24, 16, 12, 6];
  const agent = { id: 'sim', name: 'Sim', output: [{ action: TOOL, label: LABEL }], ferocity: plan } as unknown as AgentDef;
  const end = SIM_START + s.days * DAY;
  const goalsLeft = [...s.goals].sort((a, b) => a.atHour - b.atHour);
  const conductorLeft = [...(s.conductor ?? [])].sort((a, b) => a.atHour - b.atHour);
  const going: Going[] = [];
  const decisions: { at: number; id: string; verdict: 'approved' | 'rejected' | 'expired' }[] = [];
  const samples: Sample[] = [];
  const runs: SimRun[] = [];
  let n = 0;
  let approvals = 0;
  let now = SIM_START;
  let nextSample = SIM_START;
  let wasOff = false;

  const emit = (g: Going, upTo: number) => {
    // Its output comes out evenly over the run.
    const span = Math.max(1, g.end - g.start);
    const due = upTo >= g.end ? g.made : Math.floor((g.made * (upTo - g.start)) / span);
    for (; g.emitted < due; g.emitted++) {
      const at = Math.min(g.end, g.start + Math.round(((g.emitted + 1) * span) / g.made));
      if (s.approval && rng() < s.approval.share) {
        const id = `a${approvals++}`;
        exec("INSERT INTO approvals (id, agent_id, run_id, tool, args, status, created_at, expires_at) VALUES (?, 'sim', ?, ?, '{}', 'pending', ?, ?)", id, g.id, TOOL, at, at + DAY);
        exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, output, approval_id, at) VALUES (?, 'sim', ?, '[]', 'T2', 'queued', 1, ?, ?)", g.id, TOOL, id, at);
        decisions.push({ at: at + s.approval.afterMin(rng) * MIN, id, verdict: s.approval.verdict(rng) });
      } else exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, output, approval_id, at) VALUES (?, 'sim', ?, '[]', 'T1', 'ok', 1, NULL, ?)", g.id, TOOL, at);
    }
  };
  const finish = (g: Going, at: number) => {
    emit(g, at);
    exec('UPDATE runs SET status = ?, ended_at = ?, acts = ? WHERE id = ?', g.failed ? 'failed' : 'succeeded', at, g.emitted, g.id);
    // run.ts: a failure backs its next run off, a success clears it.
    const st = stateOf('sim', at);
    const streak = g.failed ? st.fail_streak + 1 : 0;
    exec('UPDATE agent_state SET fail_streak = ?, backoff_until = ? WHERE agent_id = ?', streak, streak ? at + backoffMs(streak) : null, 'sim');
    runs.push({ start: g.start, end: at, made: g.emitted, asked: g.asked, parallel: g.parallel, failed: g.failed, status: g.status });
  };
  const start = (trigger: string, task: string | null) => {
    // run.ts runAgent: the pace at its start gives what this run is asked for.
    const pace = paceFor(agent, now, undefined, trigger === 'run now');
    const parallel = trigger === 'parallel';
    const asked = goalFloor(pace)?.floor ?? 0;
    const c: RunCtx = { asked, status: pace?.status ?? 'none', remaining: pace?.remaining ?? 0, parallel, t: now, rng };
    const failed = !!s.fails?.(c);
    const made = failed ? 0 : Math.max(0, Math.round(s.make(c)));
    const minutes = Math.max(0.5, s.minutes ? s.minutes(made, c) : 10);
    const id = `r${n++}`;
    exec("INSERT INTO runs (id, agent_id, trigger, task, ferocity, status, started_at, floor) VALUES (?, 'sim', ?, ?, ?, 'running', ?, ?)", id, trigger, task, pace?.level ?? 1, now, pace && pace.perRun > 0 ? asked : null);
    going.push({ id, parallel, start: now, end: now + Math.round(minutes * MIN), made, emitted: 0, asked, failed, status: c.status });
  };

  while (now < end) {
    const hour = (now - SIM_START) / HOUR;
    while (goalsLeft.length && goalsLeft[0].atHour <= hour) {
      const g = goalsLeft.shift()!;
      setGoal('sim', LABEL, g.amount, g.period, now);
    }
    while (conductorLeft.length && conductorLeft[0].atHour <= hour) {
      const c = conductorLeft.shift()!;
      const sig = goalsOf(agent, now)
        .map(g => `${g.label}=${g.amount}/${g.period}`)
        .join('|');
      exec(
        'INSERT INTO agent_pace (agent_id, every_ms, parallel, per_run, note, sig, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET every_ms = excluded.every_ms, parallel = excluded.parallel, per_run = excluded.per_run, sig = excluded.sig, updated_at = excluded.updated_at',
        'sim',
        c.every_min ? c.every_min * MIN : null,
        c.parallel ?? null,
        c.per_run ?? null,
        sig,
        now,
      );
    }
    const off = !!s.off?.(hour);
    if (off && !wasOff) {
      // Switched off: what was running is cut short with what it had made.
      for (const g of going.splice(0)) {
        g.failed = true;
        emit(g, now);
        g.made = g.emitted;
        finish(g, now);
      }
      exec("UPDATE agent_state SET fail_streak = 0, backoff_until = NULL WHERE agent_id = 'sim'");
    }
    wasOff = off;
    for (const g of [...going]) {
      if (g.end <= now) {
        going.splice(going.indexOf(g), 1);
        finish(g, g.end);
      } else emit(g, now);
    }
    for (const d of decisions.filter(x => x.at <= now)) {
      decisions.splice(decisions.indexOf(d), 1);
      exec('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?', d.verdict, d.at, d.id);
      exec("UPDATE actions SET outcome = ? WHERE approval_id = ? AND outcome = 'queued'", d.verdict === 'approved' ? 'ok' : 'refused', d.id);
    }
    let started = false;
    let pace: Pace | null = null;
    if (!off) {
      // scheduler.ts tick, for one ordinary agent.
      const st = stateOf('sim', now);
      pace = paceFor(agent, now);
      if (pace && pace.parallel > 1 && st.state === 'active') bookGoalRuns(agent, pace, now);
      else exec("DELETE FROM bookings WHERE agent_id = ? AND trigger = 'parallel' AND task LIKE ?", 'sim', `${GOAL_BATCH}%`);
      let next: ReturnType<typeof nextRun> = null;
      if (going.length) {
        const room = going.filter(r => r.parallel).length < Math.max(parallelSlots(pace?.level ?? STEADY), (pace?.parallel ?? 1) - 1);
        const mainGoing = going.some(r => !r.parallel);
        if (mainGoing && pace && st.state === 'active') ensurePendingDue(agent, pace, st, now);
        next = nextRun(agent, st, now, b => (b.trigger === 'parallel' ? room : !mainGoing));
        if (next && (next.trigger === 'parallel' ? !next.bookingId : mainGoing)) next = null;
      } else next = nextRun(agent, st, now);
      if (next) {
        if (next.bookingId) exec('DELETE FROM bookings WHERE id = ?', next.bookingId);
        if (['scheduled', 'self-booked', 'request done', 'run now'].includes(next.trigger)) exec('UPDATE agent_state SET last_scheduled_at = ? WHERE agent_id = ?', now, 'sim');
        start(next.trigger, next.task);
        started = true;
      }
    }
    while (nextSample <= now) {
      const g = goalsOf(agent, now)[0];
      const p = paceFor(agent, now);
      samples.push({ hour: (nextSample - SIM_START) / HOUR, done: g.done, amount: g.amount, level: p?.level ?? -1, status: p?.status ?? 'none', runsPerDay: p?.runsPerDay ?? 0, parallel: p?.parallel ?? 0, perRun: p?.perRun ?? 0 });
      nextSample += 10 * MIN;
    }
    // On to the next moment anything can change: a two-hundredth of its goal's period at
    // most (work leaving the window changes the pace), between 15 seconds and 5 minutes.
    const period = PERIOD_MS[goalsOf(agent, now)[0]?.period ?? 'day'];
    let to = now + Math.max(15_000, Math.min(5 * MIN, period / 200));
    if (started || one("SELECT 1 AS x FROM bookings WHERE agent_id = 'sim' AND due_at <= ?", now)) to = now + TICK;
    for (const g of going) to = Math.min(to, g.end);
    // A goal or the Conductor's numbers change then.
    for (const x of [...goalsLeft, ...conductorLeft]) to = Math.min(to, Math.max(now + TICK, SIM_START + x.atHour * HOUR));
    if (pace) {
      const st = stateOf('sim', now);
      if (st.last_scheduled_at && st.last_scheduled_at + pace.everyMs > now) to = Math.min(to, st.last_scheduled_at + pace.everyMs);
      // A run toward its goal is due then - or is due now and waits for room.
      if (pace.nextAt != null) to = Math.min(to, Math.max(now + TICK, pace.nextAt));
    }
    now = Math.max(now + TICK, Math.ceil(to / TICK) * TICK);
  }
  return { samples, runs };
}

// --- Reading a result -----------------------------------------------------------------

// How the count in the window sat against the goal between two hours: lowest, average and
// highest, as a share of the goal; and how its card behaved.
export function held(r: SimResult, fromHour: number, toHour = Infinity) {
  const s = r.samples.filter(x => x.hour >= fromHour && x.hour < toHour && x.amount > 0);
  const share = s.map(x => x.done / x.amount);
  return {
    low: Math.min(...share),
    mean: share.reduce((a, b) => a + b, 0) / Math.max(1, share.length),
    high: Math.max(...share),
    // How often its card changed level, a day.
    flips: s.reduce((c, x, i) => c + (i > 0 && x.level !== s[i - 1].level ? 1 : 0), 0) / Math.max(1 / 24, (s.length * 10) / (60 * 24)),
    levels: [...new Set(s.map(x => x.level))].sort(),
  };
}
export function runsBetween(r: SimResult, fromHour: number, toHour = Infinity) {
  const rs = r.runs.filter(x => x.start >= SIM_START + fromHour * HOUR && x.start < SIM_START + toHour * HOUR);
  const last = Math.max(...r.samples.map(x => x.hour));
  const span = (Math.min(toHour, last) - fromHour) / 24;
  return {
    perDay: rs.length / Math.max(1 / 24, span),
    biggest: Math.max(0, ...rs.map(x => x.made)),
    typical: rs.length ? rs.reduce((a, x) => a + x.made, 0) / rs.length : 0,
    atOnce: Math.max(0, ...rs.map(x => rs.filter(y => y.start <= x.start && y.end > x.start).length)),
    failed: rs.filter(x => x.failed).length,
  };
}
// The first hour, from a given one, at which the count reached this share of the goal.
export const reached = (r: SimResult, share: number, fromHour = 0) => r.samples.find(x => x.hour >= fromHour && x.amount > 0 && x.done >= x.amount * share)?.hour ?? null;
