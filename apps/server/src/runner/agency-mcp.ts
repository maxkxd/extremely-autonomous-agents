import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { createAgent, deleteAgent } from '../agents.js';
import { BuildSchema, builderGuide, hasGoalNumber, NEEDS_GOAL, type Build } from '../builder.js';
import { BASELINE, CATALOG_INDEX } from '../catalog.js';
import { loadPerson, loadProfile } from '../org.js';
import { compose, DATA, kpiLabels, listIds, readMeta, slug, writeMeta } from '../files.js';
import { scanFleet } from '../fleet.js';
import {
  discardDraft,
  integrationSource,
  integrationToolIds,
  listIntegrations,
  liveEventIds,
  publishIntegration,
  publishPreview,
  removeIntegration,
  testIntegrationTool,
  writeDraftIntegration,
} from '../integrations/index.js';
import { pluginsAllowed, writePlugin } from '../integrations/plugins.js';
import { reviewPlugin } from '../integrations/review.js';
import { allChoices, setChoices } from '../models/choice.js';
import { availableModels } from '../models/connections.js';
import type { Tier } from '../catalog.js';
import { FLEET_ENGINEER, loadAgent, type AgentDef } from './agent.js';
import { answerRequest, personWrites } from './api.js';
import { decideApproval } from './approvals.js';
import { startOfDay } from './clock.js';
import { DOCTOR } from './doctor.js';
import { reportDefault } from './reports.js';
import { scrub } from '../secrets.js';
import { all, getSetting, one, run as exec, setSetting } from './db.js';
import { giveEvents, giveTools } from './engineer.js';
import { checkEvent } from './events.js';
import { hooksBase } from './hooks.js';
import { PERIODS } from './clock.js';
import { checkGoal, goalsOf, hasGoal, paceFor, periodNow, setGoal, type Goal } from './goals.js';
import { openBridge, rpc, type Rpc } from './mcp.js';
import { selfMember, SELF_HOSTED } from '../selfhost.js';
import { accessConfig, asActor, currentActor, localActor, personFor, recordAction, requireMakerOrAdmin, type Actor, type Role } from '../access.js';
import { registeredToolIds } from './tools.js';
import { stateOf } from './run.js';
import { abortRun, book, queueRunNow } from './scheduler.js';
import { clock, mins, paceMine, scheduledRows, scheduleMine, type Pace, type QueuedRow } from './action-queue.js';
import {
  applyEdits,
  approvalAccount,
  approvalLine,
  capResult,
  COST_NOTE,
  matchesAccount,
  senderOf,
  diffLine,
  editSection,
  findHeading,
  GROUPS,
  monthSpendByAgent,
  outlineOf,
  roundUsd,
  spendBy,
  spendRows,
  windowOf,
  type Edit,
  type Group,
  type PendingRow,
  type SectionMode,
} from './agency-mcp-views.js';
import { startOfMonth } from './clock.js';
import { spentToday } from './pricing.js';

// The agency as an MCP server, for the person's own AI IDE (Claude Code,
// Cursor, Codex...): everything the Agency Engineer and the agent builder can
// do - requests, agents' files and settings, new agents, integrations and
// plugins. It acts for the person, so nothing queues in the app's Approvals:
// the IDE asks them before each tool call. A plugin still gets the independent
// security review and runs in its sandbox. One address, on this computer
// only, kept across restarts; Settings shows it and can change it.

type Tool = { name: string; description: string; schema: Record<string, unknown>; run: (a: Record<string, unknown>) => Promise<string> };

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const json = (v: unknown) => JSON.stringify(v, null, 2);

// Whose agency it is: the host (until orgs exist, whoever runs the app).
const hostPerson = () => getSetting<string | null>('host_person', null);
const hostOrg = () => getSetting<string | null>('host_org', null);

// What the builder knows when it builds: the person, the organization, the fleet, the models.
async function hostContext() {
  const person = hostPerson() ?? 'The host';
  const org = hostOrg();
  return { person: await loadPerson(person), profile: org ? await loadProfile(org) : null, fleet: await scanFleet(), models: await availableModels() };
}

// What's wrong with a build an IDE wrote, that the app's builder would never
// write: ids that exist nowhere, models that aren't connected, KPIs and counts
// that aren't its tools.
function buildProblems(b: Build, fleetIds: Set<string>, eventIds: Set<string>, models: Awaited<ReturnType<typeof availableModels>>): string[] {
  const out: string[] = [];
  const newTools = new Set(b.new_tools.map(t => `${t.server}.${t.name}`));
  const known = (id: string) => fleetIds.has(id) || CATALOG_INDEX.has(id) || newTools.has(id) || BASELINE.some(x => `${x.server}.${x.tool.name}` === id);
  const unknownTools = b.tools.map(t => t.id).filter(id => !known(id));
  if (unknownTools.length) out.push(`These tools exist nowhere: ${unknownTools.join(', ')}. Use an id from builder_guide, or define it in new_tools (then its id is server.name).`);
  const newEvents = new Set((b.new_events ?? []).map(e => `${e.server}.${e.name}`));
  const unknownEvents = (b.events ?? []).map(e => e.id).filter(id => !eventIds.has(id) && !newEvents.has(id));
  if (unknownEvents.length) out.push(`These events exist nowhere: ${unknownEvents.join(', ')}. Use one builder_guide lists, or define it in new_events.`);
  const badModels = (b.models ?? []).filter(m => !models.some(x => x.connection === m.connection && x.models.includes(m.model)));
  if (badModels.length) out.push(`These models aren't connected: ${badModels.map(m => `${m.connection}/${m.model}`).join(', ')}. Pick from builder_guide's models.`);
  if (!(b.models ?? []).length) out.push('It has no models: give it one to three from builder_guide.');
  const tools = new Set([...b.tools.map(t => t.id), ...BASELINE.map(x => `${x.server}.${x.tool.name}`)]);
  const badKpi = b.kpi.map(k => k.id).filter(id => !tools.has(id));
  if (badKpi.length) out.push(`KPIs that aren't its tools: ${badKpi.join(', ')}.`);
  const badCounts = (b.ferocity?.counts ?? []).filter(id => !tools.has(id));
  if (badCounts.length) out.push(`Ferocity counts that aren't its tools: ${badCounts.join(', ')}.`);
  // Every agent needs a goal (goals.ts): a KPI row, on a tool it holds, with a number.
  if (!hasGoalNumber({ kpi: b.kpi.filter(k => tools.has(k.id)) })) out.push(NEEDS_GOAL);
  return out;
}

// "since" as a tool takes it: an ISO date or time, else the start of today on the agency's clock.
function sinceOf(v: unknown): number {
  const text = String(v ?? '').trim();
  if (!text) return startOfDay(Date.now());
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new Error(`"${text}" isn't a date or time: use e.g. 2026-11-05 or 2026-11-05T09:00.`);
  return t;
}

async function agentOrThrow(id: unknown) {
  const agentId = String(id ?? '');
  const meta = await readMeta(agentId);
  if (!meta) throw new Error(`No agent "${agentId}". list_agents shows them.`);
  return { agentId, meta };
}

const FILES = { 'CHARTER.md': 'charter', 'TOOLS.yaml': 'tools', 'KPI.yaml': 'kpi' } as const;
const SECTION_FILE = { charter: 'CHARTER.md', tools: 'TOOLS.yaml', kpi: 'KPI.yaml' } as const;
const agentFile = (agentId: string, file: string) => readFile(join(DATA, slug(agentId), file), 'utf8').catch(() => '');
const usd = (n: number | null | undefined) => (n == null ? 'unpriced' : `$${roundUsd(n)}`);

// Saves one of an agent's files the way write_agent_file always has: YAML must
// parse, the agent must still load with it (else the old one goes back).
async function saveAgentFile(agentId: string, file: keyof typeof FILES, content: string) {
  const meta = (await readMeta(agentId))!;
  if (!content.trim()) throw new Error('The file would be empty.');
  if (file !== 'CHARTER.md')
    try {
      parse(content);
    } catch (e) {
      throw new Error(`That isn't valid YAML: ${(e as Error).message.slice(0, 300)}`);
    }
  const path = join(DATA, slug(agentId), file);
  const before = await readFile(path, 'utf8');
  await writeFile(path, content);
  if (!(await loadAgent(agentId))) {
    await writeFile(path, before);
    throw new Error("The agent couldn't load with that file, so it wasn't saved. Check it against the old one (read_agent).");
  }
  // A KPI rewritten so that no output has a number would leave it with no goal, and an
  // agent with no goal does not run: the old file goes back.
  if (file === 'KPI.yaml' && !meta.builtIn && !meta.service) {
    const was = ((parse(before) ?? {}) as { output?: AgentDef['output'] }).output ?? [];
    const now = (await loadAgent(agentId))?.output ?? [];
    if (hasGoal(agentId, was) && !hasGoal(agentId, now)) {
      await writeFile(path, before);
      throw new Error('Not saved: that would leave the agent with no goal, and an agent with no goal does not run. Keep the output that holds its goal, or give another output a number first (set_agent with goal, amount and period; or amount and period on a row of this file).');
    }
  }
  if (file === 'KPI.yaml') await writeMeta(agentId, { ...meta, output: kpiLabels(content) });
  return before;
}

// Who may change an agent's files, and which.
async function editableFile(a: Record<string, unknown>) {
  const { agentId, meta } = await agentOrThrow(a.agent_id);
  if (meta.builtIn) throw new Error(`${meta.name} is built in: its files are rewritten every time the app starts.`);
  await requireMakerOrAdmin(agentId, null, currentActor(), 'change its files');
  const file = String(a.file) as keyof typeof FILES;
  if (!(file in FILES)) throw new Error('file is CHARTER.md, TOOLS.yaml or KPI.yaml.');
  return { agentId, meta, file };
}

