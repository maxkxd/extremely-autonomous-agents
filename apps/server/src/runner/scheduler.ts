import { listIds, readMeta } from '../files.js';
import { loadIntegrations } from '../integrations/index.js';
import './web.js'; // registers the web tools
import './browser.js'; // registers the browser tools
import { availableModels, nativeEffortSync } from '../models/connections.js';
import { allChecks } from '../models/check.js';
import { choiceKey } from '../models/health.js';
import type { ModelChoice } from '../models/choice.js';
import { loadAgent, type AgentDef } from './agent.js';
import { expireApprovals } from './approvals.js';
import { all, one, run as exec } from './db.js';
import { APOCALYPTIC, APOCALYPTIC_GAP_MS, backstop, scheduledDue } from './ferocity.js';
import { costOf, startOfDay } from './pricing.js';
import { harnessFor } from './harness.js';
import { adapterFor } from './providers.js';
import { eligibleModels, runAgent, stateOf, type RunDeps, type Trigger } from './run.js';

// Decides when each agent runs (docs/runner.md). Every tick, for each agent
// that isn't running: a booking that's due (your messages first), else at
// Apocalyptic the next run straight after the last, else its ferocity
// schedule. One run per agent at a time; a few at once overall, and one
// local-model run at a time (a laptop can't hold two). Failing agents back
// off; the backstop is only for runaways.

const TICK_MS = 5_000;
export const MAX_PARALLEL = 4;

const running = new Map<string, { controller: AbortController; connection: string | null; startedAt: number }>();
export const isRunning = (agentId: string) => running.has(agentId);

// What the runner knows about connected models, refreshed every tick.
let models: Awaited<ReturnType<typeof availableModels>> = [];
let checks: Awaited<ReturnType<typeof allChecks>> = {};

export const liveDeps: RunDeps = {
  now: () => Date.now(),
  adapter: adapterFor,
  harness: harnessFor,
  modelInfo: (c: ModelChoice) => {
    const a = models.find(m => m.connection === c.connection);
    const check = checks[choiceKey(c)];
    const usable = !!a?.models.includes(c.model) && !(check && !check.ok);
    const efforts = a?.efforts[c.model] ?? [];
    return { usable, efforts, native: nativeEffortSync(c.connection, c.model) };
  },
  cost: costOf,
  wake: (agentId, trigger, task) => book(agentId, trigger, task),
  compact: true,
};

// A run to start as soon as it can (handoffs, your messages, Run now).
export function book(agentId: string, trigger: Trigger, task: string | null, dueAt = Date.now()) {
  exec('INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, ?, ?, ?, ?)', agentId, trigger, task, dueAt, Date.now());
}

const runsToday = (agentId: string, now: number) =>
  one<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND started_at >= ?', agentId, startOfDay(now))?.n ?? 0;

let ticking = false;
export async function tick(deps: RunDeps = liveDeps) {
  if (ticking) return;
  ticking = true;
  try {
    models = await availableModels();
    checks = await allChecks();
    const now = deps.now();
    expireApprovals(now, book);
    for (const id of await listIds()) {
      if (running.size >= MAX_PARALLEL) break;
      if (running.has(id)) continue;
      const meta = await readMeta(id);
      if (!meta || meta.status === 'setting-up') continue;
      const st = stateOf(id, now);
      // Stopped: nothing runs at all (what's booked waits for it to be turned back on).
      if (st.state === 'stopped') continue;
      const agent = await loadAgent(id);
      if (!agent) continue;
      const next = nextRun(agent, st, now);
      if (!next) continue;
      const eligible = eligibleModels(agent, deps);
      // Nothing it can run on: wait (a message still gets an answer saying why).
      if (!eligible.length && next.trigger !== 'your message') continue;
      const local = eligible[0]?.connection === 'ollama';
      if (local && [...running.values()].some(r => r.connection === 'ollama')) continue;
      if (next.bookingId) exec('DELETE FROM bookings WHERE id = ?', next.bookingId);
      // A run it booked itself counts as its scheduled run: the schedule's clock
      // restarts, so booking a run never adds one on top of the level's pace.
      if (next.trigger === 'scheduled' || next.trigger === 'self-booked' || next.trigger === 'run now')
        exec('UPDATE agent_state SET last_scheduled_at = ? WHERE agent_id = ?', now, id);
      start(agent, next.trigger, next.task, deps, eligible[0]?.connection ?? null);
    }
  } finally {
    ticking = false;
  }
}

