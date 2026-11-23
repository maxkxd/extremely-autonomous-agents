import { listIds, readMeta } from '../files.js';
import { describeTrip, endWatch, GRACE_MS, sweep, watched } from './watchdog.js';
import { liveEvents, loadIntegrations, recheckStale } from '../integrations/index.js';
import './web.js'; // registers the web tools
import { accountsTick } from './browser.js'; // also registers the browser tools
import './computer.js'; // registers the tools for files on this computer
import { ensureBrowserKit, ensureFleetEngineer, startEngineer } from './engineer.js';
import { ensureDoctor } from './doctor.js';
import './conductor.js'; // routes new requests
import { BUILT_IN_IDS, ensureHelpers, fillBuiltInModels, HELPER_IDS } from './helpers.js';
import { hookToken, pollEvents } from './events.js';
import { hooksBase } from './hooks.js';
import { availableModels, nativeEffortSync } from '../models/connections.js';
import { allChecks } from '../models/check.js';
import { choiceKey } from '../models/health.js';
import type { ModelChoice } from '../models/choice.js';
import { FLEET_ENGINEER, loadAgent, type AgentDef } from './agent.js';
import { expireApprovals, recoverInterruptedActions, runDueActions, setQueueWake } from './approvals.js';
import { all, getSetting, one, run as exec, setSetting } from './db.js';
import { backstop, HOUR, parallelSlots, scheduledDue, STEADY } from './ferocity.js';
import { bookGoalRuns, GOAL_BATCH, goalDue, paceFor } from './goals.js';
import { conductPace } from './conductor.js';

import { resumeDue, runsToday as runsOnDay } from './selfsettings.js';
import { bookWake, dropWakeParts, formatWake, isDebounced, parseWake, requestOf, triggerFor, WAKE_WINDOWS, type Part } from './wakes.js';

import { fileRequest, settleJoined, toolsFor } from './tools.js';
import { costOf, isFree, spentThisMonth, startOfDay } from './pricing.js';
import { harnessFor } from './harness.js';
import { adapterFor } from './providers.js';
import { eligibleModels, runAgent, stateOf, type RunDeps, type Trigger } from './run.js';
import { holdsBack, memoryBrake, memoryFraction } from './pressure.js';

// Decides when each agent runs (docs/runner.md). Every tick, for each agent
// that isn't running: a booking that's due (your messages first), else the next
// run its goals' pace calls for (goals.ts; a built-in: its own schedule). An
// agent with no goal does not run at all - only a person's message is answered -
// and the Agency Engineer is asked, once, to give it one. One run per agent at a
// time (the Agency Engineer: a few, on different requests; an agent behind on
// its goal: as many as its pace says); a few at once overall, and one
// local-model run at a time (a laptop can't hold two). Failing agents back off;
// the backstop is only for runaways.

const TICK_MS = 5_000;
export const MAX_PARALLEL = 32;
// A new agency files ~50 setup requests; one at a time, the last agents waited
// over an hour. Its extra runs don't take the agents' places.
export const ENGINEER_PARALLEL = 8;

type Running = { agentId: string; parallel?: boolean; controller: AbortController; connection: string | null; startedAt: number; requests: number[]; services: string[] };
// Keyed by run: an agent's id, or the engineer's id and a slot.
const running = new Map<string, Running>();
export const isRunning = (agentId: string) => [...running.values()].some(r => r.agentId === agentId);
const runsOf = (agentId: string) => [...running.values()].filter(r => r.agentId === agentId);