// Approvals waiting on a person that are this person's to decide (as in the app).
async function decidable(): Promise<PendingRow[]> {
  const rows = all<PendingRow>("SELECT id, agent_id, tool, args, expires_at FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at", Date.now());
  const out: PendingRow[] = [];
  // Whose each is, as the app decides it (runner/api.ts approvals/decide): an Engineer
  // card by the request it's for, a Doctor card by the agent it's about.
  for (const r of rows) {
    const args = JSON.parse(r.args) as { request_id?: number; agent_id?: string };
    const mine = await requireMakerOrAdmin(r.agent_id, args.request_id == null ? null : Number(args.request_id), currentActor(), 'decide this', r.agent_id === DOCTOR ? (args.agent_id ?? null) : null).then(
      () => true,
      () => false,
    );
    if (mine) out.push(r);
  }
  return out;
}
const nameOf = async (id: string, cache = new Map<string, string>()) => {
  if (!cache.has(id)) cache.set(id, (await readMeta(id))?.name ?? id);
  return cache.get(id)!;
};
const lc = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);
const page = (a: Record<string, unknown>, dflt = 25) => ({ offset: Math.max(0, Math.floor(Number(a.offset) || 0)), limit: Math.max(1, Math.min(200, Math.floor(Number(a.limit) || dflt))) });

// An agent's goals, each over its trailing window, and the pace they call for (goals.ts),
// as the app's card has them. noGoal: an ordinary agent with none, which does not run.
async function goalsNow(agentId: string, builtIn: boolean): Promise<{ goals: Goal[]; pace: ReturnType<typeof paceFor>; noGoal: boolean }> {
  const agent = builtIn ? null : await loadAgent(agentId);
  const goals = agent ? goalsOf(agent) : [];
  const pace = agent && goals.length ? paceFor(agent, Date.now(), goals) : null;
  return { goals, pace, noGoal: !!agent && !pace };
}
async function goalFacts(agentId: string, builtIn: boolean) {
  const { goals, pace, noGoal } = await goalsNow(agentId, builtIn);
  return {
    goals: goals.map(g => ({ goal: g.label, amount: g.amount, period: g.period, done: g.done, waiting_for_approval: g.waiting })),
    pace: pace ? { status: pace.status, runs_at_once: pace.parallel, runs_a_day: Math.round(pace.runsPerDay * 10) / 10 } : null,
    ...(noGoal ? { no_goal: 'It has no goal, so it does not run. Give it one with set_agent (goal, amount, period).' } : {}),
  };
}
async function goalLine(agentId: string, builtIn: boolean): Promise<string> {
  const { goals, pace, noGoal } = await goalsNow(agentId, builtIn);
  if (noGoal) return `Goals: none - it does not run until it has one (set_agent with goal, amount and period)${goals.length ? `. Its outputs: ${goals.map(g => g.label).join(', ')}` : ''}`;
  if (!goals.length) return '';
  return `Goals: ${goals.map(g => (g.amount ? `${g.label} ${g.done}/${g.amount} ${periodNow(g.period)}` : `${g.label} ${g.done} ${periodNow(g.period)} (no number)`)).join(', ')}${pace ? ` - ${pace.status}, about ${Math.round(pace.runsPerDay)} runs a day${pace.parallel > 1 ? `, ${pace.parallel} at once` : ''}` : ''}`;
}

