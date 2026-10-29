import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Tier } from '../catalog.js';
import { FLEET_ENGINEER, type AgentDef } from './agent.js';
import { all, one, run } from './db.js';
import { APOCALYPTIC } from './ferocity.js';
import { remember } from './memory.js';
import type { Call, ToolSpec } from './providers.js';

// The tools a run can call (docs/runner.md). Built-in agency tools work for
// every agent; integration tools (web, email, GitHub...) are added one area
// at a time. A tool the agent holds that isn't working yet is left out of the
// run and named in its tool status, so it isn't tried.
//
// Around every call the runner applies:
//   - tiers: T2 is queued for a person's decision and the agent carries on
//   - natural limits: a call past one is refused with a pointer to other work
//   - output counting toward the floor: attempts count (done, failed, or
//     queued for approval); refused calls never do

export type RunCtx = {
  agent: AgentDef;
  runId: string;
  level: number;
  now: () => number;
  // The ids of every agent it can hand work to.
  fleet: () => Promise<{ id: string; name: string }[]>;
  // Books another agent's run (a handoff); set by the runner.
  wake: (agentId: string, trigger: string, task: string) => void;
};

type Impl = (args: Record<string, unknown>, ctx: RunCtx) => Promise<string> | string;
// ready: whether it can be used right now (an integration's tool: whether one
// that provides it is connected). Missing means always.
// preview: for a T2 tool, facts to add to what the person approves (the code a
// plugin will run, say) - stored with the call, and handed to impl when it runs.
type ToolDef = {
  id: string;
  tier: Tier;
  description: string;
  schema: Record<string, unknown>;
  impl: Impl;
  ready?: () => boolean;
  preview?: (args: Record<string, unknown>, ctx: RunCtx) => Promise<Record<string, unknown>>;
};

export type Wake = (agentId: string, trigger: string, task: string) => void;

// Where a new request goes first: the Agency Conductor (conductor.ts) sets this;
// without it, straight to the Agency Engineer.
let router: ((requestId: number, wake: Wake) => Promise<void>) | null = null;
export const setRequestRouter = (fn: typeof router) => void (router = fn);

// A request goes to the Agency Conductor, which hands it to a related agent or to the
// Agency Engineer (docs/requests.md); direct: straight to the engineer (a tool
// the builder invented - always the engineer's). The engineer's own requests
// go to a person.
export function fileRequest(
  agentId: string,
  runId: string | null,
  r: { what: string; why: string; evidence?: string | null; expected_effect?: string | null },
  now: number,
  wake: Wake,
  direct = false,
): number {
  const toEngineer = agentId !== FLEET_ENGINEER;
  const id = Number(
    run(
      'INSERT INTO requests (agent_id, run_id, what, why, evidence, expected_effect, created_at, stage) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      agentId,
      runId,
      r.what.slice(0, 500),
      r.why.slice(0, 2000),
      r.evidence ? r.evidence.slice(0, 4000) : null,
      r.expected_effect ? r.expected_effect.slice(0, 1000) : null,
      now,
      toEngineer ? 'engineer' : 'person',
    ).lastInsertRowid,
  );
  if (!toEngineer) return id;
  if (router && !direct) void router(id, wake);
  else wake(FLEET_ENGINEER, 'request', `Request #${id} from ${agentId}: ${r.what.slice(0, 300)}`);
  return id;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });

export const WORKSPACES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'workspaces');
const MAX_FILE = 200_000;

// A path inside the agent's own workspace, or an error.
function inWorkspace(agentId: string, path: unknown): string {
  const p = String(path ?? '').trim().replace(/\\/g, '/');
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p)) throw new Error('Give a relative path, like "ideas/2026-11.md".');
  const root = join(WORKSPACES, agentId);
  const full = normalize(join(root, p));
  if (relative(root, full).startsWith('..') || full === root) throw new Error('That path is outside your workspace.');
  return full;
}