// What an engineer run is about: the requests its task names, and their services.
// None named (a batch of approvals, its own schedule): it could touch anything.
export function engineerScope(task: string | null): { requests: number[]; services: string[] } {
  const requests = [...new Set([...(task ?? '').matchAll(/#(\d+)|request_id: (\d+)/g)].map(m => Number(m[1] ?? m[2])))];
  const services = requests.length
    ? all<{ service: string | null; waiting_on: string | null }>(`SELECT service, waiting_on FROM requests WHERE id IN (${requests.map(() => '?').join(',')})`, ...requests)
        .flatMap(r => [r.service, r.waiting_on])
        .filter((x): x is string => !!x)
    : [];
  return { requests, services: [...new Set(services)] };
}

// Another engineer run can start beside these if it's on other requests and other
// services (two at once would draft the same connection twice). One that names no
// request runs alone - except a person's message, which never waits.
export function engineerCanJoin(alongside: { requests: number[]; services: string[] }[], next: { trigger: string; task: string | null }): boolean {
  if (!alongside.length) return true;
  if (next.trigger === 'your message') return true;
  const scope = engineerScope(next.task);
  if (!scope.requests.length || alongside.some(r => !r.requests.length)) return false;
  return !alongside.some(r => r.requests.some(x => scope.requests.includes(x)) || r.services.some(x => scope.services.includes(x)));
}

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

// The Agency Engineer's queued runs for requests that have since closed (turned
// down, handed over, or their agent deleted): dropped, not run - a whole run
// just to find the request gone.
// Also a reply already answered: replies sent while it was working on that
// request queue a run, but it reads the whole conversation (list_requests) - if
// it read it after they came and answered since, they've had their answer.
// A booking gathers several events (wakes.ts): only the parts about such requests
// go; the rest still run, and the booking goes only once nothing is left.
export function dropStaleRequestRuns() {
  dropWakeParts(FLEET_ENGINEER, (p, b) => {
    if (p.trigger !== 'request' && p.trigger !== 'request reply' && p.trigger !== 'connected') return false;
    const request = requestOf(p.text);
    if (!request) return false;
    const open = one<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE id = ? AND status = 'open'", request)?.n;
    if (!open) return true;
    if (p.trigger !== 'request reply') return false;
    // The latest reply it's for, and whether the engineer read the conversation after it, then answered.
    const lastReply = one<{ at: number | null }>("SELECT MAX(at) AS at FROM request_messages WHERE request_id = ? AND from_who = 'you'", request)?.at ?? b.created_at;
    const read = one<{ at: number | null }>("SELECT MIN(at) AS at FROM actions WHERE agent_id = ? AND tool = 'engineer.list_requests' AND at >= ?", FLEET_ENGINEER, lastReply)?.at;
    return !!(read != null && one<{ n: number }>("SELECT COUNT(*) AS n FROM request_messages WHERE request_id = ? AND from_who = 'engineer' AND at > ?", request, read)?.n);
  });
}

// Kept for the approval code and its tests: an approval's own debounce (wakes.ts).
export const APPROVAL_SETTLE_MS = WAKE_WINDOWS.approval.settleMs;
export const APPROVAL_MAX_WAIT_MS = WAKE_WINDOWS.approval.maxMs;

// A run to start (handoffs, your messages, Run now...). Every event-driven wake is
// debounced and joins the one already waiting (wakes.ts): a burst of handoffs,
// requests, results and approvals is one run, not one each. Run now and a run it
// booked itself start when they're due.
// dueAt: when it can start; for a debounced wake, when the event happened (it's due a
// settle after).
// person: whose message it answers - the Agency Engineer keeps one chat per person.
//
// The agent's own-work slot (its schedule, a run it booked itself, request done, Run
// now) holds at most one pending booking: ticks that come due while a run is in
// flight collapse into one start when it finishes, they never pile up. A later
// Run now upgrades a waiting scheduled tick, so a person asking for a run is not eaten.
const MAIN_SLOT = ['run now', 'scheduled', 'self-booked', 'request done'] as const;
type MainSlot = (typeof MAIN_SLOT)[number];
const isMainSlot = (t: Trigger): t is MainSlot => (MAIN_SLOT as readonly string[]).includes(t);
export function pendingMain(agentId: string) {
  return one<{ id: number; trigger: MainSlot }>(
    `SELECT id, trigger FROM bookings WHERE agent_id = ? AND trigger IN (${MAIN_SLOT.map(() => '?').join(',')}) ORDER BY CASE WHEN trigger = 'run now' THEN 0 ELSE 1 END, due_at, id`,
    agentId,
    ...MAIN_SLOT,
  );
}
export function book(agentId: string, trigger: Trigger, task: string | null, dueAt = Date.now(), person: string | null = null) {
  if (isDebounced(trigger)) return bookWake(agentId, trigger, task, dueAt, person);
  if (isMainSlot(trigger)) {
    const cur = pendingMain(agentId);
    if (cur) {
      if (trigger === 'run now' && cur.trigger !== 'run now')
        exec('UPDATE bookings SET trigger = ?, task = ?, due_at = ?, person_id = ? WHERE id = ?', trigger, task, dueAt, person, cur.id);
      return;
    }
  }
  exec('INSERT INTO bookings (agent_id, trigger, task, due_at, created_at, person_id) VALUES (?, ?, ?, ?, ?, ?)', agentId, trigger, task, dueAt, Date.now(), person);
}

export const RUN_NOW_IN_FLIGHT = 'A run is already in progress. Another will start when it finishes.';
export const RUN_NOW_QUEUED = 'A run is already queued and will start shortly.';
export function queueRunNow(agentId: string, now = Date.now()): { ok: true; queued?: boolean; message?: string } {
  const running = !!one("SELECT 1 AS x FROM runs WHERE agent_id = ? AND status = 'running'", agentId);
  const pending = pendingMain(agentId);
  if (running) {
    book(agentId, 'run now', null, now);
    return { ok: true, queued: true, message: RUN_NOW_IN_FLIGHT };
  }
  if (pending?.trigger === 'run now') return { ok: true, queued: true, message: RUN_NOW_QUEUED };
  book(agentId, 'run now', null, now);
  return { ok: true };
}

// While a main run is in flight, a due scheduled tick becomes one pending booking
// (or joins the one already waiting). It starts as soon as the current run finishes.
export function ensurePendingDue(agent: AgentDef, pace: NonNullable<ReturnType<typeof paceFor>>, st: ReturnType<typeof stateOf>, now: number) {
  if (pendingMain(agent.id)) return;
  const last = one<{ ended_at: number | null }>("SELECT ended_at FROM runs WHERE agent_id = ? AND status != 'running' ORDER BY started_at DESC LIMIT 1", agent.id);
  if (goalDue(pace, st.last_scheduled_at ?? last?.ended_at ?? null, last?.ended_at ?? null, now, pace.parallel > 1)) book(agent.id, 'scheduled', null, now);
}

// Approved actions are run by the queue (approvals.ts), which wakes agents through here.
setQueueWake((agentId, trigger, task) => book(agentId, trigger as Trigger, task));

const runsToday = (agentId: string, now: number) =>
  one<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND started_at >= ?', agentId, startOfDay(now))?.n ?? 0;

let ticking = false;
export async function tick(deps: RunDeps = liveDeps) {
  if (ticking) return;
  ticking = true;
  try {
    watchdogTick(deps.now());
    models = await availableModels();
    checks = await allChecks();
    await fillBuiltInModels().catch(() => {});
    noAiRequest(models.length > 0, deps.now());
    capRequest(models.map(m => m.connection), deps.now());
    hookAddressRequest(hooksBase(), liveEvents().filter(e => e.event.webhook).map(e => ({ service: e.integration.name, id: e.event.id })), deps.now());
    const now = deps.now();
    resumeDue(now); // agents that paused themselves "until Monday"
    // Connections nobody has checked in a day, checked in the background (a broken one
    // goes to the Agency Engineer) - not only when someone opens Settings.
    void recheckStale()?.catch(() => {});
    expireApprovals(now, book);
    // Approved actions whose time has come (action-queue.ts): in the background, one at a
    // time per account, never holding up a tick.
    runDueActions({ wake: (agentId, trigger, task) => book(agentId, trigger as Trigger, task), load: loadAgent, now: deps.now });
    dropStaleRequestRuns();
    // Requests that joined another agent's (one per connection), once it's settled.
    settleJoined((agentId, trigger, task) => book(agentId, trigger as Trigger, task), now);
    // Accounts agents owe (accounts.ts): put right after whatever happened, and each
    // one nobody is on has its agent woken for it - at any ferocity.
    void accountsTick((agentId, trigger, task) => book(agentId, trigger as Trigger, task), now).catch(e => console.error('Checking the accounts agents owe failed:', (e as Error).message));
    // Events due a check (events.ts): in the background, so a slow service never holds up a tick.
    void pollEvents(book).catch(e => console.error('Polling events failed:', (e as Error).message));
    // Memory nearly full (pressure.ts): runs already going carry on, but no new one
    // starts until it drops. What's booked or due waits; nothing is dropped.
    // The Agency Conductor looks over every agent's goals now and then (conductor.ts).
    void conductPace(now).catch(e => console.error('Pacing agents to their goals failed:', (e as Error).message));
    const braked = memoryBrake.update(await memoryFraction());
    for (const id of await listIds()) {
      const engineer = id === FLEET_ENGINEER;
      const others = runsOf(id);
      // The engineer's extra runs don't count against the agents.
      if (!engineer && running.size - Math.max(0, runsOf(FLEET_ENGINEER).length - 1) >= MAX_PARALLEL) break;
      if (engineer && others.length >= ENGINEER_PARALLEL) continue;
      const meta = await readMeta(id);
      // Helpers run only when called (quick.ts).
      if (!meta || meta.status === 'setting-up' || meta.service) continue;
      const st = stateOf(id, now);
      // Stopped: nothing runs at all (what's booked waits for it to be turned back on).
      if (st.state === 'stopped') continue;
      const agent = await loadAgent(id);
      if (!agent) continue;
      // Its goals' pace (goals.ts): behind enough to need several runs at once, the others
      // are booked here; at its goal or with none, any still waiting are dropped.
      const builtIn = engineer || BUILT_IN_IDS.includes(id);
      const pace = builtIn ? null : paceFor(agent, now);
      // No goal: it does not run, and the Agency Engineer is asked once to give it one.
      if (!builtIn) noGoalRequest(agent, !!pace, now);
      // Not on a day its person said it doesn't work: those runs are its schedule's too.
      if (pace && pace.parallel > 1 && st.state === 'active' && runsOnDay(id, now)) bookGoalRuns(agent, pace, now);
      else if (!engineer) exec("DELETE FROM bookings WHERE agent_id = ? AND trigger = 'parallel' AND task LIKE ?", id, `${GOAL_BATCH}%`);
      // An agent already running: only its own parallel runs (ops.start_parallel_run, any level)
      // start beside it, up to its level's slots - and its main run, if what's
      // going are only parallel ones. Everything else waits for its run to end, as before.
      if (!engineer && others.length) {
        const room = others.filter(r => r.parallel).length < Math.max(parallelSlots(pace?.level ?? STEADY), (pace?.parallel ?? 1) - 1);
        const mainGoing = others.some(r => !r.parallel);
        if (mainGoing && pace && st.state === 'active') ensurePendingDue(agent, pace, st, now);
        const next = nextRun(agent, st, now, b => (b.trigger === 'parallel' ? room : !mainGoing));
        if (!next || (next.trigger === 'parallel' ? !next.bookingId : mainGoing)) continue;
        const eligible = eligibleModels(agent, deps);
        if (!eligible.length) continue;
        if (eligible[0]?.connection === 'ollama' && [...running.values()].some(r => r.connection === 'ollama')) continue;
        if (holdsBack(braked, running.size)) continue;
        if (next.bookingId) {
          if (next.rest?.length) exec('UPDATE bookings SET task = ?, trigger = ? WHERE id = ?', formatWake(next.rest), triggerFor(next.rest, next.trigger), next.bookingId);
          else exec('DELETE FROM bookings WHERE id = ?', next.bookingId);
        }
        if (next.trigger === 'scheduled' || next.trigger === 'self-booked' || next.trigger === 'request done' || next.trigger === 'run now')
          exec('UPDATE agent_state SET last_scheduled_at = ? WHERE agent_id = ?', now, id);
        start(agent, next.trigger, next.task, deps, eligible[0]?.connection ?? null);
        continue;
      }
      // The engineer beside its own runs: only booked work that doesn't overlap them
      // (one more each tick). Next in line is work that runs alone (approvals): the
      // others finish first, rather than it waiting behind the whole queue.
      if (others.length) {
        const head = nextRun(agent, st, now);
        if (head?.bookingId && head.trigger !== 'your message' && !engineerScope(head.task).requests.length) continue;
      }
      const next = nextRun(agent, st, now, others.length ? b => engineerCanJoin(others, b) : undefined);
      if (!next) continue;
      if (others.length && !next.bookingId) continue;
      const eligible = eligibleModels(agent, deps);
      // Nothing it can run on: wait (a message still gets an answer saying why).
      if (!eligible.length && next.trigger !== 'your message') continue;
      const local = eligible[0]?.connection === 'ollama';
      if (local && [...running.values()].some(r => r.connection === 'ollama')) continue;
      // Memory nearly full: it waits (its booking stays, its schedule keeps counting) and starts once memory drops.
      if (holdsBack(braked, running.size)) continue;
      const booked = next.bookingId ? one<{ r: string | null; p: string | null }>('SELECT resume_from AS r, person_id AS p FROM bookings WHERE id = ?', next.bookingId) : null;
      const resumeFrom = booked?.r ?? null;
      if (next.rest?.length) exec('UPDATE bookings SET task = ?, trigger = ? WHERE id = ?', formatWake(next.rest), triggerFor(next.rest, next.trigger), next.bookingId!);
      else if (next.bookingId) exec('DELETE FROM bookings WHERE id = ?', next.bookingId);
      // A run it booked itself counts as its scheduled run: the schedule's clock
      // restarts, so booking a run never adds one on top of its pace.
      if (next.trigger === 'scheduled' || next.trigger === 'self-booked' || next.trigger === 'request done' || next.trigger === 'run now')
        exec('UPDATE agent_state SET last_scheduled_at = ? WHERE agent_id = ?', now, id);
      start(agent, next.trigger, next.task, deps, eligible[0]?.connection ?? null, resumeFrom, booked?.p ?? null);
    }
  } finally {
    ticking = false;
  }
}

// No AI connected at all (skipped on the first screen, or the only one removed):
// nothing can run - not the agents, not the Agency Engineer setting their
// connectors up, which otherwise just said "Setting up" for ever. One request to
// the person while it lasts, once there's something waiting on it.
const NO_AI_WHAT = 'Connect an AI model - nothing can run without one';
export function noAiRequest(connected: boolean, now: number) {
  const open = one<{ id: number }>("SELECT id FROM requests WHERE what = ? AND status = 'open'", NO_AI_WHAT);
  if (connected) {
    if (open) exec("UPDATE requests SET status = 'done', answer = 'An AI model is connected.', answered_at = ?, stage = NULL WHERE id = ?", now, open.id);
    return;
  }
  // A Run now pressed with no model can't start: dropped, not left saying "Queued" for ever.
  exec("DELETE FROM bookings WHERE trigger = 'run now'");
  if (open) return;
  const waiting = one<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE status = 'open' AND stage = 'engineer'")?.n ?? 0;
  const agents = one<{ n: number }>(`SELECT COUNT(*) AS n FROM agent_state WHERE agent_id NOT IN (${BUILT_IN_IDS.map(() => '?').join(', ')})`, ...BUILT_IN_IDS)?.n ?? 0;
  if (!waiting && !agents) return;
  fileRequest(
    FLEET_ENGINEER,
    null,
    {
      what: NO_AI_WHAT,
      why: `No AI model is connected, so none of your agents can run, and the Agency Engineer can't set up what they're waiting on${waiting ? ` (${waiting} request${waiting === 1 ? '' : 's'})` : ''}. Connect one in Settings > Connectors: your Claude, ChatGPT or Copilot plan, or an API key. Everything starts again by itself once one works.`,
    },
    now,
    () => {},
  );
}

// The agency's monthly spending limit reached with only pay-per-use AI connected
// (a $0 limit "to be safe"): nothing runs - not the Agency Engineer either, so a
// new agent's setup sat at "Setting up" - and only each card said why.
const CAP_WHAT = "This month's AI spending limit is reached - nothing can run";
export function capRequest(connections: string[], now: number) {
  const cap = getSetting<number | null>('spend_cap_org_usd', null);
  const blocked = cap != null && spentThisMonth(now) >= cap && connections.length > 0 && !connections.some(isFree);
  const open = one<{ id: number }>("SELECT id FROM requests WHERE what = ? AND status = 'open'", CAP_WHAT);
  if (!blocked) {
    if (open) exec("UPDATE requests SET status = 'done', answer = 'Agents can run again.', answered_at = ?, stage = NULL WHERE id = ?", now, open.id);
    return;
  }
  if (open) return;
  fileRequest(
    FLEET_ENGINEER,
    null,
    {
      what: CAP_WHAT,
      why: `The agency's limit of $${cap!.toFixed(2)} for this month is reached, and every AI connected is pay-per-use, so no agent can run - the Agency Engineer included. Raise or remove the limit (Settings > Usage), or connect an AI plan you already pay for (Claude, ChatGPT or Copilot), which the limit doesn't apply to. Otherwise everything starts again next month.`,
    },
    now,
    () => {},
  );
}

// An ordinary agent with no goal (none of its outputs has a number) does not run: no
// schedule, no bookings, no Run now. The Agency Engineer is asked to give it a sensible
// number straight away - never a person. The request closes by itself once the agent has
// a goal. If the Engineer closes it without setting one, it is asked again after a
// cooldown (1 hour, then 6 hours, then daily) so the agent is not left without a goal
// and the Engineer is not spammed. A later goal resets the backoff.
const NO_GOAL_ASKED = 'no_goal_asked'; // agent -> { id, attempts, nextAt }
const NO_GOAL_BACKOFF_MS = [HOUR, 6 * HOUR, 24 * HOUR];
type NoGoalAsk = { id: number; attempts: number; nextAt: number };
const asAsk = (raw: unknown): NoGoalAsk | null => {
  if (raw == null) return null;
  if (typeof raw === 'number') return { id: raw, attempts: 0, nextAt: 0 };
  const o = raw as NoGoalAsk;
  return typeof o.id === 'number' ? { id: o.id, attempts: o.attempts ?? 0, nextAt: o.nextAt ?? 0 } : null;
};
export const noGoalWhat = (name: string) => `Set a goal for ${name}: it has none, so it is not running`;
const noGoalWhy = (name: string) =>
  `Every agent needs a goal: a number of one of its outputs an hour, a day, a week, a month or a year. ${name} has none, so it will not run until it has one - no schedule, no Run now; only a person's message is answered. Read its Charter and KPI (engineer.read_agent) and set a sensible basic number for an ordinary pace of that job with engineer.set_goal straight away. Do not close this without setting a number. Ask the person only if the number really matters to them; otherwise they can change it on the agent's card later.`;

function fileNoGoal(agent: AgentDef, now: number, attempts: number, asked: Record<string, NoGoalAsk>) {
  const id = fileRequest(
    agent.id,
    null,
    { what: noGoalWhat(agent.name), why: noGoalWhy(agent.name) },
    now,
    (a, t, k) => book(a, t as Trigger, k),
    true, // straight to the Agency Engineer: there is nothing here to route
  );
  asked[agent.id] = { id, attempts, nextAt: 0 };
  setSetting(NO_GOAL_ASKED, asked);
}

export function noGoalRequest(agent: AgentDef, has: boolean, now: number) {
  const asked = getSetting<Record<string, number | NoGoalAsk>>(NO_GOAL_ASKED, {});
  const cur = asAsk(asked[agent.id]);
  if (has) {
    if (!cur) return;
    exec("UPDATE requests SET status = 'done', answer = 'It has a goal now.', answered_at = ?, stage = NULL WHERE id = ? AND status = 'open'", now, cur.id);
    delete asked[agent.id];
    setSetting(NO_GOAL_ASKED, asked);
    return;
  }
  if (cur) {
    const row = one<{ status: string }>('SELECT status FROM requests WHERE id = ?', cur.id);
    if (row?.status === 'open') return; // at most one open request per agent
    // The Engineer closed it (or it vanished) without a goal: wait, then ask again.
    if (!cur.nextAt) {
      const wait = NO_GOAL_BACKOFF_MS[Math.min(cur.attempts, NO_GOAL_BACKOFF_MS.length - 1)];
      asked[agent.id] = { ...cur, nextAt: now + wait };
      setSetting(NO_GOAL_ASKED, asked);
      return;
    }
    if (now < cur.nextAt) return;
    fileNoGoal(agent, now, cur.attempts + 1, asked as Record<string, NoGoalAsk>);
    return;
  }
  fileNoGoal(agent, now, 0, asked as Record<string, NoGoalAsk>);
}

// The tunnel's address changes each time it starts (a quick tunnel: no account), and every
// service posting events was given the old one - so they all stop arriving, silently. Said
// to the person once per change, with each new address and where it goes.
const HOOK_WHAT = 'The address for your webhooks changed - paste the new one into each service';
export function hookAddressRequest(base: string, hooks: { service: string; id: string }[], now: number) {
  const known = getSetting<string | null>('hooks_base_known', null);
  if (base === known) return;
  setSetting('hooks_base_known', base);
  const open = one<{ id: number }>("SELECT id FROM requests WHERE what = ? AND status = 'open'", HOOK_WHAT);
  if (open) exec("UPDATE requests SET status = 'done', answer = 'The address changed again; see the newer request.', answered_at = ?, stage = NULL WHERE id = ?", now, open.id);
  // Only a public address that replaced another, with services set up to post to it.
  if (!known || !base.startsWith('https://') || !hooks.length) return;
  const lines = hooks.map(h => `- ${h.service}: ${base}/hooks/${hookToken(h.id)}`).join('\n');
  fileRequest(
    FLEET_ENGINEER,
    null,
    {
      what: HOOK_WHAT,
      why: `The webhook address changes each time the app starts its tunnel (after a restart, say), so these services are still posting to the old one and their events aren't arriving. In each service's webhook settings, replace the address with the new one:\n${lines}\nEvents they also poll for are still caught meanwhile, just later. Mark this done once they're replaced.`,
    },
    now,
    () => {},
  );
}

// rest: what stays booked when only part of a booking runs now (on standby).
type Next = { trigger: Trigger; task: string | null; bookingId?: number; rest?: Part[] };

// What a person set off, which an agent on standby still runs: their message,
// Run now, hearing how an approval it queued was decided, and (the Fleet
// Engineer) their reply on a request or a service they just connected.
const PERSON_DRIVEN = new Set<Trigger>(['your message', 'run now', 'approval', 'request reply', 'turned down', 'connected']);

// The run an agent should start now, if any.
//   active   - its schedule, its own bookings, handoffs, and anything a person sets off
//   draining - finishes the run it's in; starts nothing itself, but still answers a
//              person, runs Run now, and hears approval outcomes
//   stopped  - nothing; the run it was in was cut short (bookings wait)
//   no goal  - an ordinary agent with no goal starts nothing either: only a person's
//              message is answered (bookings wait until it has one)
export function nextRun(agent: AgentDef, st: ReturnType<typeof stateOf>, now: number, fits?: (b: { trigger: Trigger; task: string | null }) => boolean): Next | null {
  if (st.state === 'stopped') return null;
  const listed = all<{ id: number; trigger: Trigger; task: string | null }>(
    // A person's message first; then a tool agents already rely on that's broken
    // (it waited an hour behind 23 new builds), then the rest in order.
    "SELECT id, trigger, task FROM bookings WHERE agent_id = ? AND due_at <= ? ORDER BY CASE WHEN trigger = 'your message' THEN 0 WHEN task LIKE '%: Fix the tool %' THEN 1 ELSE 2 END, due_at, id",
    agent.id,
    now,
  );
  const due = fits ? listed.filter(fits) : listed;
  // A person's message is answered even when the agent is stopped or backing off.
  const message = due.find(b => b.trigger === 'your message');
  if (message) return { trigger: message.trigger, task: message.task, bookingId: message.id };
  // No goal, no runs (goals.ts): what is booked waits, as it would for a stopped agent.
  const builtIn = BUILT_IN_IDS.includes(agent.id);
  const pace = builtIn ? null : paceFor(agent, now);
  if (!builtIn && !pace) return null;
  if (st.state === 'draining') {
    // A wake that gathered several events (wakes.ts): only what a person set off runs
    // now; the rest stays booked for when it's active again.
    for (const b of due) {
      const parts = parseWake(b.trigger, b.task);
      const mine = parts.filter(p => p.trigger !== 'more' && PERSON_DRIVEN.has(p.trigger));
      if (!mine.length) continue;
      if (mine.length === parts.length) return { trigger: b.trigger, task: b.task, bookingId: b.id };
      return { trigger: triggerFor(mine, b.trigger), task: formatWake(mine), bookingId: b.id, rest: parts.filter(p => !mine.includes(p)) };
    }
    return null;
  }
  // Run now is a person asking for a run this minute: not held back by a failure
  // backoff or the runaway backstop (it spun, then did nothing, after a few failures).
  const runNow = due.find(b => b.trigger === 'run now');
  if (runNow) return { trigger: runNow.trigger, task: runNow.task, bookingId: runNow.id };
  if (st.backoff_until && st.backoff_until > now) return null;
  // The runaway backstop - never the pace. Built-ins have none: their work comes
  // from requests, and failure backoff still stops one that keeps failing.
  if (pace && runsToday(agent.id, now) >= backstop(pace.level)) return null;
  if (due.length) return { trigger: due[0].trigger, task: due[0].task, bookingId: due[0].id };
  // Its person said which days it works ("only on weekdays"): none of its own on the others.
  if (!runsOnDay(agent.id, now)) return null;
  // Whatever is or isn't connected yet: a new agent waits for its tools stopped
  // (setup.ts), so one running without them was resumed on purpose.
  const last = one<{ ended_at: number | null }>("SELECT ended_at FROM runs WHERE agent_id = ? AND status != 'running' ORDER BY started_at DESC LIMIT 1", agent.id);
  // Its goals' pace says when its next run is due.
  if (pace) return goalDue(pace, st.last_scheduled_at ?? last?.ended_at ?? null, last?.ended_at ?? null, now) ? { trigger: 'scheduled', task: null } : null;
  // A built-in keeps its own schedule.
  const scheduled = scheduledDue(agent, STEADY, st.last_scheduled_at ?? last?.ended_at ?? null, now, true);
  return scheduled != null && scheduled <= now ? { trigger: 'scheduled', task: null } : null;
}

export function blockedOnConnections(agent: AgentDef) {
  const real = agent.ferocity.counts.filter(c => !c.startsWith('files.'));
  if (!real.length) return false;
  const callable = new Set(toolsFor(agent).ids.values());
  return !real.some(c => callable.has(c));
}

function start(agent: AgentDef, trigger: Trigger, task: string | null, deps: RunDeps, connection: string | null, resumeFrom: string | null = null, person: string | null = null) {
  const now = deps.now();
  const controller = new AbortController();
  const engineer = agent.id === FLEET_ENGINEER;
  const parallel = trigger === 'parallel';
  const key = engineer || parallel ? `${agent.id}#${++slot}` : agent.id;
  running.set(key, { agentId: agent.id, parallel, controller, connection, startedAt: now, ...(engineer ? engineerScope(task) : { requests: [], services: [] }) });
  void runAgent(agent, trigger, task, deps, controller.signal, resumeFrom, person)
    .catch(e => console.error(`Run of ${agent.id} crashed:`, (e as Error).message))
    .finally(() => {
      running.delete(key);
      void tick(deps);
    });
}
let slot = 0;

// The watchdog (watchdog.ts): a run idle for 20 min, or past the 4-hour ceiling,
// is aborted; one that doesn't let go within GRACE_MS is freed here and its row
// marked failed, and its agent booked straight back in; a row left 'running'
// with nothing behind it (its run lost without a restart) is swept the same way.
// So no agent is ever held by a run that has stopped.
let lastOrphanSweep = 0;
export function watchdogTick(now: number) {
  for (const w of sweep(now)) {
    const entry = [...running.values()].find(r => r.controller.signal === w.signal);
    console.error(`[watchdog] ${w.agentId} run ${w.runId}: ${w.trip ? describeTrip(w.trip) : ''}`);
    entry?.controller.abort();
  }
  for (const w of watched()) {
    if (!w.trip || now - w.trip.at < GRACE_MS) continue;
    const key = [...running.entries()].find(([, r]) => r.controller.signal === w.signal)?.[0];
    if (key) running.delete(key);
    const why = `${describeTrip(w.trip)} It didn't let go when stopped, so it was cut loose.`;
    exec("UPDATE runs SET status = 'failed', error = ?, ended_at = ? WHERE id = ? AND status = 'running'", why, now, w.runId);
    endWatch(w.runId);
    book(w.agentId, 'self-booked', `${why} Pick up where that run left off: check what it already finished and carry on with the rest.`, now);
  }
  if (now - lastOrphanSweep < 60_000) return;
  lastOrphanSweep = now;
  const live = new Set(watched().map(w => w.runId));
  for (const r of all<{ id: string; agent_id: string; started_at: number }>("SELECT id, agent_id, started_at FROM runs WHERE status = 'running'")) {
    if (live.has(r.id) || isRunning(r.agent_id) || now - r.started_at < 10 * 60_000) continue;
    exec("UPDATE runs SET status = 'failed', error = 'The run was lost - nothing was running it any more.', ended_at = ? WHERE id = ? AND status = 'running'", now, r.id);
  }
}

// Stop: the runs going now are cut short.
export function abortRun(agentId: string) {
  for (const r of runsOf(agentId)) r.controller.abort();
}
export const abortAll = () => {
  for (const r of running.values()) r.controller.abort();
};

let timer: NodeJS.Timeout | null = null;
export function startScheduler() {
  // Nothing runs until connections have loaded: a run or an approved send in the first
  // seconds after a start found every connected tool missing and failed for good.
  const ready = loadIntegrations().catch(e => console.error('Loading integrations failed:', (e as Error).message));
  // The Agency Engineer: its files kept current, and woken by requests and connections.
  void ensureFleetEngineer()
    .then(() => startEngineer(book))
    .catch(e => console.error('Starting the Agency Engineer failed:', (e as Error).message));
  void ensureBrowserKit().catch(e => console.error('Giving agents the browser failed:', (e as Error).message));
  void ensureHelpers().catch(e => console.error('Setting up the Agency Conductor and Agency Reviewer failed:', (e as Error).message));
  // The Agency Doctor: a look at the whole fleet every couple of hours (doctor.ts).
  void ensureDoctor().catch(e => console.error('Setting up the Agency Doctor failed:', (e as Error).message));
  // Runs left 'running' by a server that stopped mid-run. One a person or an
  // event set off (a message, a connection, an approval...) is booked again,
  // or it would be lost; scheduled ones simply come round again.
  // Run now on a helper was booked and never ran (they work only when called).
  exec(`DELETE FROM bookings WHERE trigger = 'run now' AND agent_id IN (${HELPER_IDS.map(() => '?').join(', ')})`, ...HELPER_IDS);
  // Approved actions it was running: never run twice - their agents are told (approvals.ts).
  recoverInterruptedActions(Date.now(), (agentId, trigger, task) => book(agentId, trigger as Trigger, task));
  const cut = all<{ id: string; agent_id: string; trigger: Trigger; task: string | null }>("SELECT id, agent_id, trigger, task FROM runs WHERE status = 'running'");
  exec("UPDATE runs SET status = 'failed', error = 'The server stopped during this run.', ended_at = started_at WHERE status = 'running'");
  // A helper's call isn't a run to start again: whoever called it already moved on.
  // It picks up where it was: told what it already did, so nothing is done twice.
  for (const r of cut)
    if (!['scheduled', 'apocalyptic'].includes(r.trigger) && !HELPER_IDS.includes(r.agent_id))
      exec('INSERT INTO bookings (agent_id, trigger, task, due_at, created_at, resume_from) VALUES (?, ?, ?, ?, ?, ?)', r.agent_id, r.trigger, r.task, Date.now(), Date.now(), r.id);
  void ready.then(() => {
    timer ??= setInterval(() => void tick().catch(e => console.error('Runner tick failed:', (e as Error).message)), TICK_MS);
  });
}
export const stopScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};
