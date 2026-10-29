import { randomBytes } from 'node:crypto';
import { listIds, readMeta } from '../files.js';
import { loadPerson, loadProfile, profileForPrompt } from '../org.js';
import { fitEffort } from '../models/caps.js';
import type { Effort, ModelChoice } from '../models/choice.js';
import { pickModel, recordFailure, recordSuccess, choiceKey, type Health } from '../models/health.js';
import type { AgentDef } from './agent.js';
import { all, getSetting, one, run as exec, setSetting } from './db.js';
import { backoffMs, ferocityInstructions, floorFor, nudgeText, LEVELS } from './ferocity.js';
import { ago, COMPACT_PROMPT, compactIfNeeded, memoryForPrompt } from './memory.js';
import { costOf, isFree, spentToday } from './pricing.js';
import { hostZone } from './clock.js';
import type { Harness } from './harness.js';
import { ModelError, type Adapter, type Msg } from './providers.js';
import { execute, runEnded, toolHealth, toolsFor, type RunCtx } from './tools.js';

// One run of one agent (docs/runner.md, "One run"): its instructions, the
// tool loop on its first working model, the floor and its nudges, then the
// record and its post in the agent's DM channel.

export type Trigger = 'scheduled' | 'self-booked' | 'apocalyptic' | 'handoff' | 'your message' | 'approval' | 'run now' | 'request' | 'request reply' | 'connected';

// What a run needs from outside, so tests can stand it up without a network.
export type RunDeps = {
  now: () => number;
  adapter: (connection: string) => Adapter | null;
  harness: (connection: string) => Harness | null; // plans with their own agent loop
  // The model, if it can be used now: connected, not failed its check.
  modelInfo: (c: ModelChoice) => { usable: boolean; efforts: Effort[]; native?: Partial<Record<Effort, string>> };
  cost: (connection: string, model: string, input: number, output: number) => Promise<number | null>;
  wake: (agentId: string, trigger: Trigger, task: string) => void;
  compact: boolean; // compact memory after the run (off in tests)
};

export const MAX_STEPS = 150; // model turns in one run
export const RUN_CEILING_MS = 60 * 60_000; // WAR's per-run ceiling

export type RunResult = { id: string; status: 'succeeded' | 'failed' | 'stopped'; acts: number; nudges: number; summary: string; error?: string };

export const newRunId = () => `r_${randomBytes(4).toString('hex')}`;

// --- Card state ---------------------------------------------------------------

export type AgentState = { ferocity: number; state: 'active' | 'draining' | 'stopped'; last_scheduled_at: number | null; fail_streak: number; backoff_until: number | null; spend_cap_usd: number | null };

// The whole agency's state (the dashboard's Standby and Stop), over each agent's
// own without touching it:
//   standby - every agent as if on standby: nothing starts by itself, people
//             are still answered; building agents and tailoring packs go on
//   stopped - every agent stopped, built-ins included; no building or tailoring
export type AgencyState = 'active' | 'standby' | 'stopped';
export function agencyState(): AgencyState {
  const s = getSetting<string | null>('agency_state', null);
  if (s === 'active' || s === 'standby' || s === 'stopped') return s;
  return getSetting<boolean>('agency_stopped', false) ? 'stopped' : 'active'; // before standby existed
}
export const agencyStopped = () => agencyState() === 'stopped';

export function stateOf(agentId: string, now = Date.now()): AgentState {
  let row = one<AgentState>('SELECT * FROM agent_state WHERE agent_id = ?', agentId);
  if (!row) {
    // A new agent starts on Chill, active (docs/agent-creation.md).
    exec('INSERT INTO agent_state (agent_id, updated_at) VALUES (?, ?)', agentId, now);
    row = { ferocity: 0, state: 'active', last_scheduled_at: null, fail_streak: 0, backoff_until: null, spend_cap_usd: null };
  }
  const agency = agencyState();
  if (agency === 'stopped') return { ...row, state: 'stopped' };
  if (agency === 'standby' && row.state === 'active') return { ...row, state: 'draining' };
  return row;
}