const BUILTIN: ToolDef[] = [
  {
    id: 'memory.remember',
    tier: 'T0',
    description:
      "Save a note to your own memory for future runs: facts about the work, what you did (so it isn't redone), people's preferences, lessons. Not whether a tool works - that is tracked for you.",
    schema: obj({ note: str('The note, one fact or lesson') }, ['note']),
    impl: (a, ctx) => remember(ctx.agent.id, String(a.note ?? ''), Object.keys(ctx.agent.tiers)).message,
  },
  {
    id: 'files.write_file',
    tier: 'T0',
    description: 'Write a file in your own workspace (creates or replaces it). For work you build up: drafts, lists, research, prepared material.',
    schema: obj({ path: str('Relative path, e.g. "ideas/wallpapers.md"'), content: str('The full file content') }, ['path', 'content']),
    impl: async (a, ctx) => {
      const full = inWorkspace(ctx.agent.id, a.path);
      const content = String(a.content ?? '');
      if (content.length > MAX_FILE) throw new Error(`Too large (${content.length} characters); keep files under ${MAX_FILE}.`);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content);
      return `Saved ${String(a.path)} (${content.length} characters).`;
    },
  },
  {
    id: 'files.read_file',
    tier: 'T0',
    description: 'Read a file from your own workspace.',
    schema: obj({ path: str('Relative path') }, ['path']),
    impl: async (a, ctx) => {
      const text = await readFile(inWorkspace(ctx.agent.id, a.path), 'utf8').catch(() => {
        throw new Error(`No file at ${String(a.path)}.`);
      });
      return text.length > 60_000 ? `${text.slice(0, 60_000)}\n[cut off at 60,000 characters]` : text;
    },
  },
  {
    id: 'files.list_files',
    tier: 'T0',
    description: 'List the files in your own workspace.',
    schema: obj({}),
    impl: async (_a, ctx) => {
      const root = join(WORKSPACES, ctx.agent.id);
      const out: string[] = [];
      const walk = async (dir: string) => {
        for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
          const full = join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else out.push(`${relative(root, full).split(sep).join('/')} (${(await stat(full)).size} bytes)`);
        }
      };
      await walk(root);
      return out.length ? out.join('\n') : 'Your workspace is empty.';
    },
  },
  {
    id: 'requests.request_resource',
    tier: 'T1',
    description:
      'Ask for something you need and cannot get yourself: a tool, access, an account, data, a decision. It is answered later; carry on without it for now.',
    schema: obj(
      {
        what: str('What you need, in one sentence'),
        why: str('Why: what it lets you do'),
        evidence: str('What you tried, or what shows you need it'),
        expected_effect: str('What changes once you have it'),
      },
      ['what', 'why'],
    ),
    impl: (a, ctx) => {
      const id = fileRequest(
        ctx.agent.id,
        ctx.runId,
        { what: String(a.what ?? ''), why: String(a.why ?? ''), evidence: a.evidence ? String(a.evidence) : null, expected_effect: a.expected_effect ? String(a.expected_effect) : null },
        ctx.now(),
        ctx.wake,
      );
      return `Filed request #${id}. You'll be told the answer at the start of a later run. Carry on without it for now.`;
    },
  },
  {
    id: 'requests.list_my_requests',
    tier: 'T0',
    description: 'Your requests that are still open.',
    schema: obj({}),
    impl: (_a, ctx) => {
      const rows = all<{ id: number; what: string; created_at: number }>(
        "SELECT id, what, created_at FROM requests WHERE agent_id = ? AND status = 'open' ORDER BY id",
        ctx.agent.id,
      );
      return rows.length ? rows.map(r => `#${r.id}: ${r.what}`).join('\n') : 'No open requests.';
    },
  },
  {
    id: 'tasks.list_my_tasks',
    tier: 'T0',
    description: 'The tasks you owe: work other agents or people handed to you.',
    schema: obj({}),
    impl: (_a, ctx) => {
      const rows = all<{ id: number; task: string; from_agent: string | null }>(
        "SELECT id, task, from_agent FROM tasks WHERE agent_id = ? AND status = 'open' ORDER BY id",
        ctx.agent.id,
      );
      return rows.length ? rows.map(r => `#${r.id} (from ${r.from_agent ?? 'a person'}): ${r.task}`).join('\n') : 'No open tasks.';
    },
  },
  {
    id: 'tasks.complete_task',
    tier: 'T1',
    description: 'Close a task you owe, with its result. Whoever handed it over is told.',
    schema: obj({ task_id: { type: 'number', description: 'The task number' }, result: str('What you did, and the result') }, ['task_id', 'result']),
    impl: (a, ctx) => {
      const r = run(
        "UPDATE tasks SET status = 'done', result = ?, done_at = ? WHERE id = ? AND agent_id = ? AND status = 'open'",
        String(a.result ?? '').slice(0, 4000),
        ctx.now(),
        Number(a.task_id),
        ctx.agent.id,
      );
      if (!r.changes) throw new Error(`You have no open task #${String(a.task_id)}.`);
      return `Task #${String(a.task_id)} closed.`;
    },
  },
  {
    id: 'tasks.delegate_task',
    tier: 'T1',
    description: "Hand work to another agent in the agency whose job it is. It's woken to do it, and you're told the result on a later run.",
    schema: obj({ agent_id: str('The agent to hand it to (its id)'), task: str('What to do, with everything it needs to know') }, ['agent_id', 'task']),
    impl: async (a, ctx) => {
      const target = String(a.agent_id ?? '');
      const fleet = await ctx.fleet();
      if (target === ctx.agent.id) throw new Error("That's you. Do it yourself.");
      const who = fleet.find(f => f.id === target);
      if (!who) throw new Error(`No agent "${target}". The agents are: ${fleet.map(f => `${f.id} (${f.name})`).join(', ') || 'none'}.`);
      // One that's stopped or on standby wouldn't start on it: the work would just sit.
      const state = one<{ state: string }>('SELECT state FROM agent_state WHERE agent_id = ?', target)?.state;
      if (state === 'stopped' || state === 'draining')
        throw new Error(`${who.name} is ${state === 'stopped' ? 'stopped' : 'on standby'}, so it won't pick work up. Do it another way, or file a request (requests.file_request) if only it can.`);
      const task = String(a.task ?? '').slice(0, 4000);
      const r = run('INSERT INTO tasks (agent_id, from_agent, task, created_at) VALUES (?, ?, ?, ?)', target, ctx.agent.id, task, ctx.now());
      ctx.wake(target, 'handoff', `Task #${r.lastInsertRowid} from ${ctx.agent.name}: ${task}`);
      return `Handed to ${who.name} as task #${r.lastInsertRowid}.`;
    },
  },
  {
    id: 'ops.book_next_run',
    tier: 'T0',
    description: 'Book your own next run, naming the work it is for. delay_minutes: how long from now (0 = as soon as this one ends).',
    schema: obj({ reason: str('The work the run is for'), delay_minutes: { type: 'number', description: '0 to 1440' } }, ['reason']),
    impl: (a, ctx) => {
      if (ctx.level === APOCALYPTIC) return "Not needed: at your level your next run starts as soon as this one ends.";
      const delay = Math.max(0, Math.min(1440, Number(a.delay_minutes) || 0));
      const pending = one<{ id: number }>("SELECT id FROM bookings WHERE agent_id = ? AND trigger = 'self-booked'", ctx.agent.id);
      const due = ctx.now() + delay * 60_000;
      if (pending) run('UPDATE bookings SET due_at = MIN(due_at, ?), task = ? WHERE id = ?', due, String(a.reason ?? ''), pending.id);
      else
        run(
          "INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, 'self-booked', ?, ?, ?)",
          ctx.agent.id,
          String(a.reason ?? '').slice(0, 1000),
          due,
          ctx.now(),
        );
      return delay ? `Booked: your next run starts in about ${delay} minutes.` : 'Booked: your next run starts once this one ends.';
    },
  },
];