type Next = { trigger: Trigger; task: string | null; bookingId?: number };

// What a person set off, which a draining agent still runs: their message,
// Run now, and hearing how an approval it queued was decided.
const PERSON_DRIVEN = new Set<Trigger>(['your message', 'run now', 'approval']);

// The run an agent should start now, if any.
//   active   - its schedule, its own bookings, handoffs, and anything a person sets off
//   draining - finishes the run it's in; starts nothing itself, but still answers a
//              person, runs Run now, and hears approval outcomes
//   stopped  - nothing; the run it was in was cut short (bookings wait)
export function nextRun(agent: AgentDef, st: ReturnType<typeof stateOf>, now: number): Next | null {
  if (st.state === 'stopped') return null;
  const due = all<{ id: number; trigger: Trigger; task: string | null }>(
    "SELECT id, trigger, task FROM bookings WHERE agent_id = ? AND due_at <= ? ORDER BY CASE trigger WHEN 'your message' THEN 0 ELSE 1 END, due_at, id",
    agent.id,
    now,
  );
  // A person's message is answered even when the agent is stopped or backing off.
  const message = due.find(b => b.trigger === 'your message');
  if (message) return { trigger: message.trigger, task: message.task, bookingId: message.id };
  if (st.state === 'draining') {
    const b = due.find(x => PERSON_DRIVEN.has(x.trigger));
    return b ? { trigger: b.trigger, task: b.task, bookingId: b.id } : null;
  }
  if (st.backoff_until && st.backoff_until > now) return null;
  // The runaway backstop - never the pace.
  if (runsToday(agent.id, now) >= backstop(agent, st.ferocity)) return null;
  if (due.length) return { trigger: due[0].trigger, task: due[0].task, bookingId: due[0].id };
  if (st.ferocity === APOCALYPTIC) {
    const last = one<{ ended_at: number | null }>('SELECT ended_at FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1', agent.id);
    if (last?.ended_at && now - last.ended_at < APOCALYPTIC_GAP_MS) return null;
    return { trigger: 'apocalyptic', task: null };
  }
  const scheduled = scheduledDue(agent, st.ferocity, st.last_scheduled_at, now);
  return scheduled != null && scheduled <= now ? { trigger: 'scheduled', task: null } : null;
}

function start(agent: AgentDef, trigger: Trigger, task: string | null, deps: RunDeps, connection: string | null) {
  const now = deps.now();
  const controller = new AbortController();
  running.set(agent.id, { controller, connection, startedAt: now });
  void runAgent(agent, trigger, task, deps, controller.signal)
    .catch(e => console.error(`Run of ${agent.id} crashed:`, (e as Error).message))
    .finally(() => {
      running.delete(agent.id);
      void tick(deps);
    });
}

// Stop: the run going now is cut short.
export function abortRun(agentId: string) {
  running.get(agentId)?.controller.abort();
}

let timer: NodeJS.Timeout | null = null;
export function startScheduler() {
  void loadIntegrations().catch(e => console.error('Loading integrations failed:', (e as Error).message));
  // Runs left 'running' by a server that stopped mid-run.
  exec("UPDATE runs SET status = 'failed', error = 'The server stopped during this run.', ended_at = started_at WHERE status = 'running'");
  timer ??= setInterval(() => void tick().catch(e => console.error('Runner tick failed:', (e as Error).message)), TICK_MS);
}
export const stopScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