const TOOLS: Tool[] = [
  // --- Requests ---
  {
    name: 'list_requests',
    description: "Requests agents filed for things they can't do themselves: what they need, why, where each stands, and the conversation with the Agency Engineer.",
    schema: obj({ include_closed: { type: 'boolean', description: 'Closed ones too (default: open only)' } }),
    run: async a => {
      const rows = all<{ id: number; agent_id: string; what: string; why: string; evidence: string | null; status: string; stage: string | null; answer: string | null }>(
        `SELECT * FROM requests ${a.include_closed ? '' : "WHERE status = 'open'"} ORDER BY id`,
      );
      if (!rows.length) return 'No requests.';
      const out = [];
      for (const r of rows) {
        const thread = all<{ from_who: string; text: string }>('SELECT from_who, text FROM request_messages WHERE request_id = ? ORDER BY id', r.id);
        out.push({
          id: r.id,
          from: `${(await readMeta(r.agent_id))?.name ?? r.agent_id} (${r.agent_id})`,
          status: r.status,
          stage: r.stage,
          needs: r.what,
          why: r.why,
          evidence: r.evidence,
          answer: r.answer,
          conversation: thread.map(m => `${m.from_who === 'you' ? 'Person' : 'Agency Engineer'}: ${m.text}`),
        });
      }
      return json(out);
    },
  },
  {
    name: 'answer_request',
    description: "Close a request: done (say what was done, so the agent knows) or rejected (anything drafted for it is discarded). The agent hears on its next run.",
    schema: obj({ request_id: num('The request number'), status: { type: 'string', enum: ['done', 'rejected'] }, answer: str('What was done, or why not') }, ['request_id', 'status']),
    run: async a => {
      const r = one<{ agent_id: string }>('SELECT agent_id FROM requests WHERE id = ?', Number(a.request_id));
      if (r) await requireMakerOrAdmin(r.agent_id);
      return (await answerRequest(Number(a.request_id), a.status as 'done' | 'rejected', a.answer ? String(a.answer) : null))
        ? `Request #${a.request_id} closed as ${a.status}.`
        : `Request #${a.request_id} isn't open.`;
    },
  },

  {
    name: 'reply_to_request',
    description: 'Write in an open request, to the Agency Engineer (as in the app: everyone on the request sees it, and the Engineer is woken to answer).',
    schema: obj({ request_id: num('The request number'), text: str('What to say') }, ['request_id', 'text']),
    run: async a => {
      const r = one<{ id: number; status: string; agent_id: string }>('SELECT id, status, agent_id FROM requests WHERE id = ?', Number(a.request_id));
      if (!r || r.status !== 'open') throw new Error(`Request #${a.request_id} isn't open.`);
      await requireMakerOrAdmin(r.agent_id);
      const text = scrub(String(a.text ?? '')).trim();
      if (!text) throw new Error('Nothing to send.');
      await personWrites(r, text);
      return `Sent on request #${r.id}; the Agency Engineer answers there (list_requests shows the conversation).`;
    },
  },

  // --- Agents ---
  {
    name: 'give_task',
    description: "Give an agent a job, from you: it starts on it as soon as it can and marks it done with the result (agent_activity shows it). For a question or a quick word, run_agent with a message instead.",
    schema: obj({ agent_id: str('The agent id (list_agents)'), task: str('The whole job, with everything it needs to know') }, ['agent_id', 'task']),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      if (meta.builtIn || meta.service) throw new Error(`${meta.name} is built in and takes no jobs. Requests and its DM channel reach the Agency Engineer.`);
      await requireMakerOrAdmin(agentId, null, currentActor(), 'give it a job');
      const st = stateOf(agentId).state;
      if (st === 'stopped' || st === 'draining') throw new Error(`${meta.name} is ${st === 'stopped' ? 'stopped' : 'on standby'}, so it wouldn't start on it. Turn it back on first (set_agent, state: active).`);
      const task = scrub(String(a.task ?? '')).trim().slice(0, 6000);
      if (!task) throw new Error('No task given.');
      const by = currentActor();
      const t = exec('INSERT INTO tasks (agent_id, from_agent, task, created_at) VALUES (?, NULL, ?, ?)', agentId, task, Date.now());
      book(agentId, 'handoff', `Task #${t.lastInsertRowid} from ${by.name || 'a person'}: ${task}`);
      return `Given to ${meta.name} as task #${t.lastInsertRowid}; it starts as soon as it can.`;
    },
  },
  {
    name: 'list_agents',
    description:
      'Every agent: id, name, department, owner, state (active / draining = standby / stopped), its goals (each with the count so far in its period - hour, day, week, month or year - against its amount) and the pace they have it at (an agent with no goal does not run), models, whether it is built in, its spend this month against its own limit, when it last ran (and whether it is running now), and how many approvals and open jobs it has. Filter by state or department.',
    schema: obj({ state: { type: 'string', enum: ['active', 'draining', 'stopped'], description: 'Optional: only these' }, department: str('Optional: only this department') }),
    run: async a => {
      const choices = await allChoices();
      const month = monthSpendByAgent(Date.now());
      const dept = lc(a.department);
      const out = [];
      for (const id of await listIds()) {
        const m = await readMeta(id);
        if (!m) continue;
        const st = stateOf(id);
        if (a.state && st.state !== a.state) continue;
        if (dept && String(m.department ?? '').toLowerCase() !== dept) continue;
        const last = one<{ started_at: number; status: string; id: string }>('SELECT id, started_at, status FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1', id);
        const running = one<{ id: string }>("SELECT id FROM runs WHERE agent_id = ? AND status = 'running' ORDER BY started_at DESC LIMIT 1", id);
        out.push({
          id,
          name: m.name,
          department: m.department,
          owner: m.builtIn ? 'built in' : m.owner,
          status: m.status,
          state: st.state,
          ...(await goalFacts(id, !!m.builtIn)),
          models: choices[id] ?? [],
          builtIn: !!m.builtIn,
          month_cost_usd: month.get(id)?.cost_usd ?? 0,
          month_unpriced_runs: month.get(id)?.unpriced_runs ?? 0,
          cap_usd: m.builtIn ? null : st.spend_cap_usd,
          last_run_at: last ? new Date(last.started_at).toISOString() : null,
          running_now: running?.id ?? null,
          pending_approvals: one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE agent_id = ? AND status = 'pending' AND expires_at > ?", id, Date.now())?.n ?? 0,
          open_tasks: one<{ n: number }>("SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status = 'open'", id)?.n ?? 0,
        });
      }
      return json(out);
    },
  },
  {
    name: 'read_agent',
    description:
      "One agent, a part at a time. section: overview (the default: state, models, spend this month against its limit, file sizes, the Charter's headings, its last runs with cost, and counts of memory, open jobs, approvals and queued actions) | charter | tools | kpi (a file; long ones come in windows - offset for the next) | runs (newest first, with cost) | memory (newest first; query filters). heading: with charter, just that section of it.",
    schema: obj(
      {
        agent_id: str('The agent id'),
        section: { type: 'string', enum: ['overview', 'charter', 'tools', 'kpi', 'runs', 'memory'], description: 'What to read (default overview)' },
        heading: str("Optional, with charter: one heading's section (the overview lists them)"),
        query: str('Optional, with memory: only notes containing this'),
        offset: num('Optional: charter/tools/kpi - the character to start at; runs/memory - how many to skip'),
        limit: num('Optional: charter/tools/kpi - characters (default 15000); runs/memory - how many (default 10 / 20)'),
      },
      ['agent_id'],
    ),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      const section = String(a.section ?? 'overview');
      if (section in SECTION_FILE) {
        const file = SECTION_FILE[section as keyof typeof SECTION_FILE];
        const text = await agentFile(agentId, file);
        if (!text) return `${meta.name} has no ${file}.`;
        if (a.heading) {
          if (file !== 'CHARTER.md') throw new Error('heading is for the Charter (section: charter).');
          const h = findHeading(text, String(a.heading));
          return windowOf(text.slice(h.start, h.end), a.offset, a.limit, `"${h.text}"`);
        }
        return windowOf(text, a.offset, a.limit, file);
      }
      if (section === 'runs') {
        const { offset, limit } = page(a, 10);
        const total = one<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?', agentId)?.n ?? 0;
        const runs = all<{ id: string; trigger: string; status: string; started_at: number; ended_at: number | null; model: string | null; cost_usd: number | null; acts: number; summary: string | null; error: string | null }>(
          'SELECT id, trigger, status, started_at, ended_at, model, cost_usd, acts, summary, error FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?',
          agentId,
          limit,
          offset,
        );
        return json({
          agent: `${meta.name} (${agentId})`,
          total,
          next_offset: offset + runs.length < total ? offset + runs.length : null,
          runs: runs.map(r => ({ id: r.id, at: new Date(r.started_at).toISOString(), trigger: r.trigger, status: r.status, minutes: r.ended_at ? Math.round((r.ended_at - r.started_at) / 6000) / 10 : null, model: r.model, cost_usd: r.cost_usd, acts: r.acts, summary: (r.summary ?? r.error ?? '').slice(0, 600) })),
        });
      }
      if (section === 'memory') {
        const { offset, limit } = page(a, 20);
        const q = String(a.query ?? '').trim();
        const where = `agent_id = ?${q ? " AND text LIKE ? ESCAPE '\\'" : ''}`;
        const params: string[] = q ? [agentId, `%${q.replace(/[\\%_]/g, m => `\\${m}`)}%`] : [agentId];
        const total = one<{ n: number }>(`SELECT COUNT(*) AS n FROM memories WHERE ${where}`, ...params)?.n ?? 0;
        const notes = all<{ id: number; text: string; created_at: number }>(`SELECT id, text, created_at FROM memories WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
        return json({ agent: `${meta.name} (${agentId})`, total, next_offset: offset + notes.length < total ? offset + notes.length : null, notes: notes.map(n => ({ id: n.id, at: new Date(n.created_at).toISOString(), text: n.text })) });
      }
      if (section !== 'overview') throw new Error('section is overview, charter, tools, kpi, runs or memory.');
      const st = stateOf(agentId);
      const month = monthSpendByAgent(Date.now()).get(agentId);
      const charter = await agentFile(agentId, 'CHARTER.md');
      const sizes = await Promise.all(Object.keys(FILES).map(async f => `${f} ${(await agentFile(agentId, f)).length.toLocaleString('en')} chars`));
      const runs = all<{ trigger: string; status: string; started_at: number; cost_usd: number | null; acts: number; summary: string | null; error: string | null }>(
        'SELECT trigger, status, started_at, cost_usd, acts, summary, error FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 5',
        agentId,
      );
      const count = (sql: string) => one<{ n: number }>(sql, agentId)?.n ?? 0;
      const outline = outlineOf(charter);
      return [
        `# ${meta.name} (${agentId})${meta.builtIn ? ' - built in' : ''}`,
        `Department: ${meta.department ?? '-'}; owner: ${meta.builtIn ? 'built in' : meta.owner}`,
        `State: ${st.state}`,
        await goalLine(agentId, !!meta.builtIn),
        `Models: ${((await allChoices())[agentId] ?? []).map(m => `${m.connection}/${m.model} (${m.effort})`).join(', ') || 'none'}`,
        `Spend this month: ${usd(month?.cost_usd ?? 0)} over ${month?.runs ?? 0} runs${month?.unpriced_runs ? ` (${month.unpriced_runs} unpriced)` : ''}; limit ${st.spend_cap_usd == null ? 'none of its own' : `$${st.spend_cap_usd}`} (usage has more)`,
        `Files: ${sizes.join(', ')}`,
        `Memory notes: ${count('SELECT COUNT(*) AS n FROM memories WHERE agent_id = ?')}; open jobs: ${count("SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status = 'open'")}; approvals waiting: ${count("SELECT COUNT(*) AS n FROM approvals WHERE agent_id = ? AND status = 'pending'")}; approved, not run yet: ${count("SELECT COUNT(*) AS n FROM approvals WHERE agent_id = ? AND status = 'approved' AND exec_state IN ('queued', 'paused', 'running')")} (list_queue)`,
        `\n## Charter headings (read one: section charter, heading "...")\n${outline.join('\n') || '(no headings: read it with section: charter)'}`,
        `\n## Last runs (section: runs for more)\n${runs.map(r => `- ${new Date(r.started_at).toISOString()} ${r.trigger} ${r.status}, ${usd(r.cost_usd)}, ${r.acts} acts: ${(r.summary ?? r.error ?? '').replace(/\s+/g, ' ').slice(0, 240)}`).join('\n') || 'None yet.'}`,
      ].join('\n');
    },
  },
  {
    name: 'write_agent_file',
    description: "Replace one of an agent's files whole: CHARTER.md (its job), TOOLS.yaml (tools, tiers, approval windows, pace plan) or KPI.yaml (which actions count as output, and each one's goal: amount and period). To change part of one, edit_agent_file. Its next run uses it.",
    schema: obj({ agent_id: str('The agent id'), file: { type: 'string', enum: Object.keys(FILES) }, content: str('The whole new file') }, ['agent_id', 'file', 'content']),
    run: async a => {
      const { agentId, meta, file } = await editableFile(a);
      const content = String(a.content ?? '');
      const before = await saveAgentFile(agentId, file, content);
      return `${file} saved for ${meta.name}. ${diffLine(before, content)}`;
    },
  },
  {
    name: 'edit_agent_file',
    description:
      "Change part of an agent's file without sending it all. Either edits: [{old, new}] - each old must match the file exactly once - or, for CHARTER.md, heading + mode: replace (that section's body; its heading stays) | append (to the end of that section) | insert_after (a new section after it: content starts with its own heading) | delete (the section). append with no heading adds to the end of the file. Checked as write_agent_file is: nothing is saved if the agent wouldn't load.",
    schema: obj(
      {
        agent_id: str('The agent id'),
        file: { type: 'string', enum: Object.keys(FILES) },
        edits: { type: 'array', description: 'Exact replacements, applied in order', items: obj({ old: str('Text that appears exactly once'), new: str('What replaces it') }, ['old', 'new']) },
        heading: str('CHARTER.md: the heading whose section to change (read_agent lists them)'),
        mode: { type: 'string', enum: ['replace', 'append', 'insert_after', 'delete'] },
        content: str('With heading/mode: the text'),
      },
      ['agent_id', 'file'],
    ),
    run: async a => {
      const { agentId, meta, file } = await editableFile(a);
      const before = await agentFile(agentId, file);
      if (!before) throw new Error(`${meta.name} has no ${file} yet: write_agent_file makes it.`);
      let after: string;
      if (Array.isArray(a.edits) && a.edits.length) {
        if (a.mode || a.heading) throw new Error('Give edits, or heading + mode - not both.');
        after = applyEdits(before, a.edits as Edit[]);
      } else if (a.mode) {
        if (file !== 'CHARTER.md' && a.heading) throw new Error('heading is for CHARTER.md; for YAML files use edits.');
        const mode = String(a.mode) as SectionMode;
        if (mode !== 'delete' && !String(a.content ?? '').trim()) throw new Error(`mode ${mode} needs content.`);
        after = editSection(before, a.heading ? String(a.heading) : null, String(a.content ?? ''), mode);
      } else throw new Error('Give edits: [{old, new}], or heading + mode + content.');
      if (after === before) return 'No change.';
      await saveAgentFile(agentId, file, after);
      return `${file} saved for ${meta.name}. ${diffLine(before, after)}`;
    },
  },
  {
    name: 'list_models',
    description: 'The AI models connected in the app, which agents can be given (set_agent_models).',
    schema: obj({}),
    run: async () => json((await availableModels()).map(m => ({ connection: m.connection, name: m.name, models: m.models, efforts: m.efforts }))),
  },
  {
    name: 'set_agent_models',
    description: "An agent's models: up to three, in order of preference; it falls to the next when one fails. Each {connection, model, effort: low|medium|high|max}, from list_models.",
    schema: obj(
      { agent_id: str('The agent id'), models: { type: 'array', items: obj({ connection: str('Connection id'), model: str('Model id'), effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] } }, ['connection', 'model']) } },
      ['agent_id', 'models'],
    ),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      await requireMakerOrAdmin(agentId, null, currentActor(), 'change its model');
      const avail = await availableModels();
      const wanted = (a.models as { connection: string; model: string }[]) ?? [];
      const bad = wanted.filter(m => !avail.some(x => x.connection === m.connection && x.models.includes(m.model)));
      if (bad.length) throw new Error(`Not connected: ${bad.map(m => `${m.connection}/${m.model}`).join(', ')}. list_models shows what is.`);
      const saved = await setChoices(agentId, wanted);
      return `${meta.name} runs on: ${saved.map(c => `${c.connection}/${c.model} (${c.effort})`).join(', ') || 'nothing'}.`;
    },
  },
  {
    name: 'set_agent',
    description:
      "An agent's goal or state. A goal is one of its outputs, an amount and a period (goal: the output's name as list_agents gives it; amount: a whole number, 1 to 1,000,000; period: hour, day, week, month or year - left out, the period that goal has now, else day): the agency paces the agent to reach it - more runs, more at once - and eases it off once there. Nobody sets how hard an agent works; its goals do. Every agent needs a goal and one with none does not run, so amount 0 (no number for that output) is refused on its only goal with a number. A new kind of goal is the Agency Engineer's to add (reply_to_request or run_agent on the engineer). State: active, draining = standby: starts nothing itself, stopped: runs nothing. Built-in agents have neither.",
    schema: obj(
      {
        agent_id: str('The agent id'),
        goal: str('One of its outputs, e.g. "emails sent"'),
        amount: { type: 'number', description: 'How many per period; with goal' },
        period: { type: 'string', enum: [...PERIODS], description: 'What the amount is per; with goal' },
        state: { type: 'string', enum: ['active', 'draining', 'stopped'] },
      },
      ['agent_id'],
    ),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      if (meta.builtIn) throw new Error(`${meta.name} is built in: it has no goal or state of its own.`);
      await requireMakerOrAdmin(agentId, null, currentActor(), 'change it');
      stateOf(agentId);
      const now = Date.now();
      if (a.goal !== undefined) {
        const agent = await loadAgent(agentId);
        const want = String(a.goal).trim().toLowerCase();
        const label = agent?.output.find(o => o.label.toLowerCase() === want)?.label;
        if (!agent || !label) throw new Error(`${meta.name}'s outputs are: ${[...new Set(agent?.output.map(o => o.label) ?? [])].join(', ') || 'none'}. A new kind of goal is the Agency Engineer's to add.`);
        const g = checkGoal(agent, label, a.amount, a.period, now);
        setGoal(agentId, label, g.amount, g.period, now);
      }
      if (a.state !== undefined) {
        const state = String(a.state);
        if (!['active', 'draining', 'stopped'].includes(state)) throw new Error('state is active, draining or stopped.');
        exec('UPDATE agent_state SET state = ?, updated_at = ? WHERE agent_id = ?', state, now, agentId);
        if (state === 'stopped') abortRun(agentId);
        if (state === 'active') exec('UPDATE agent_state SET fail_streak = 0, backoff_until = NULL WHERE agent_id = ?', agentId);
        // Same as POST /api/runner/agent: leaving stopped ends setup so the card
        // doesn't keep "Start the agent" while Stop/Standby already show.
        if (state !== 'stopped') exec('UPDATE agent_state SET setup = NULL WHERE agent_id = ?', agentId);
      }
      const st = stateOf(agentId);
      const goals = await goalLine(agentId, false);
      return `${meta.name}: ${st.state}.${goals ? ` ${goals}` : ''}`;
    },
  },
  {
    name: 'builder_guide',
    description:
      "Read this first when making an agent: the agent builder's whole brief - how agents work here, the tool catalogue and default tiers, the tools every agent gets, this organization and the person, the fleet, connected services and their tools and events, the connected models, how to interview the person, and how to tier. create_agent's fields carry the rest.",
    schema: obj({}),
    run: async () => builderGuide(await hostContext()),
  },
  {
    name: 'check_build',
    description: "Check a build before creating it, without creating anything: the same input as create_agent. Answers with what's wrong, or what it would make.",
    schema: z.toJSONSchema(BuildSchema) as Record<string, unknown>,
    run: async a => {
      const parsed = BuildSchema.safeParse(a);
      if (!parsed.success) return `The build doesn't fit: ${parsed.error.issues.slice(0, 8).map(i => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`;
      const b = parsed.data;
      const fleet = await scanFleet();
      const fleetIds = new Set([...fleet.tools.map(t => t.id), ...integrationToolIds()]);
      const models = await availableModels();
      const eventIds = new Set(liveEventIds());
      const problems = buildProblems(b, fleetIds, eventIds, models);
      if (problems.length) return `Fix these first:\n${problems.map(p => `- ${p}`).join('\n')}`;
      const files = compose(b, slug(b.name), fleetIds, models, eventIds);
      const t = parse(files.tools) as { tool_tiers: Record<string, string>; events?: string[] };
      const built = new Set([...registeredToolIds(), ...CATALOG_INDEX.keys()]);
      const unbuilt = Object.keys(t.tool_tiers).filter(x => !built.has(x));
      return [
        `Looks right: ${b.name}, ${Object.keys(t.tool_tiers).length} tools, KPIs ${b.kpi.map(k => k.label).join(', ') || 'none'}.`,
        t.events?.length ? `Wakes on: ${t.events.join(', ')}` : 'Wakes on: its schedule only',
        unbuilt.length ? `Not built yet (the Agency Engineer would be asked): ${unbuilt.join(', ')}` : 'Every tool it uses exists.',
        `Models: ${files.models.map(m => `${m.connection}/${m.model}`).join(', ')}`,
      ].join('\n');
    },
  },
  {
    name: 'create_agent',
    description:
      "Add a new agent, as the app's agent builder would (read builder_guide first, and talk to the person the way it says): the full build - name, department, Charter, tools with tiers, events, KPIs with a goal (at least one needs an amount of 1 or more), models, pace plan. Every id must exist (the guide lists them) or be one of its own new_tools / new_events, which go to the Agency Engineer as requests. Answers with what it made.",
    schema: z.toJSONSchema(BuildSchema) as Record<string, unknown>,
    run: async a => {
      const parsed = BuildSchema.safeParse(a);
      if (!parsed.success) throw new Error(`The build doesn't fit: ${parsed.error.issues.slice(0, 8).map(i => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`);
      const b = parsed.data;
      const fleet = await scanFleet();
      const fleetIds = new Set([...fleet.tools.map(t => t.id), ...integrationToolIds()]);
      const models = await availableModels();
      const eventIds = new Set(liveEventIds());
      // Refused, not silently dropped: what the builder would never have written.
      const problems = buildProblems(b, fleetIds, eventIds, models);
      if (problems.length) throw new Error(`Not created - fix these and call again:\n${problems.map(p => `- ${p}`).join('\n')}`);
      const taken = new Set(await listIds());
      let id = slug(b.name);
      for (let n = 2; taken.has(id); n++) id = `${slug(b.name)}-${n}`;
      const files = compose(b, id, fleetIds, models, eventIds);
      const owners = (await Promise.all([...taken].map(async x => (await readMeta(x))?.owner))).filter((o): o is string => !!o);
      const person = personFor(hostPerson() ?? owners[0] ?? 'The host');
      const asked = await createAgent({ person, org: hostOrg(), files });
      const tools = parse(files.tools) as { tool_tiers: Record<string, string>; events?: string[]; new_tools?: { id: string }[]; new_events?: { id: string }[]; ferocity?: { every_hours: number[] } };
      return [
        `Created ${b.name} (${id}) for ${person}${hostOrg() ? ` at ${hostOrg()}` : ''}. It's on the dashboard.`,
        `Tools: ${Object.entries(tools.tool_tiers).map(([t, tier]) => `${t} [${tier}]`).join(', ')}`,
        tools.events?.length ? `Wakes on: ${tools.events.join(', ')}` : 'Wakes on: its schedule only',
        asked.length ? `Asked the Agency Engineer for (requests, shown to the person once it needs them):
${asked.map(w => `- ${w}`).join('\n')}` : 'Everything it uses exists already.',
        `Models: ${files.models.map(m => `${m.connection}/${m.model}`).join(', ') || 'none - give it some with set_agent_models'}`,
        `Goals: ${b.kpi.filter(k => k.amount >= 1).map(k => `${Math.floor(k.amount)} ${k.label} per ${k.period ?? 'day'}`).join(', ')} - the agency paces it to them`,
        tools.ferocity ? `Its ordinary schedule, once its goal is reached: every ${tools.ferocity.every_hours[0]} hours` : '',
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'delete_agent',
    description: "Delete an agent: its files go, its approvals and requests are closed, work handed to it is closed as not done. Its past runs stay in Usage. Built-in agents can't be deleted.",
    schema: obj({ agent_id: str('The agent id') }, ['agent_id']),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      await requireMakerOrAdmin(agentId, null, currentActor(), 'delete it');
      await deleteAgent(agentId);
      return `${meta.name} deleted.`;
    },
  },
  {
    name: 'run_agent',
    description: 'Start an agent now. With a message, it answers it in its DM channel (as if the person wrote it); without, it does its job as on Run now.',
    schema: obj({ agent_id: str('The agent id'), message: str('Optional: what to say to it') }, ['agent_id']),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      const text = String(a.message ?? '').trim();
      if (text) {
        if (meta.service) throw new Error(`${meta.name} only records what it decides; it takes no messages.`);
        if (agentId !== FLEET_ENGINEER) await requireMakerOrAdmin(agentId, null, currentActor(), 'message it');
        const by = currentActor();
        const person = agentId === FLEET_ENGINEER ? by.id : null; // the Engineer's chat is per person
        exec("INSERT INTO dm (agent_id, kind, body, at, person_id) VALUES (?, 'you', ?, ?, ?)", agentId, JSON.stringify({ kind: 'you', text, by: by.name, byId: by.id, role: by.role }), Date.now(), person);
        book(agentId, 'your message', text, Date.now(), person);
        return `Sent to ${meta.name}; its answer goes in its DM channel in the app (read_agent shows its last runs).`;
      }
      if (meta.service) throw new Error(`${meta.name} runs only when the agency calls it.`);
      await requireMakerOrAdmin(agentId, null, currentActor(), 'run it');
      const r = queueRunNow(agentId);
      return r.message ? `${meta.name}: ${r.message}` : `${meta.name} starts as soon as it can.`;
    },
  },
  {
    name: 'list_approvals',
    description:
      "Agents' actions waiting on a person in the app (sending, posting, going live...): only the ones that are yours to decide, one short line each (who it goes to, the subject, why, which account sends it), with how many each account would send. detail: true for the whole action. Filter by agent_id, tool or account (the sending mailbox). decide_approval decides one; decide_approvals many, spaced apart if you like.",
    schema: obj({
      agent_id: str('Optional: only this agent'),
      tool: str('Optional: only this tool (e.g. zoho-mail-outreach.zohomail_send_mail)'),
      account: str('Optional: only actions sent from this account or mailbox'),
      detail: { type: 'boolean', description: 'The whole action (every argument), not one line' },
      offset: num('Optional: skip this many'),
      limit: num('Optional: at most this many (default 25)'),
    }),
    run: async a => {
      const account = lc(a.account);
      const rows = (await decidable()).filter(r => (!a.agent_id || r.agent_id === a.agent_id) && (!a.tool || r.tool === a.tool) && matchesAccount(JSON.parse(r.args), account));
      if (!rows.length) return 'Nothing waiting.';
      const { offset, limit } = page(a);
      const names = new Map<string, string>();
      // How many would go out per queue (what a pace spaces) and per sender.
      const by_account: Record<string, number> = {};
      const by_sender: Record<string, number> = {};
      for (const r of rows) {
        const args = JSON.parse(r.args) as Record<string, unknown>;
        const k = `${r.tool} on ${approvalAccount(args) || '(its one account)'}`;
        by_account[k] = (by_account[k] ?? 0) + 1;
        const s = senderOf(args);
        if (s) by_sender[s] = (by_sender[s] ?? 0) + 1;
      }
      const shown = rows.slice(offset, offset + limit);
      const items = [];
      for (const r of shown)
        items.push(a.detail ? { id: r.id, agent: `${await nameOf(r.agent_id, names)} (${r.agent_id})`, tool: r.tool, args: JSON.parse(r.args), expires: new Date(r.expires_at).toISOString() } : approvalLine(r, await nameOf(r.agent_id, names)));
      return json({ total: rows.length, next_offset: offset + shown.length < rows.length ? offset + shown.length : null, by_account, by_sender: Object.keys(by_sender).length ? by_sender : undefined, items });
    },
  },
  {
    name: 'decide_approvals',
    description:
      "Approve or reject many at once: by approval_ids, or every one matching agent_id / tool / account. every_minutes (when approving): space them that far apart per sending account, so a pile of emails doesn't go out at once and trip the mailbox's sending limit - it sets that pace on the account before approving (list_queue shows when each runs). Without it, each runs as soon as it's approved unless its agent already paced the tool.",
    schema: obj(
      {
        approval_ids: { type: 'array', items: { type: 'string' }, description: 'Optional: these (from list_approvals)' },
        agent_id: str('Optional: every one of this agent'),
        tool: str('Optional: every one for this tool'),
        account: str('Optional: every one sent from this account'),
        decision: { type: 'string', enum: ['approved', 'rejected'] },
        note: str('Optional: why, for the agent'),
        every_minutes: num('Optional, approving: at least this many minutes apart per account'),
      },
      ['decision'],
    ),
    run: async a => {
      const decision = a.decision === 'approved' || a.decision === 'rejected' ? a.decision : null;
      if (!decision) throw new Error('decision is approved or rejected.');
      const ids = Array.isArray(a.approval_ids) ? new Set(a.approval_ids.map(String)) : null;
      if (!ids?.size && !a.agent_id && !a.tool && !a.account) throw new Error('Say which: approval_ids, or agent_id / tool / account.');
      const account = lc(a.account);
      const rows = (await decidable()).filter(r => (!ids?.size || ids.has(r.id)) && (!a.agent_id || r.agent_id === a.agent_id) && (!a.tool || r.tool === a.tool) && matchesAccount(JSON.parse(r.args), account));
      if (!rows.length) throw new Error('None waiting match that (list_approvals shows them).');
      const missing = ids ? [...ids].filter(id => !rows.some(r => r.id === id)) : [];
      const by = currentActor();
      const note = a.note ? scrub(String(a.note)).trim() || null : null;
      const every = Math.max(0, Math.min(24 * 60, Number(a.every_minutes) || 0));
      const now = Date.now();
      // The pace first, per agent, tool and account, long enough for all of them.
      if (decision === 'approved' && every) {
        const groups = new Map<string, { agent: string; tool: string; account: string; n: number }>();
        for (const r of rows) {
          const acc = approvalAccount(JSON.parse(r.args));
          const k = `${r.agent_id}|${r.tool}|${acc}`;
          groups.set(k, { agent: r.agent_id, tool: r.tool, account: acc, n: (groups.get(k)?.n ?? 0) + 1 });
        }
        for (const g of groups.values())
          paceMine(g.agent, { tool: g.tool, account: g.account || undefined, every_minutes: every, for_hours: Math.min(7 * 24, Math.ceil((g.n * every) / 60) + 1), why: `${by.name || 'A person'} approved ${g.n} at once and asked for them ${every} min apart` }, now);
      }
      const results: { id: string; outcome: string }[] = [];
      for (const r of rows) {
        await requireMakerOrAdmin(r.agent_id, null, by, 'decide this', r.agent_id === DOCTOR ? ((JSON.parse(r.args) as { agent_id?: string }).agent_id ?? null) : null);
        try {
          const out = await decideApproval(r.id, decision, note, book, undefined, undefined, by);
          results.push({ id: r.id, outcome: decision === 'rejected' ? 'rejected' : !out.ran ? String(out.result ?? 'queued') : out.ok ? 'done' : `failed: ${String(out.result ?? '').slice(0, 300)}` });
        } catch (e) {
          results.push({ id: r.id, outcome: `not decided: ${(e as Error).message}` });
        }
      }
      const count = (re: RegExp) => results.filter(x => re.test(x.outcome)).length;
      const head =
        decision === 'rejected'
          ? `Rejected ${count(/^rejected/)}; their agents are told.`
          : `Approved ${results.length - count(/^not decided/)}: ${count(/^done/)} ran, ${count(/^Approved\./)} queued or held, ${count(/^failed/)} failed.${every ? ` Paced ${every} min apart per account (list_queue shows when each runs).` : ''}`;
      return json({ summary: head, not_found: missing.length ? missing : undefined, results });
    },
  },

  {
    name: 'decide_approval',
    description: "Approve or reject one of the actions in list_approvals, as on the Approvals screen: approved, it runs now and the agent hears the result; rejected, the agent is told (with the note, if any).",
    schema: obj({ approval_id: str('The id from list_approvals'), decision: { type: 'string', enum: ['approved', 'rejected'] }, note: str('Optional: why, for the agent') }, ['approval_id', 'decision']),
    run: async a => {
      const id = String(a.approval_id ?? '');
      const decision = a.decision === 'approved' || a.decision === 'rejected' ? a.decision : null;
      if (!decision) throw new Error('decision is approved or rejected.');
      const row = one<{ agent_id: string; status: string; request: number | null; about: string | null }>(
        "SELECT agent_id, status, json_extract(args, '$.request_id') AS request, json_extract(args, '$.agent_id') AS about FROM approvals WHERE id = ?",
        id,
      );
      if (!row) throw new Error(`No approval "${id}". list_approvals shows what's waiting.`);
      if (row.status !== 'pending') throw new Error(`That one is already ${row.status}.`);
      await requireMakerOrAdmin(row.agent_id, row.request == null ? null : Number(row.request), currentActor(), 'decide this', row.agent_id === DOCTOR ? row.about : null);
      const note = a.note ? scrub(String(a.note)).trim() || null : null;
      const by = currentActor();
      const out = await decideApproval(id, decision, note, book, undefined, undefined, by);
      if (decision === 'rejected') return 'Rejected; the agent is told.';
      if (out.ok && !out.ran) return String(out.result ?? 'Approved; it runs when its agent scheduled it.');
      return out.ok ? `Approved and done: ${String(out.result ?? '').slice(0, 2000)}` : `Approved, but it failed when it ran: ${String(out.result ?? '').slice(0, 2000)}`;
    },
  },

  // --- What the agency did ---
  {
    name: 'agency_today',
    description:
      "What the whole agency did since a time (default: the start of today, the agency's own clock): per agent its runs, output actions, cost and last summary; the total cost against the monthly limits; what's waiting on a person (approvals, open requests); and any tool held after a failure (e.g. a mailbox that hit its sending limit). usage breaks cost down further.",
    schema: obj({ since: str('Optional: an ISO date or time, e.g. 2026-11-05 or 2026-11-05T09:00') }),
    run: async a => {
      const since = sinceOf(a.since);
      const now = Date.now();
      const month = monthSpendByAgent(now);
      const out = [];
      let total = 0;
      let unpriced = 0;
      for (const id of await listIds()) {
        const m = await readMeta(id);
        if (!m) continue;
        const runs = all<{ status: string; summary: string | null; acts: number; started_at: number; cost_usd: number | null }>('SELECT status, summary, acts, started_at, cost_usd FROM runs WHERE agent_id = ? AND started_at >= ? ORDER BY started_at DESC', id, since);
        if (!runs.length) continue;
        const cost = runs.reduce((n, r) => n + (r.cost_usd ?? 0), 0);
        const un = runs.filter(r => r.cost_usd == null).length;
        total += cost;
        unpriced += un;
        const cap = m.builtIn ? null : stateOf(id).spend_cap_usd;
        out.push({
          agent: `${m.name} (${id})`,
          runs: runs.length,
          failed: runs.filter(r => r.status === 'failed').length,
          output_actions: runs.reduce((n, r) => n + r.acts, 0),
          cost_usd: roundUsd(cost),
          unpriced_runs: un || undefined,
          month_cost_usd: month.get(id)?.cost_usd ?? 0,
          cap_usd: cap ?? undefined,
          near_cap: cap ? (month.get(id)?.cost_usd ?? 0) >= cap * 0.8 : undefined,
          last_summary: (runs.find(r => r.summary)?.summary ?? '').slice(0, 800) || null,
        });
      }
      const approvals = one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending' AND expires_at > ?", now)?.n ?? 0;
      const requests = one<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE status = 'open'")?.n ?? 0;
      const queued = one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE status = 'approved' AND exec_state IN ('queued', 'paused', 'running')")?.n ?? 0;
      const held = all<Pace>('SELECT * FROM action_pace WHERE held_since IS NOT NULL').map(p => ({ agent: p.agent_id, tool: p.tool, account: p.account || '(its one account)', since: new Date(p.held_since!).toISOString(), error: (p.held_error ?? '').slice(0, 300) }));
      const orgCap = getSetting<number | null>('spend_cap_org_usd', null);
      const monthTotal = [...month.values()].reduce((n, t) => n + t.cost_usd, 0);
      return json({
        since: new Date(since).toISOString(),
        cost: { since_usd: roundUsd(total), unpriced_runs: unpriced || undefined, today_usd: roundUsd(spentToday(now)), month_usd: roundUsd(monthTotal), org_cap_usd: orgCap, note: 'usage has the breakdown and where these numbers come from.' },
        agents: out,
        waiting_on_people: { approvals, open_requests: requests },
        approved_not_run: queued || undefined,
        held_tools: held.length ? held : undefined,
        quiet: out.length ? undefined : 'No agent ran in that time.',
      });
    },
  },
  {
    name: 'agent_activity',
    description:
      "What one agent did between two times (default: since the start of today): its DM channel posts (each run's write-up, the tools it used, and the run's model and cost), the people's messages to it, and the jobs given to it. Newest kept when there are more than limit; for older ones, pass until (the oldest post's time, as older_until gives it). kinds narrows it to runs, messages or tasks.",
    schema: obj(
      {
        agent_id: str('The agent id (list_agents)'),
        since: str('Optional: an ISO date or time'),
        until: str('Optional: only before this time (for older pages)'),
        limit: num('Optional: at most this many posts, newest kept (default 30)'),
        kinds: { type: 'array', items: { type: 'string', enum: ['runs', 'messages', 'tasks'] }, description: 'Optional: only these (default all)' },
        include_tools: { type: 'boolean', description: 'Each run’s list of tools used (default true)' },
      },
      ['agent_id'],
    ),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      const since = sinceOf(a.since);
      const until = a.until ? sinceOf(a.until) : Number.MAX_SAFE_INTEGER;
      const limit = Math.max(1, Math.min(200, Number(a.limit) || 30));
      const kinds = new Set(Array.isArray(a.kinds) && a.kinds.length ? a.kinds.map(String) : ['runs', 'messages', 'tasks']);
      const withTools = a.include_tools !== false;
      // The Agency Engineer keeps one chat per person, as in the app.
      const me = agentId === FLEET_ENGINEER ? currentActor().id : null;
      const wantKinds = [kinds.has('runs') ? 'run' : null, kinds.has('messages') ? 'you' : null].filter((k): k is string => !!k);
      const rows = wantKinds.length
        ? all<{ kind: string; body: string; at: number; run_id: string | null }>(
            `SELECT kind, body, at, run_id FROM dm WHERE agent_id = ? AND at >= ? AND at < ? AND kind IN (${wantKinds.map(() => '?').join(', ')}) AND (? IS NULL OR person_id IS NULL OR person_id = ?) ORDER BY at DESC, id DESC LIMIT ?`,
            agentId,
            since,
            until,
            ...wantKinds,
            me,
            me,
            limit + 1,
          )
        : [];
      const more = rows.length > limit;
      const posts = rows
        .slice(0, limit)
        .reverse()
        .map(p => {
          const b = JSON.parse(p.body) as { text?: string; by?: string; outcome?: string; trigger?: string; tools?: { server: string; tool: string; status: string }[] };
          const at = new Date(p.at).toISOString();
          if (p.kind === 'you') return { at, from: b.by ?? 'A person', text: b.text ?? '' };
          const run = p.run_id ? one<{ model: string | null; cost_usd: number | null; acts: number }>('SELECT model, cost_usd, acts FROM runs WHERE id = ?', p.run_id) : undefined;
          return {
            at,
            from: meta.name,
            run_id: p.run_id ?? undefined,
            trigger: b.trigger,
            outcome: b.outcome,
            model: run?.model ?? undefined,
            cost_usd: run ? run.cost_usd : undefined,
            acts: run?.acts,
            text: b.text ?? '',
            tools: withTools ? (b.tools ?? []).map(t => `${t.server}.${t.tool}${t.status === 'ok' ? '' : ' (failed)'}`) : undefined,
          };
        });
      const tasks = kinds.has('tasks')
        ? all<{ id: number; task: string; status: string; result: string | null; from_agent: string | null }>(
            'SELECT id, task, status, result, from_agent FROM tasks WHERE agent_id = ? AND (status = ? OR created_at >= ? OR done_at >= ?) ORDER BY id',
            agentId,
            'open',
            since,
            since,
          ).map(t => ({ id: t.id, from: t.from_agent ?? 'a person', task: t.task, status: t.status, result: t.result }))
        : undefined;
      return json({ agent: `${meta.name} (${agentId})`, since: new Date(since).toISOString(), posts, older_until: more && posts.length ? posts[0].at : undefined, tasks });
    },
  },
  {
    name: 'latest_report',
    description: "An agent's latest report: the write-up of its last run that made one, and where its reports go (the place its person chose, e.g. a Drive folder).",
    schema: obj({ agent_id: str('The agent id (list_agents)') }, ['agent_id']),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      const last = one<{ id: string; trigger: string; status: string; started_at: number; summary: string | null }>(
        "SELECT id, trigger, status, started_at, summary FROM runs WHERE agent_id = ? AND summary IS NOT NULL AND summary != '' ORDER BY started_at DESC LIMIT 1",
        agentId,
      );
      const post = last ? one<{ body: string }>("SELECT body FROM dm WHERE run_id = ? AND kind = 'run' ORDER BY id DESC LIMIT 1", last.id) : undefined;
      const text = (post ? (JSON.parse(post.body) as { text?: string }).text : null) || last?.summary || '';
      const where = reportDefault(meta.owner);
      return [
        `# ${meta.name}: latest report`,
        last ? `Run of ${new Date(last.started_at).toISOString()} (${last.trigger}, ${last.status})\n\n${text}` : 'No report yet: it has not finished a run with a write-up.',
        `\nWhere its reports go: ${where ? `${where.where} (via ${where.tool})` : "not chosen yet - its instructions say, or it asks the first time it has one."}`,
      ].join('\n');
    },
  },

  // --- Cost ---
  {
    name: 'usage',
    description: `What the agency's runs cost, between two times (default: this calendar month so far), grouped by agent, day, model, connection or trigger - with each agent's monthly limit and what's left of it, and the organization's. The same numbers as Settings > Usage. ${COST_NOTE}`,
    schema: obj({
      since: str('Optional: an ISO date or time (default: the 1st of this month)'),
      until: str('Optional: up to this time (default: now)'),
      group_by: { type: 'string', enum: [...GROUPS], description: 'Default agent' },
      agent_id: str('Optional: only this agent'),
    }),
    run: async a => {
      const now = Date.now();
      const since = a.since ? sinceOf(a.since) : startOfMonth(now);
      const until = a.until ? sinceOf(a.until) : now + 1;
      const group = (String(a.group_by ?? 'agent') as Group);
      if (!GROUPS.includes(group)) throw new Error(`group_by is one of ${GROUPS.join(', ')}.`);
      if (a.agent_id) await agentOrThrow(a.agent_id);
      const { total, groups } = spendBy(spendRows(since, until, a.agent_id ? String(a.agent_id) : null), group);
      const month = monthSpendByAgent(now);
      const names = new Map<string, string>();
      const rows = [];
      for (const g of groups) {
        if (group !== 'agent') {
          rows.push(g);
          continue;
        }
        const m = await readMeta(g.key);
        const cap = m?.builtIn ? null : (stateOf(g.key).spend_cap_usd ?? null);
        const spent = month.get(g.key)?.cost_usd ?? 0;
        rows.push({ ...g, agent: `${await nameOf(g.key, names)} (${g.key})`, month_cost_usd: spent, cap_usd: cap, left_usd: cap == null ? null : roundUsd(Math.max(0, cap - spent)) });
      }
      const orgCap = getSetting<number | null>('spend_cap_org_usd', null);
      const monthTotal = roundUsd([...month.values()].reduce((n, t) => n + t.cost_usd, 0));
      return json({
        from: new Date(since).toISOString(),
        to: new Date(Math.min(until, now)).toISOString(),
        group_by: group,
        total,
        groups: rows,
        limits: { org_cap_usd: orgCap, month_usd: monthTotal, org_left_usd: orgCap == null ? null : roundUsd(Math.max(0, orgCap - monthTotal)), today_usd: roundUsd(spentToday(now)) },
        where_from: COST_NOTE,
      });
    },
  },

  // --- Approved actions waiting to run, and their pace ---
  {
    name: 'list_queue',
    description:
      "Approved actions that haven't run yet: when each runs, and why it waits (a pace, a schedule, or held after a failure - with the error). Also every pace set on a tool, every hold, and how many ran per account in the last hour and day. Filter by agent_id, tool or account.",
    schema: obj({ agent_id: str('Optional: only this agent'), tool: str('Optional: only this tool'), account: str('Optional: only this account or sender') }),
    run: async a => {
      const now = Date.now();
      const account = lc(a.account);
      const names = new Map<string, string>();
      const keep = (r: { agent_id: string; tool: string }) => (!a.agent_id || r.agent_id === a.agent_id) && (!a.tool || r.tool === a.tool);
      const waiting = scheduledRows().filter(r => keep(r) && (!account || r.account === account || senderOf(JSON.parse(r.args)) === account));
      const items = [];
      for (const r of waiting.slice(0, 100)) {
        const args = JSON.parse(r.args) as Record<string, unknown>;
        const line = approvalLine({ id: r.id, agent_id: r.agent_id, tool: r.tool, args: r.args, expires_at: r.due_at ?? now }, await nameOf(r.agent_id, names));
        items.push({
          id: r.id,
          agent: line.agent,
          tool: r.tool,
          account: r.account || '(its one account)',
          from: senderOf(args),
          to: line.to,
          what: line.what,
          state: r.exec_state === 'paused' ? 'held after a failure' : r.exec_state === 'running' ? 'running now' : (r.due_at ?? 0) <= now ? 'runs now' : `runs ${new Date(r.due_at!).toISOString()} (${clock(r.due_at!)})`,
          why: r.plan,
        });
      }
      const paces = all<Pace>('SELECT * FROM action_pace WHERE (every_ms IS NOT NULL AND until > ?) OR held_since IS NOT NULL ORDER BY agent_id, tool', now)
        .filter(p => keep(p) && (!account || p.account === account || p.account === '*'))
        .map(p => ({
          agent: p.agent_id,
          tool: p.tool,
          account: p.account === '*' ? 'each account' : p.account || '(its one account)',
          pace: p.every_ms && p.until && p.until > now ? `${mins(p.every_ms)} apart until ${new Date(p.until).toISOString()}` : undefined,
          why: p.why ?? undefined,
          held: p.held_since ? { since: new Date(p.held_since).toISOString(), error: (p.held_error ?? '').slice(0, 300) } : undefined,
        }));
      const ran = all<{ agent_id: string; tool: string; account: string; hour: number; day: number; failed: number }>(
        "SELECT agent_id, tool, account, SUM(ran_at > ?) AS hour, COUNT(*) AS day, SUM(exec_state IN ('failed', 'interrupted')) AS failed FROM approvals WHERE ran_at > ? AND exec_state IN ('done', 'failed', 'interrupted') GROUP BY agent_id, tool, account ORDER BY day DESC",
        now - 3_600_000,
        now - 86_400_000,
      )
        .filter(s => keep(s) && (!account || s.account === account))
        .map(s => ({ agent: s.agent_id, tool: s.tool, account: s.account || '(its one account)', last_hour: s.hour, last_day: s.day, failed: s.failed || undefined }));
      return json({ waiting: waiting.length, items, more: waiting.length > 100 ? waiting.length - 100 : undefined, paces, ran_lately: ran });
    },
  },
  {
    name: 'set_pace',
    description:
      "Space one agent's approved actions for a tool: at least every_minutes apart per account, for the next hours - approvals that come in meanwhile wait their turn instead of running at once (use it before approving a pile of emails from one mailbox). account: one account, or leave it out for each of the tool's accounts. every_minutes 0 removes the pace. Ones already approved keep their times (schedule_queue moves those).",
    schema: obj(
      {
        agent_id: str('The agent id'),
        tool: str('The tool id, e.g. zoho-mail-outreach.zohomail_send_mail (list_approvals and list_queue show them)'),
        account: str('Optional: one account (list_queue shows them); default each account'),
        every_minutes: num('At least this many minutes apart (0 removes the pace)'),
        hours: num('For how long (default 24, at most 168)'),
        why: str('Optional: shown on each action it delays'),
      },
      ['agent_id', 'tool', 'every_minutes'],
    ),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      await requireMakerOrAdmin(agentId, null, currentActor(), 'pace its actions');
      const by = currentActor();
      const every = Math.max(0, Number(a.every_minutes) || 0);
      paceMine(agentId, { tool: a.tool, account: a.account, every_minutes: every, for_hours: a.hours ?? 24, why: String(a.why ?? '').trim() || `Set by ${by.name || 'a person'}` }, Date.now());
      const acc = typeof a.account === 'string' && a.account.trim() ? ` on ${a.account.trim().toLowerCase()}` : ', on each account';
      return every
        ? `${meta.name}'s ${a.tool}${acc}: at least ${every} min apart for the next ${Math.min(168, Number(a.hours) || 24)} hours. Its agent sees the pace (approvals.queue_mine) and can change it.`
        : `${meta.name}'s ${a.tool}${acc}: no pace; approved ones run as soon as they're approved.`;
    },
  },
  {
    name: 'schedule_queue',
    description:
      "Move approved actions that haven't run yet (list_queue): run them now, later (after delay_minutes), spread over over_minutes per account, or cancel them - by approval_ids, or every one of an agent, optionally only one tool or account. It also lets go of a hold after a failure, so use it once the cause is fixed (e.g. the mailbox is unblocked). The agent is told how they went once they've run.",
    schema: obj(
      {
        agent_id: str('The agent whose actions these are'),
        run: { type: 'string', enum: ['now', 'later', 'spread', 'cancel'] },
        approval_ids: { type: 'array', items: { type: 'string' }, description: 'Optional: only these' },
        tool: str('Optional: only this tool'),
        account: str('Optional: only this account (as list_queue shows it)'),
        delay_minutes: num('later / spread: start after this many minutes'),
        over_minutes: num('spread: over this many minutes'),
        why: str('Optional: shown on each one'),
      },
      ['agent_id', 'run'],
    ),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      await requireMakerOrAdmin(agentId, null, currentActor(), 'schedule its actions');
      const by = currentActor();
      const name = by.name || 'A person';
      const before = scheduledRows().filter(r => r.agent_id === agentId).length;
      scheduleMine(agentId, { ...a, why: String(a.why ?? '').trim() || `${name} ${a.run === 'cancel' ? 'cancelled' : 'rescheduled'} them` }, Date.now(), name);
      const left = (scheduledRows() as QueuedRow[]).filter(r => r.agent_id === agentId);
      const next = left.filter(r => r.exec_state === 'queued' && r.due_at).sort((x, y) => x.due_at! - y.due_at!)[0];
      return a.run === 'cancel'
        ? `Cancelled ${before - left.length} of ${meta.name}'s approved actions; they won't run (each says who cancelled it and why).`
        : `${meta.name}: ${left.length} waiting to run${next ? `, next ${clock(next.due_at!)}` : ''}. Any hold on them is let go; one failing holds the rest of its account again. list_queue shows each.`;
    },
  },

  // --- Integrations ---
  {
    name: 'list_integrations',
    description: 'Every integration (the services agents\' tools run on): connected or not, draft or live, its tools. Plus whether code plugins are allowed.',
    schema: obj({}),
    run: async () => json({ code_plugins_allowed: pluginsAllowed(), integrations: await listIntegrations() }),
  },
  {
    name: 'read_integration',
    description: "An integration's definition (YAML), and a plugin's code. The shipped ones - brave-search (HTTP), github and gmail (code) - show the format.",
    schema: obj({ integration_id: str('The integration id') }, ['integration_id']),
    run: async a => {
      const src = await integrationSource(String(a.integration_id));
      if (!src) throw new Error(`No integration "${a.integration_id}".`);
      return `${src.yaml}${src.code ? `\n--- plugin code ---\n${src.code}` : ''}`;
    },
  },
  {
    name: 'write_integration',
    description:
      'Save an integration definition (YAML, kind http | mcp | code) as a draft: it shows in the app\'s Settings > Connectors to be connected, and no agent can call it until publish_integration. Redrafting a live one keeps the live one working meanwhile. Keys and sign-ins are added by the person in Settings, never here.',
    schema: obj({ yaml: str('The whole definition') }, ['yaml']),
    run: async a => {
      const { integration } = await writeDraftIntegration(String(a.yaml ?? ''), 'fleet', undefined, true);
      return `Saved "${integration.name}" (${integration.id}) as a draft. ${integration.auth.type === 'none' ? 'It needs no key: test it now.' : 'The person connects it in Settings > Connectors; then test it.'}`;
    },
  },
  {
    name: 'write_plugin',
    description:
      "Save a code plugin's TypeScript (only if code plugins are allowed in Settings): export default { tools: [{ id, tier, description, input, run: async (args, token, kit) => string }] }. Network only through kit.fetch; it runs sandboxed with the permissions its kind: code definition declares. It runs only once published.",
    schema: obj({ module: str('The module name its definition names'), code: str('The whole TypeScript file') }, ['module', 'code']),
    run: async a => {
      if (!pluginsAllowed()) throw new Error('Code plugins are off in Settings > Connectors.');
      const module = String(a.module ?? '');
      if (!/^[a-z0-9][a-z0-9-]*$/.test(module)) throw new Error('module: lowercase letters, digits and dashes.');
      await writePlugin(module, String(a.code ?? ''));
      return `Saved plugin ${module}.`;
    },
  },
  {
    name: 'test_integration',
    description: "Call one of an integration's tools for real (a draft or a live one), and see what an agent would. A plugin's code can't be tried before it's published.",
    schema: obj({ integration_id: str('The integration id'), tool: str('The tool id'), args: { type: 'object', description: 'Its input' } }, ['integration_id', 'tool']),
    run: async a => testIntegrationTool(String(a.integration_id), String(a.tool), (a.args as Record<string, unknown>) ?? {}),
  },
  {
    name: 'publish_integration',
    description:
      "Make a draft live, and optionally give its tools to an agent. A plugin first gets the independent security review; a serious finding stops it. Done here, it doesn't wait for the app's Approvals.",
    schema: obj(
      {
        integration_id: str('The draft'),
        for_agent: str('Optional: the agent that gets its tools'),
        tools: { type: 'array', description: 'For for_agent: the tools to give and their tiers (T0 read, T1 reversible write, T2 needs a person)', items: obj({ id: str('Tool id'), tier: { type: 'string', enum: ['T0', 'T1', 'T2'] } }, ['id', 'tier']) },
        events: { type: 'array', items: { type: 'string' }, description: 'For for_agent: its events the agent should wake on' },
      },
      ['integration_id'],
    ),
    run: async a => {
      const id = String(a.integration_id);
      const p = await publishPreview(id);
      if (p.code && p.permissions) {
        const r = await reviewPlugin({ name: p.name, yaml: p.yaml, code: p.code, permissions: p.permissions });
        if (r.verdict === 'fix') throw new Error(`The security review stopped it: ${r.concerns.map(c => `(${c.severity}) ${c.what}`).join('; ')}. ${r.fix}`);
      }
      const out = await publishIntegration(id, p.codeHash);
      let given = '';
      if (a.for_agent) {
        const { agentId, meta } = await agentOrThrow(a.for_agent);
        const tools = ((a.tools as { id: string; tier: Tier }[]) ?? out.tools).filter(t => out.tools.some(x => x.id === t.id));
        await giveTools(agentId, tools);
        const provided = new Set(liveEventIds());
        const events = ((a.events as string[]) ?? []).map(String).filter(e => provided.has(e));
        if (events.length) await giveEvents(agentId, events);
        given = ` ${meta.name} has ${tools.map(t => t.id).join(', ') || 'none of them'}${events.length ? `, and wakes on ${events.join(', ')}` : ''}.`;
      }
      return `${p.name} is live: ${out.tools.map(t => `${t.id} (${t.tier})`).join(', ') || 'no tools found yet'}.${out.test ? ` Test: ${out.test}.` : ''}${given}`;
    },
  },
  {
    name: 'test_event',
    description: "Try an integration's event (draft or live) without waking anyone: a real poll showing what it finds, and the webhook address to paste into the service.",
    schema: obj({ integration_id: str('The integration id'), event_id: str('The event (server.event)') }, ['integration_id', 'event_id']),
    run: async a => checkEvent(String(a.integration_id), String(a.event_id), hooksBase()),
  },
  {
    name: 'give_events',
    description: 'Subscribe an agent to live events: it wakes when they happen, as well as on its schedule. list_integrations shows each integration\'s events.',
    schema: obj({ agent_id: str('The agent id'), events: { type: 'array', items: { type: 'string' }, description: 'Event ids (server.event)' } }, ['agent_id', 'events']),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      const live = new Set(liveEventIds());
      const events = ((a.events as string[]) ?? []).map(String);
      const bad = events.filter(e => !live.has(e));
      if (bad.length) throw new Error(`Not live: ${bad.join(', ')}.`);
      await giveEvents(agentId, events);
      return `${meta.name} now wakes on ${events.join(', ')}.`;
    },
  },
  {
    name: 'give_tools',
    description: "Give an agent tools that a live integration (or the agency's built-ins) provides, each at a tier.",
    schema: obj({ agent_id: str('The agent id'), tools: { type: 'array', items: obj({ id: str('Tool id'), tier: { type: 'string', enum: ['T0', 'T1', 'T2'] } }, ['id', 'tier']) } }, ['agent_id', 'tools']),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      const tools = (a.tools as { id: string; tier: Tier }[]) ?? [];
      const now = await giveTools(agentId, tools, { byPerson: true });
      const kept = tools.filter(t => now[t.id] !== t.tier).map(t => `${t.id} stays ${now[t.id]} (files on the computer are lowered only on the Tools page)`);
      return `${meta.name} now has ${tools.map(t => `${t.id} (${now[t.id]})`).join(', ')}.${kept.length ? ` Not changed: ${kept.join('; ')}.` : ''}`;
    },
  },
  {
    name: 'discard_integration',
    description: "Throw away a draft (a redraft of a live one goes back to the live version), or remove an added integration entirely. Shipped ones can't be removed.",
    schema: obj({ integration_id: str('The integration id'), remove_live: { type: 'boolean', description: 'Remove it even though it is live' } }, ['integration_id']),
    run: async a => {
      const id = String(a.integration_id);
      if (await discardDraft(id)) return `Draft of ${id} discarded.`;
      if (!a.remove_live) throw new Error(`${id} isn't a draft. To remove it entirely, pass remove_live: true.`);
      await removeIntegration(id);
      return `${id} removed.`;
    },
  },
];