const HEALTH_KEY = 'model_health';
export const getHealth = () => getSetting<Health>(HEALTH_KEY, {});
export const putHealth = (h: Health) => setSetting(HEALTH_KEY, h);

// The models a run can use now: usable, with an adapter, and - when a spend
// cap is reached - free ones only (plans and local models).
export function eligibleModels(agent: AgentDef, deps: RunDeps): ModelChoice[] {
  const over = overSpend(agent.id, deps.now());
  return agent.models.filter(
    c => deps.modelInfo(c).usable && (deps.adapter(c.connection) || deps.harness(c.connection)) && (isFree(c.connection) || !over),
  );
}

// Today's spending limit reached - the agency's, or this agent's own.
export function overSpend(agentId: string, now: number): boolean {
  const orgCap = getSetting<number | null>('spend_cap_org_usd', null);
  const cap = stateOf(agentId, now).spend_cap_usd;
  return (orgCap != null && spentToday(now) >= orgCap) || (cap != null && spentToday(now, agentId) >= cap);
}

// Why an agent has no model to run on - said plainly on its card and in its DMs.
export function noModelReason(agent: AgentDef, deps: RunDeps): string {
  const now = deps.now();
  const orgCap = getSetting<number | null>('spend_cap_org_usd', null);
  const cap = stateOf(agent.id, now).spend_cap_usd;
  const usable = agent.models.filter(c => deps.modelInfo(c).usable && (deps.adapter(c.connection) || deps.harness(c.connection)));
  if (!agent.models.length) return 'It has no models. Pick some on its card.';
  if (!usable.length) return "None of its models can run right now. Check them on its card.";
  if (orgCap != null && spentToday(now) >= orgCap)
    return `Today's $${orgCap.toFixed(2)} spending limit is reached. It runs again tomorrow, or now on an AI plan.`;
  if (cap != null && spentToday(now, agent.id) >= cap)
    return `Its $${cap.toFixed(2)} daily limit is reached. It runs again tomorrow, or now on an AI plan.`;
  return 'No model it can use right now.';
}

// --- The instructions -----------------------------------------------------------