export const BUILTIN_IDS = new Set(BUILTIN.map(t => t.id));

// Integration tools (web, email, GitHub...): each area registers its tools
// here as it's built. An agent gets the ones it holds in TOOLS.yaml, at the
// tier its builder gave them; the built-ins every agent gets, at their own tier.
const REGISTERED = new Map<string, ToolDef>();
export function registerTools(defs: ToolDef[]) {
  for (const d of defs) REGISTERED.set(d.id, d);
}
export type { ToolDef };

// One catalogue tool that stands for a set: holding web.browse means the whole
// blank browser (open, click, type...), at web.browse's tier unless the agent
// holds a member itself.
const FAMILIES: Record<string, string[]> = {
  'web.browse': ['browser.open', 'browser.click', 'browser.type', 'browser.scroll', 'browser.back'],
};

// Every tool an agent holds, with its tier: TOOLS.yaml plus family members.
export function heldTools(agent: AgentDef): Record<string, Tier> {
  const held: Record<string, Tier> = { ...agent.tiers };
  for (const [family, members] of Object.entries(FAMILIES))
    if (family in agent.tiers) for (const m of members) held[m] ??= agent.tiers[family];
  return held;
}

// Run-end hooks: tools that hold something open during a run (a browser)
// let it go here.
const runEndHooks: ((runId: string) => Promise<void> | void)[] = [];
export const onRunEnd = (fn: (runId: string) => Promise<void> | void) => void runEndHooks.push(fn);
export async function runEnded(runId: string) {
  for (const fn of runEndHooks) await Promise.resolve(fn(runId)).catch(() => {});
}
const find = (id: string) => BUILTIN.find(t => t.id === id) ?? REGISTERED.get(id);