// --- Who it acts as ---
//
// The host computer's own person has the standing address (Settings > Connectors,
// kept across restarts). Everyone else in an organization gets an address of their
// own, which acts as them: the same permissions as in the app (access.ts) - the
// integration-building tools are the owner's and admins', a request is answered by
// its agent's maker or an admin. Whether they're still in it, and as what, is
// asked of our backend with the host's secret (every 5 minutes at most), so
// someone removed loses their address within 5 minutes.

const ADMIN_TOOLS = new Set([
  'write_integration',
  'write_plugin',
  'test_integration',
  'publish_integration',
  'test_event',
  'give_events',
  'give_tools',
  'discard_integration',
]);
// What AI apps show for each tool and use to decide what to allow without
// asking (MCP tool annotations). Hard-to-undo ones are destructive, so apps ask
// first by default; nothing here asks again on top (decided 2026-11-05).
type Hint = { title: string; read?: boolean; destructive?: boolean; idempotent?: boolean; world?: boolean };
export const HINTS: Record<string, Hint> = {
  list_requests: { title: 'List requests', read: true },
  answer_request: { title: 'Close a request', destructive: true },
  reply_to_request: { title: 'Reply on a request' },
  give_task: { title: 'Give an agent a job' },
  list_agents: { title: 'List agents', read: true },
  read_agent: { title: 'Read an agent', read: true },
  write_agent_file: { title: "Replace an agent's file", destructive: true, idempotent: true },
  edit_agent_file: { title: "Edit part of an agent's file", destructive: true },
  decide_approvals: { title: 'Approve or reject many actions', destructive: true, world: true },
  usage: { title: 'What the agency cost', read: true },
  list_queue: { title: 'Approved actions waiting to run', read: true },
  set_pace: { title: "Space an agent's approved actions", idempotent: true },
  schedule_queue: { title: 'Run, move or cancel approved actions', destructive: true, world: true },
  list_models: { title: 'List AI models', read: true },
  set_agent_models: { title: "Set an agent's models", idempotent: true },
  set_agent: { title: "Set an agent's goal or state", idempotent: true },
  builder_guide: { title: 'Agent builder guide', read: true },
  check_build: { title: 'Check an agent build', read: true },
  create_agent: { title: 'Create an agent' },
  delete_agent: { title: 'Delete an agent', destructive: true },
  run_agent: { title: 'Run or message an agent' },
  list_approvals: { title: 'List approvals', read: true },
  decide_approval: { title: 'Approve or reject an action', destructive: true, world: true },
  agency_today: { title: 'What the agency did today', read: true },
  agent_activity: { title: 'What an agent did', read: true },
  latest_report: { title: "An agent's latest report", read: true },
  list_integrations: { title: 'List integrations', read: true },
  read_integration: { title: 'Read an integration', read: true },
  write_integration: { title: 'Write an integration draft', idempotent: true },
  write_plugin: { title: 'Write a code plugin', idempotent: true },
  test_integration: { title: 'Try an integration tool', world: true },
  publish_integration: { title: 'Publish an integration', destructive: true },
  test_event: { title: 'Try an event', world: true },
  give_events: { title: 'Subscribe an agent to events', idempotent: true },
  give_tools: { title: 'Give an agent tools', idempotent: true },
  discard_integration: { title: 'Discard or remove an integration', destructive: true },
};
const annotationsOf = (name: string) => {
  const h = HINTS[name];
  if (!h) return {};
  return {
    title: h.title,
    annotations: { title: h.title, readOnlyHint: !!h.read, destructiveHint: !h.read && !!h.destructive, idempotentHint: !!h.read || !!h.idempotent, openWorldHint: !!h.world },
  };
};
export const agencyTools = (role: Role = 'owner') =>
  TOOLS.filter(t => role !== 'member' || !ADMIN_TOOLS.has(t.name)).map(t => ({ name: t.name, description: t.description, schema: t.schema, ...annotationsOf(t.name) }));