async function instructions(agent: AgentDef, level: number, notReady: string[], deps: RunDeps): Promise<string> {
  const now = deps.now();
  const fleet = await fleetOf(agent.id);
  // Everyone the agency works for (agent owners): none has pronouns on file yet.
  const people = [...new Set([agent.owner, ...(await Promise.all((await listIds()).map(async id => (await readMeta(id))?.owner)))].filter((x): x is string => !!x))];
  const health = new Map(toolHealth(agent.id).map(h => [h.tool, h]));
  const status = (id: string) => {
    const h = health.get(id);
    if (!h || (!h.last_ok && !h.last_fail)) return 'not used yet';
    if (h.last_ok && (!h.last_fail || h.last_ok >= h.last_fail)) return `last worked ${ago(now - h.last_ok)}`;
    return `failed ${ago(now - h.last_fail!)}: ${h.last_error ?? 'error'}${h.last_ok ? ` (last worked ${ago(now - h.last_ok)})` : ''}`;
  };
  const { specs, ids } = toolsFor(agent);
  const working = specs.map(s => `- ${ids.get(s.name)}: ${status(ids.get(s.name)!)}`);

  // Answers and results it hasn't been told yet.
  const answered = all<{ id: number; what: string; status: string; answer: string | null }>(
    "SELECT id, what, status, answer FROM requests WHERE agent_id = ? AND status != 'open' AND delivered_at IS NULL",
    agent.id,
  );
  const results = all<{ id: number; agent_id: string; task: string; result: string | null }>(
    "SELECT id, agent_id, task, result FROM tasks WHERE from_agent = ? AND status = 'done' AND delivered_at IS NULL",
    agent.id,
  );
  exec("UPDATE requests SET delivered_at = ? WHERE agent_id = ? AND status != 'open' AND delivered_at IS NULL", now, agent.id);
  exec("UPDATE tasks SET delivered_at = ? WHERE from_agent = ? AND status = 'done' AND delivered_at IS NULL", now, agent.id);
  const news = [
    ...answered.map(r => `- Your request #${r.id} ("${r.what}") was ${r.status === 'done' ? 'answered' : 'turned down'}: ${r.answer ?? '(no note)'}`),
    ...results.map(t => `- Task #${t.id} you handed to ${t.agent_id} is done: ${t.result ?? '(no result given)'}`),
  ];
  const openTasks = one<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status = 'open'", agent.id)?.n ?? 0;

  const org = agent.org ? await loadProfile(agent.org) : null;
  const person = agent.owner ? await loadPerson(agent.owner) : null;
  const who = [
    org ? profileForPrompt(org, agent.owner ?? undefined) : '',
    person?.full_name || person?.notes?.length
      ? `The person you work for: ${person.full_name || agent.owner}${person.call_me ? ` (call them ${person.call_me})` : ''}.${person.notes?.length ? `\n${person.notes.map(n => `- ${n}`).join('\n')}` : ''}`
      : '',
  ].filter(Boolean);

  return [
    `# You are ${agent.name}`,
    `You are ${agent.name}, an AI agent in ${agent.org ? `${agent.org}'s` : agent.owner ? `${agent.owner}'s` : 'an'} agency. Your ferocity is ${LEVELS[level]}.`,
    `## How the agency works
- You act only through your tools. T0 tools just run. T1 tools run and are logged. T2 tools need a person's decision: a call is queued in Approvals and you carry on.
- Your final message in a run is posted to your DM channel as the record of the run. Nobody is expected to read that channel: never rely on a person seeing it. Anything that needs a person goes through a request (requests.request_resource) or a T2 action.
- Your memory (below) is newest first, and a newer note overrides an older one it disagrees with. Never record whether a tool works: its live status is listed below, every run.
- A run that found nothing to do is not a lesson. Don't remember it, and don't treat past quiet runs as a reason to expect nothing now.
- Your workspace (files.*) is yours, for work you build up between runs.
- Hand work that is another agent's job to them with tasks.delegate_task.
- End every run with a short summary: what you did, what is waiting (approvals, requests, tasks), and what comes next.
- Refer to people by name, or as "they", unless their profile states their pronouns. Never guess pronouns from a name - in your messages, emails, files and memory notes.${people.length ? `
- The people here, none of whom has stated pronouns: ${people.join(', ')}. So write "${people[0]}" or "they" - never "he" or "she".` : ''}`,
    agent.charter.trim(),
    ferocityInstructions(agent, level),
    `## Your tools right now
${working.join('\n')}${notReady.length ? `\n\nIn your toolkit but not connected yet - don't try them or ask for them, they're being connected: ${notReady.join(', ')}` : ''}`,
    `## The agency
Agents you can hand work to: ${fleet.length ? fleet.map(f => `${f.id} (${f.name})`).join(', ') : 'none yet'}.
Tasks you owe right now: ${openTasks}${openTasks ? ' (tasks.list_my_tasks)' : ''}.`,
    `## Your memory (newest first)\n${memoryForPrompt(agent.id, now)}`,
    news.length ? `## Since your last run\n${news.join('\n')}` : '',
    who.length ? `## Who you work for\n${who.join('\n\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

async function fleetOf(exceptId: string) {
  const out: { id: string; name: string }[] = [];
  for (const id of await listIds()) {
    if (id === exceptId) continue;
    const m = await readMeta(id);
    if (m && m.status !== 'setting-up' && !m.service) out.push({ id, name: m.name });
  }
  return out;
}

function opening(agent: AgentDef, trigger: Trigger, task: string | null): string {
  switch (trigger) {
    case 'scheduled':
      return 'Scheduled run. Start with what you owe (tasks.list_my_tasks), then do your job as your Charter says.';
    case 'self-booked':
      return `You booked this run: ${task ?? 'to carry on'}. Carry on with that, then anything else your job needs.`;
    case 'apocalyptic':
      return 'Your next run, straight after the last one. Pick up where you left off and keep your output going: what you owe, then everything your Charter names.';
    case 'handoff':
      return `${task}\n\nDo it, then close it with tasks.complete_task.`;
    case 'your message': {
      const recent = all<{ kind: string; body: string }>("SELECT kind, body FROM dm WHERE agent_id = ? ORDER BY at DESC, id DESC LIMIT 7", agent.id)
        .reverse()
        .slice(0, -1)
        .map(r => {
          const b = JSON.parse(r.body) as { text?: string };
          return `${r.kind === 'you' ? 'Them' : 'You (a run)'}: ${(b.text ?? '').slice(0, 600)}`;
        });
      return `${agent.owner ?? 'A person'} wrote to you in your DM channel:\n\n"${task}"\n\nAnswer them: your final message is posted there as your reply. Do what they ask if it's part of your job.${recent.length ? `\n\nRecent messages in the channel, oldest first:\n${recent.join('\n')}` : ''}`;
    }
    case 'approval':
      return task ?? 'An approval you were waiting on was decided. Carry on.';
    // The Fleet Engineer's (runner/engineer.ts).
    case 'request':
      return `A new request came to you. ${task}

Start with engineer.list_requests, then take it as far as you can.`;
    case 'request reply':
      return `${task}

Read the request again with engineer.list_requests, then carry it forward.`;
    case 'connected':
      return `${task}

Test it properly now (engineer.test_integration), then carry its request forward.`;
    case 'run now':
      return `${agent.owner ?? 'A person'} started this run from the app. Start with what you owe (tasks.list_my_tasks), then do your job as your Charter says.`;
  }
}