// Runs a tool a person approved, with the exact arguments the agent queued.
export async function runApproved(ctx: RunCtx, id: string, args: Record<string, unknown>): Promise<string> {
  const impl = find(id);
  if (!impl) throw new Error(`${id} no longer exists.`);
  if (impl.ready && !impl.ready()) throw new Error(`${id} isn't connected right now.`);
  try {
    const out = await impl.impl(args, ctx);
    healthOk(ctx.agent.id, id, ctx.now());
    return out;
  } catch (e) {
    healthFail(ctx.agent.id, id, ctx.now(), (e as Error).message || 'It failed.');
    throw e;
  }
}

// Names a provider accepts: [a-zA-Z0-9_-], up to 64.
export const toolName = (id: string) => id.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

// The tools this run can call, and the ones it holds that aren't working yet.
export function toolsFor(agent: AgentDef): { specs: ToolSpec[]; ids: Map<string, string>; notReady: string[] } {
  const ids = new Map<string, string>(); // provider name -> tool id
  const specs: ToolSpec[] = [];
  const add = (t: ToolDef) => {
    ids.set(toolName(t.id), t.id);
    specs.push({ name: toolName(t.id), description: t.description, schema: t.schema });
  };
  BUILTIN.forEach(add);
  const held = heldTools(agent);
  for (const id of Object.keys(held)) {
    const t = REGISTERED.get(id);
    if (t && !BUILTIN_IDS.has(id) && (t.ready?.() ?? true)) add(t);
  }
  const notReady = Object.keys(agent.tiers).filter(id => !LEGACY.has(id) && !FAMILIES[id] && !ids.has(toolName(id)));
  return { specs, ids, notReady };
}

// Baseline tools from before the runner, which the built-ins replace.
const LEGACY = new Set(['memory.propose_memory', 'ops.propose_own_followup_run', 'channel.post_to_own_channel']);

export const tierOf = (agent: AgentDef, id: string): Tier =>
  BUILTIN.find(t => t.id === id)?.tier ?? heldTools(agent)[id] ?? REGISTERED.get(id)?.tier ?? 'T2';

// --- One call --------------------------------------------------------------------

export type CallOutcome = {
  id: string; // tool id (server.tool), or the name the model used if unknown
  content: string;
  error: boolean;
  outcome: 'ok' | 'failed' | 'queued' | 'refused';
  counted: number; // output actions it counts for
  approvalId?: string;
};

// How many output acts one call is: a batch counts once per item.
export function actsIn(args: Record<string, unknown>): number {
  for (const v of Object.values(args)) if (Array.isArray(v) && v.length) return Math.min(v.length, 50);
  return 1;
}

// Past a natural limit? Counts what it already did (or queued) in the window.
export function limitHit(agent: AgentDef, id: string, now: number): string | null {
  const limit = agent.limits.find(l => l.tool === id);
  if (!limit) return null;
  const since = now - limit.per_hours * 3_600_000;
  const done = one<{ n: number }>(
    "SELECT COUNT(*) AS n FROM actions WHERE agent_id = ? AND tool = ? AND at >= ? AND outcome IN ('ok', 'queued')",
    agent.id,
    id,
    since,
  )?.n ?? 0;
  if (done < limit.max) return null;
  const window = limit.per_hours === 24 ? 'a day' : limit.per_hours % 24 === 0 ? `${limit.per_hours / 24} days` : `${limit.per_hours} hours`;
  return `Not done: ${id} is limited to ${limit.max} per ${window} for this job${limit.why ? ` (${limit.why})` : ''}, and that's been reached. This doesn't count toward your output. Put your effort into the rest of your work: ${agent.ferocity.extra_effort}`;
}

let approvalSeq = 0;