const toolsFor = agencyTools;

// One MCP message from a teammate's AI assistant on another computer, as them
// (POST /api/agency-mcp/rpc: through their app and the relay, with their org
// token, like the app's own requests). Their tools are what their role allows.
export const rpcAs = (actor: Actor, msg: Rpc) => rpc({ tools: toolsFor(actor.role), call: c => runAs(actor, c) }, msg);

async function runAs(actor: Actor, c: { name: string; args?: Record<string, unknown> }) {
  const tool = TOOLS.find(t => t.name === c.name);
  if (!tool) return { content: `No tool "${c.name}".`, error: true };
  if (actor.role === 'member' && ADMIN_TOOLS.has(tool.name)) return { content: `${tool.name} is for the owner or an admin.`, error: true };
  // Who did what (person_actions), as for the app's own changes; reads aren't changes.
  if (!HINTS[tool.name]?.read) recordAction(actor, 'MCP', tool.name, c.args ?? {});
  try {
    return { content: capResult(tool.name, await asActor(actor, () => tool.run(c.args ?? {}))), error: false };
  } catch (e) {
    return { content: (e as Error).message, error: true };
  }
}

type Seen = { at: number; member: { role: Role; name: string } | null };
const seen = new Map<string, Seen>();
const CHECK_EVERY = 5 * 60_000;
export const forgetMembersForTests = () => seen.clear();
// Our backend can't be reached: what it last said, for up to an hour.
const TRUST_LAST = 60 * 60_000;
async function memberNow(userId: string) {
  // Self-hosted: its own accounts, always current.
  if (SELF_HOSTED) return selfMember(userId);
  const had = seen.get(userId);
  if (had && Date.now() - had.at < CHECK_EVERY) return had.member;
  try {
    const res = await fetch(new URL(`/host/members/${encodeURIComponent(userId)}`, accessConfig().issuer), {
      headers: { authorization: `Host ${process.env.EAA_HOST_SECRET ?? ''}` },
      signal: AbortSignal.timeout(8000),
    });
    if (res.status !== 200 && res.status !== 404) throw new Error(`answered ${res.status}`);
    const member = res.status === 200 ? ((await res.json()) as { role: Role; name: string }) : null;
    seen.set(userId, { at: Date.now(), member });
    return member;
  } catch (e) {
    if (had && Date.now() - had.at < TRUST_LAST) return had.member;
    throw new Error(`Can't check you're still in the organization right now (${(e as Error).message}). Try again shortly.`);
  }
}