// Models don't know today's date; research, dating work and "this year" need it.
// In the opening message rather than the instructions, so those stay cacheable.
export function nowLine(at: number): string {
  const d = new Date(at);
  const zone = hostZone();
  const day = d.toLocaleDateString('en-GB', { timeZone: zone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' });
  return `It's ${day}, ${time} (${zone}).`;
}

// --- The run ----------------------------------------------------------------------

// resumeFrom: a run of the same job a restart cut short, carried on from where it got to.
export async function runAgent(agent: AgentDef, trigger: Trigger, task: string | null, deps: RunDeps, signal?: AbortSignal, resumeFrom: string | null = null): Promise<RunResult> {
  const id = newRunId();
  const startedAt = deps.now();
  const level = stateOf(agent.id, startedAt).ferocity;
  // A run answering a person is never pushed past its answer (WAR).
  const floor = trigger === 'your message' ? null : floorFor(agent, level);
  exec(
    'INSERT INTO runs (id, agent_id, trigger, task, ferocity, status, started_at, floor) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    agent.id,
    trigger,
    task,
    level,
    'running',
    startedAt,
    floor?.floor ?? null,
  );

  const { specs, ids, notReady } = toolsFor(agent);
  const ctx: RunCtx = { agent, runId: id, level, now: deps.now, fleet: () => fleetOf(agent.id), wake: (a, t, k) => deps.wake(a, t as Trigger, k) };
  const resume = resumeFrom ? `\n\n${resumeText(resumeFrom)}` : '';
  const messages: Msg[] = [{ role: 'user', text: `${nowLine(startedAt)}\n\n${opening(agent, trigger, task)}${resume}` }];
  let acts = 0;
  let nudges = 0;
  let input = 0;
  let output = 0;
  let cost: number | null = 0;
  let used: ModelChoice | null = null;
  let summary = '';
  let error: string | undefined;

  try {
    const system = await instructions(agent, level, notReady, deps);
    let health = getHealth();
    for (let step = 0; step < MAX_STEPS; step++) {
      if (signal?.aborted) throw new Error('Stopped.');
      if (deps.now() - startedAt > RUN_CEILING_MS) {
        summary ||= 'Stopped at the one-hour run limit.';
        break;
      }
      // A model for this turn: the first eligible one, falling back down the list.
      const tried = new Set<string>();
      let turn: Awaited<ReturnType<Adapter>> | null = null;
      let harnessDone = false;
      while (!turn && !harnessDone) {
        const eligible = eligibleModels(agent, deps).filter(c => !tried.has(choiceKey(c)));
        const pick = pickModel(eligible, health, () => true, deps.now());
        if (!pick) throw new Error(tried.size ? `Every model failed this turn. Last: ${error}` :noModelReason(agent, deps));
        const c = pick.choice;
        tried.add(choiceKey(c));
        const info = deps.modelInfo(c);
        const level = info.efforts.length ? fitEffort(c.effort, info.efforts) : null;
        const effort = level ? (info.native?.[level] ?? level) : undefined;
        // A plan with its own agent loop runs the rest of the run itself.
        const harness = deps.harness(c.connection);
        if (harness) {
          try {
            const out = await harness({
              model: c.model,
              effort,
              system,
              opening: harnessOpening(id, messages),
              tools: specs,
              call: async call => {
                const r = await execute(ctx, call, ids);
                acts += r.counted;
                return { content: r.content, error: r.error };
              },
              next: () => {
                if (floor && acts < floor.floor && nudges < floor.nudges) {
                  nudges++;
                  return nudgeText(agent, acts, floor.floor, nudges, floor.nudges, floor.soft);
                }
                return null;
              },
              signal,
            });
            health = recordSuccess(health, c);
            used = c;
            input += out.usage.input;
            output += out.usage.output;
            if (out.text) summary = out.text;
            harnessDone = true;
          } catch (e) {
            if (signal?.aborted) throw e;
            health = recordFailure(health, c, deps.now());
            putHealth(health);
            if (!(e instanceof ModelError)) throw e;
            error = `${c.connection}/${c.model}: ${e.message}`;
            // Whoever takes over is told what this run already did.
            messages.push({ role: 'user', text: doneSoFar(id) });
          }
          continue;
        }
        try {
          turn = await deps.adapter(c.connection)!({
            connection: c.connection,
            model: c.model,
            effort,
            system,
            messages,
            tools: specs,
            signal,
          });
          health = recordSuccess(health, c);
          used = c;
        } catch (e) {
          if (signal?.aborted) throw e;
          health = recordFailure(health, c, deps.now());
          putHealth(health);
          if (!(e instanceof ModelError)) throw e;
          error = `${c.connection}/${c.model}: ${e.message}`;
        }
      }
      putHealth(health);
      if (harnessDone) break;
      if (!turn) continue;
      input += turn.usage.input;
      output += turn.usage.output;
      const c = await deps.cost(used!.connection, used!.model, turn.usage.input, turn.usage.output);
      cost = cost == null || c == null ? null : cost + c;
      messages.push({ role: 'assistant', text: turn.text, calls: turn.calls, raw: turn.raw });
      if (turn.text.trim()) summary = turn.text.trim();

      if (turn.calls.length) {
        const results = [];
        for (const call of turn.calls) {
          const r = await execute(ctx, call, ids);
          acts += r.counted;
          results.push({ id: call.id, name: call.name, content: r.content, error: r.error });
        }
        messages.push({ role: 'tool', results });
        continue;
      }
      // The model ended its turn. Below the floor? Nudge it (in the same conversation).
      if (floor && acts < floor.floor && nudges < floor.nudges) {
        nudges++;
        messages.push({ role: 'user', text: nudgeText(agent, acts, floor.floor, nudges, floor.nudges, floor.soft) });
        continue;
      }
      break;
    }
    error = undefined;
  } catch (e) {
    error = (e as Error).message;
  }

  await runEnded(id); // let go of anything the run held open (a browser)
  // Stopped by a person: cut short on purpose, not a failure - no backoff.
  const stopped = !!signal?.aborted;
  const status = stopped ? 'stopped' : error ? 'failed' : 'succeeded';
  const endedAt = deps.now();
  exec(
    'UPDATE runs SET status = ?, ended_at = ?, connection = ?, model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, acts = ?, nudges = ?, summary = ?, error = ? WHERE id = ?',
    status,
    endedAt,
    used?.connection ?? null,
    used?.model ?? null,
    input,
    output,
    cost,
    acts,
    nudges,
    summary || null,
    stopped ? null : (error ?? null),
    id,
  );
  postRun(
    agent.id,
    id,
    trigger,
    status,
    cost,
    endedAt - startedAt,
    stopped ? 'Stopped by a person part-way through this run.' : error ? `Run failed: ${error}` : summary || '(No summary.)',
  );

  // Backoff after failures in a row; a success clears it.
  const st = stateOf(agent.id, endedAt);
  if (!stopped) {
    const streak = status === 'failed' ? st.fail_streak + 1 : 0;
    exec('UPDATE agent_state SET fail_streak = ?, backoff_until = ?, updated_at = ? WHERE agent_id = ?', streak, streak ? endedAt + backoffMs(streak) : null, endedAt, agent.id);
  }

  if (deps.compact && used) void compactMemory(agent, used, deps).catch(() => {});
  return { id, status, acts, nudges, summary, error };
}

// What this run already did, for a model taking over part-way.
// For a run carrying on one the app's restart cut short.
function resumeText(cutRunId: string): string {
  const done = all<{ tool: string; outcome: string }>('SELECT tool, outcome FROM actions WHERE run_id = ? ORDER BY id', cutRunId);
  return done.length
    ? `You started this before and the app restarted part-way. You already did (don't redo these): ${done.map(d => `${d.tool} (${d.outcome})`).join(', ')}. Carry on from there.`
    : 'You started this before and the app restarted before you did anything. Start it again.';
}

function doneSoFar(runId: string): string {
  const done = all<{ tool: string; outcome: string }>('SELECT tool, outcome FROM actions WHERE run_id = ? ORDER BY id', runId);
  return done.length
    ? `The model running this so far stopped part-way. It already did, in this run (don't redo these): ${done.map(d => `${d.tool} (${d.outcome})`).join(', ')}. Carry on from there.`
    : 'The model running this so far stopped before doing anything. Carry on.';
}

// A harness starts from text: the opening, plus anything already done this run.
function harnessOpening(runId: string, messages: Msg[]): string {
  const first = messages[0];
  const opening = first?.role === 'user' ? first.text : '';
  return messages.length > 1 ? `${opening}\n\n${doneSoFar(runId)}` : opening;
}

// The run's post in the agent's DM channel (docs/agent-dms.md): the shape the
// app's RunPost draws. Tool lines carry argument NAMES only, never values.
export function postRun(agentId: string, runId: string, trigger: Trigger, outcome: string, cost: number | null, ms: number, text: string) {
  const tools = all<{ tool: string; fields: string; outcome: string; approval_id: string | null }>(
    'SELECT tool, fields, outcome, approval_id FROM actions WHERE run_id = ? ORDER BY id',
    runId,
  ).map(a => {
    const [server, ...rest] = a.tool.split('.');
    return {
      server,
      tool: rest.join('.'),
      fields: JSON.parse(a.fields) as string[],
      status: a.outcome === 'ok' || a.outcome === 'queued' ? 'ok' : 'failed',
      ...(a.approval_id ? { approvalId: a.approval_id } : {}),
    };
  });
  const body = { kind: 'run', id: runId, trigger: trigger === 'apocalyptic' ? 'self-booked' : trigger, outcome, cost: cost ?? 0, costKnown: cost != null, seconds: Math.round(ms / 1000), text, tools };
  exec("INSERT INTO dm (agent_id, kind, run_id, body, at) VALUES (?, 'run', ?, ?, ?)", agentId, runId, JSON.stringify(body), Date.now());
}

// Compacts its memory with its own model, once it's past the cap.
// With the model the run used - an API model directly, or a plan's own loop
// (Claude Code, Copilot) given no tools.
export async function compactMemory(agent: AgentDef, model: ModelChoice, deps: RunDeps) {
  const adapter = deps.adapter(model.connection);
  const harness = adapter ? null : deps.harness(model.connection);
  if (!adapter && !harness) return;
  await compactIfNeeded(agent.id, async (old, newer) => {
    const text = `NEWER notes (true; for context only):\n${newer.join('\n')}\n\nOLDEST notes to compact:\n${old.join('\n')}`;
    if (adapter)
      return (await adapter({ connection: model.connection, model: model.model, system: COMPACT_PROMPT, messages: [{ role: 'user', text }], tools: [], maxTokens: 1500 })).text;
    return (await harness!({ model: model.model, system: COMPACT_PROMPT, opening: text, tools: [], call: async () => ({ content: '', error: true }), next: () => null })).text;
  });
}