export async function execute(ctx: RunCtx, call: Call, ids: Map<string, string>): Promise<CallOutcome> {
  const id = ids.get(call.name) ?? call.name.replace('__', '.');
  const counts = ctx.agent.ferocity.counts.includes(id);
  const tier = tierOf(ctx.agent, id);
  const record = (o: Omit<CallOutcome, 'id'>) => {
    run(
      'INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, output, approval_id, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ctx.runId,
      ctx.agent.id,
      id,
      JSON.stringify(Object.keys(call.args)),
      tier,
      o.outcome,
      o.counted,
      o.approvalId ?? null,
      ctx.now(),
    );
    return { id, ...o };
  };

  const impl = find(id);
  // Only tools this run was given: built-ins, and registered tools it holds.
  if (!impl || (!BUILTIN_IDS.has(id) && !(id in heldTools(ctx.agent)))) return record({ content: `There is no tool "${call.name}" you can use.`, error: true, outcome: 'refused', counted: 0 });
  if (impl.ready && !impl.ready()) return record({ content: `${id} isn't connected right now.`, error: true, outcome: 'refused', counted: 0 });

  const hit = limitHit(ctx.agent, id, ctx.now());
  if (hit) return record({ content: hit, error: true, outcome: 'refused', counted: 0 });

  // A required input left out or empty is refused here, before anything runs
  // or is queued: a person shouldn't be asked to approve a call that can't work.
  const missing = ((impl.schema as { required?: string[] }).required ?? []).filter(k => {
    const v = call.args[k];
    return v === undefined || v === null || (typeof v === 'string' && !v.trim()) || (typeof v === 'number' && !Number.isFinite(v));
  });
  if (missing.length) return record({ content: `Missing ${missing.join(', ')}: give ${missing.length === 1 ? 'it' : 'them'} and call again.`, error: true, outcome: 'refused', counted: 0 });

  const n = counts ? actsIn(call.args) : 0;
  if (tier === 'T2') {
    const approvalId = `apv_${ctx.now().toString(36)}${(approvalSeq++).toString(36)}`;
    const hours = ctx.agent.approvalHours[id] ?? 24;
    let stored = call.args;
    if (impl.preview)
      try {
        stored = { ...call.args, ...(await impl.preview(call.args, ctx)) };
      } catch (e) {
        return record({ content: (e as Error).message, error: true, outcome: 'refused', counted: 0 });
      }
    run(
      'INSERT INTO approvals (id, agent_id, run_id, tool, args, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      approvalId,
      ctx.agent.id,
      ctx.runId,
      id,
      JSON.stringify(stored),
      ctx.now(),
      ctx.now() + hours * 3_600_000,
    );
    return record({
      content: `'${id}' needs a person's decision before it runs. It has been QUEUED with the exact arguments you gave - don't call it again (that would queue a duplicate). Carry on with the rest of your work and list it as waiting for approval in your summary. Don't try to get the same effect another way.`,
      error: false,
      outcome: 'queued',
      counted: n,
      approvalId,
    });
  }
  try {
    const content = await impl.impl(call.args, ctx);
    healthOk(ctx.agent.id, id, ctx.now());
    return record({ content, error: false, outcome: 'ok', counted: n });
  } catch (e) {
    const message = (e as Error).message || 'It failed.';
    healthFail(ctx.agent.id, id, ctx.now(), message);
    return record({ content: message, error: true, outcome: 'failed', counted: n });
  }
}

// --- Live tool status (never from memory) ------------------------------------------

function healthOk(agentId: string, tool: string, at: number) {
  run(
    'INSERT INTO tool_health (agent_id, tool, last_ok) VALUES (?, ?, ?) ON CONFLICT(agent_id, tool) DO UPDATE SET last_ok = excluded.last_ok',
    agentId,
    tool,
    at,
  );
}
function healthFail(agentId: string, tool: string, at: number, error: string) {
  run(
    'INSERT INTO tool_health (agent_id, tool, last_fail, last_error) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id, tool) DO UPDATE SET last_fail = excluded.last_fail, last_error = excluded.last_error',
    agentId,
    tool,
    at,
    error.slice(0, 300),
  );
}

export function toolHealth(agentId: string) {
  return all<{ tool: string; last_ok: number | null; last_fail: number | null; last_error: string | null }>(
    'SELECT tool, last_ok, last_fail, last_error FROM tool_health WHERE agent_id = ?',
    agentId,
  );
}