type PersonRow = { token: string; user_id: string; name: string; role: Role };
const closers = new Map<string, () => void>();
const urls = new Map<string, string>();
function openPerson(row: PersonRow) {
  closers.get(row.token)?.();
  const bridge = openBridge(
    {
      tools: toolsFor(row.role),
      call: async c => {
        let m;
        try {
          m = await memberNow(row.user_id);
        } catch (e) {
          return { content: (e as Error).message, error: true };
        }
        if (!m) return { content: "You're no longer in this organization, so this address doesn't work any more.", error: true };
        // A new role: the tools it lists follow from the next time it's asked.
        if (m.role !== row.role) {
          exec('UPDATE mcp_people SET role = ? WHERE token = ?', m.role, row.token);
          openPerson({ ...row, role: m.role });
        }
        return runAs({ id: row.user_id, name: m.name || row.name, role: m.role, via: 'token' }, c);
      },
    },
    row.token,
  );
  closers.set(row.token, bridge.close);
  urls.set(row.token, bridge.url);
  return bridge.url;
}

// On start: everyone's addresses.
export function openPeopleMcp() {
  for (const row of all<PersonRow>('SELECT token, user_id, name, role FROM mcp_people')) openPerson(row);
}

// The address for whoever's asking: the standing one for this computer's own
// person, everyone else their own (made the first time). regenerate: a new one,
// the old stops working (shared by mistake).
export function mcpUrlFor(actor = currentActor(), regenerate = false): string {
  if (actor.via === 'local') return regenerate ? startAgencyMcp(true) : agencyMcpUrl();
  let row = one<PersonRow>('SELECT token, user_id, name, role FROM mcp_people WHERE user_id = ?', actor.id);
  if (row && regenerate) {
    closers.get(row.token)?.();
    closers.delete(row.token);
    exec('DELETE FROM mcp_people WHERE token = ?', row.token);
    row = undefined;
  }
  if (!row) {
    row = { token: randomBytes(24).toString('hex'), user_id: actor.id, name: actor.name, role: actor.role };
    exec('INSERT INTO mcp_people (token, user_id, name, role, created_at) VALUES (?, ?, ?, ?, ?)', row.token, row.user_id, row.name, row.role, Date.now());
    seen.set(actor.id, { at: Date.now(), member: { role: actor.role, name: actor.name } });
  }
  return urls.get(row.token) ?? openPerson(row);
}

const TOKEN_KEY = 'agency_mcp_token';
let close: (() => void) | null = null;
let url = '';

// Opens the standing address (its token kept across restarts).
export function startAgencyMcp(regenerate = false) {
  let token = getSetting<string | null>(TOKEN_KEY, null);
  if (!token || regenerate) {
    token = randomBytes(24).toString('hex');
    setSetting(TOKEN_KEY, token);
  }
  close?.();
  const bridge = openBridge(
    {
      tools: toolsFor('owner'),
      call: c => runAs(localActor(), c),
    },
    token,
  );
  close = bridge.close;
  url = bridge.url;
  return url;
}

export const agencyMcpUrl = () => url || startAgencyMcp();
export const agencyToolNames = () => TOOLS.map(t => t.name);
