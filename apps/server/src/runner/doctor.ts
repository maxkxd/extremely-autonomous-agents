import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import type { Tier } from '../catalog.js';
import { DATA, listIds, readMeta, save, slug } from '../files.js';
import { allChoices, setChoices, type ModelChoice } from '../models/choice.js';
import { FLEET_ENGINEER, loadAgent } from './agent.js';
import { all, builtInLevels, one, run as exec } from './db.js';
import { defaultModels } from './defaults.js';
import { LEVELS } from './ferocity.js';
import { remember } from './memory.js';
import { registerTools, type ToolDef } from './tools.js';

// The Agency Doctor: the fleet's own check-up. The Agency Engineer answers what
// it's asked; nothing asks about what goes wrong across the fleet - an agent
// filing the same request after every run, meeting its target with busywork,
// hitting the same error again and again, asking what it was already told. The
// Doctor looks for those every couple of hours, from the agency's own records,
// and gets each one fixed through the channels that already exist: it tells
// the agent, closes the loop, asks the Agency Engineer (a request), or proposes
// a rule for the agent's instructions (a person approves). It builds nothing
// and changes no setting itself.

export const DOCTOR = 'doctor';

const DOCTOR_TOOLS: Record<string, Tier> = {
  'doctor.fleet_report': 'T0',
  'doctor.read_agent': 'T0',
  'doctor.tell_agent': 'T1',
  'doctor.close_request': 'T1',
  'doctor.propose_rule': 'T2',
  'requests.request_resource': 'T1',
  'memory.remember': 'T0',
};

const CHARTER = `# CHARTER - Agency Doctor (built in)

You keep the fleet healthy. The Agency Engineer builds and fixes what agents ask for; you find what goes wrong that nobody asks about, and get it fixed. You never build anything or change a setting yourself.

## Every run
1. doctor.fleet_report. It shows, since your last look: each agent's runs and failures, what its counted output actually was, tools failing again and again, requests filed more than once, requests stuck, and approvals that failed.
2. For each real problem, find the cause (doctor.read_agent for an agent's instructions and recent runs), then fix it the right way:
   - An agent asked for something it was already given or told: doctor.tell_agent with the answer and where it came from, and doctor.close_request on the repeat.
   - An agent keeps filing the same request: find why it's never satisfied. Most often the connection provides differently named tools than the ones the agent holds (it holds docs.read_document; the connection gives drive.read_doc) - read_agent shows both. File a request (requests.request_resource) for the Agency Engineer to rename the connection's tools to the ones the agent expects - say exactly which ids to which - and tell the agent it's being fixed. Close the repeats you can; one with a card waiting for a person isn't yours to close, so say in your summary that the person can reject it.
   - A tool keeps failing the same way: if it's the connection (a required input it calls optional, a wrong address), file a request for the Agency Engineer with the error and what the definition should say - the description, the required inputs, the address. If it's how the agent calls it, doctor.tell_agent how to call it. Often it's both: do both.
   - An agent meets its target with busywork (most of its counted output is files in its own workspace, notes, or the same small update), or its real job is blocked and it's padding: doctor.propose_rule for it - a short rule, like "Workspace files don't count as outreach: when sending is blocked, say so and stop early."
   - Something stuck for hours with nobody acting: say so to whoever holds it - doctor.tell_agent, or a request.
3. End with a short summary: what you found, what you did about each, and anything only a person can decide.

## Rules
- You reach the Agency Engineer by filing a request (requests.request_resource): it comes to it. doctor.tell_agent and doctor.close_request are for the fleet's own agents, not the built-ins.
- Fix the cause, not the symptom. One request per cause, however many agents it hits.
- Don't repeat yourself: before telling, closing or filing, check your memory and the report - if you already did it and it's in hand, leave it.
- A quiet fleet is a good result. Don't invent problems; say "nothing wrong" and stop.
- Never ask for keys or passwords. To people, name tools by what they do and levels as silent, logged or approval.
`;

const KPI = `# KPI - Agency Doctor: problems acted on.
agent_id: ${DOCTOR}
output:
  - action: doctor.tell_agent
    label: agents told
  - action: doctor.close_request
    label: loops closed
  - action: doctor.propose_rule
    label: rules proposed
`;

// Its files, rewritten on every start so its rules stay current; models and state left alone.
export async function ensureDoctor() {
  const models: ModelChoice[] = (await allChoices())[DOCTOR] ?? [];
  if (!models.length) {
    models.push(...(await defaultModels('careful')));
    if (models.length) await setChoices(DOCTOR, models);
  }
  const tools = stringify({
    agent_id: DOCTOR,
    models,
    tools_allowed: Object.keys(DOCTOR_TOOLS),
    tool_tiers: { ...DOCTOR_TOOLS, ...builtInLevels(DOCTOR) },
    approval_windows: { 'doctor.propose_rule': { window_seconds: 7 * 86400 } },
    new_tools: [],
    // A look every two hours, at every level: it has no target of its own to chase.
    ferocity: { every_hours: [2, 2, 2, 2], soft_floor: 0, floor: 0, apocalyptic_floor: 0, counts: [], hint: '', extra_effort: '' },
  });
  await save(
    { id: DOCTOR, name: 'Agency Doctor', department: 'agency', charter: CHARTER, tools: `# TOOLS - Agency Doctor (built in)\n${tools}`, kpi: KPI, models },
    { name: 'Agency Doctor', department: 'agency', output: ['agents told', 'loops closed', 'rules proposed'], status: 'ready', builtIn: true },
  );
}

// --- What it sees -------------------------------------------------------------------------

const HOUR = 3_600_000;
const short = (s: string | null | undefined, n = 160) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const ago = (at: number, now: number) => {
  const m = Math.round((now - at) / 60_000);
  return m < 90 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};

// Since its last finished run (at most a day back), or the last day.
function windowStart(now: number) {
  const last = one<{ started_at: number }>("SELECT started_at FROM runs WHERE agent_id = ? AND status = 'succeeded' ORDER BY started_at DESC LIMIT 1", DOCTOR)?.started_at;
  return Math.max(now - 24 * HOUR, last ?? 0);
}

// ids: which agents to look at (tests); every agent otherwise.
export async function fleetReport(now = Date.now(), since = windowStart(now), ids?: string[]): Promise<string> {
  const out: string[] = [`Since ${ago(since, now)}.`];
  for (const id of ids ?? (await listIds())) {
    const meta = (await readMeta(id)) ?? (ids ? { name: id, service: false } : null);
    if (!meta || meta.service || id === DOCTOR) continue;
    const lines: string[] = [];
    const runs = all<{ status: string; acts: number; floor: number | null; error: string | null }>('SELECT status, acts, floor, error FROM runs WHERE agent_id = ? AND started_at >= ?', id, since);
    if (runs.length) {
      const failed = runs.filter(r => r.status === 'failed');
      const errors = [...new Set(failed.map(r => short(r.error, 120)).filter(Boolean))].slice(0, 3);
      const floors = runs.filter(r => r.floor != null);
      lines.push(
        `runs: ${runs.length}${failed.length ? `, ${failed.length} failed (${errors.join(' | ')})` : ''}${floors.length ? `; target met in ${floors.filter(r => r.acts >= (r.floor ?? 0)).length} of ${floors.length}` : ''}`,
      );
    }
    // What its counted output was made of.
    const counted = all<{ tool: string; n: number }>('SELECT tool, SUM(output) AS n FROM actions WHERE agent_id = ? AND at >= ? AND output > 0 GROUP BY tool ORDER BY n DESC', id, since);
    const total = counted.reduce((s, c) => s + c.n, 0);
    if (total) lines.push(`counted output ${total}: ${counted.map(c => `${c.tool} ${c.n} (${Math.round((100 * c.n) / total)}%)`).join(', ')}`);
    // Tools failing or refused, with the last error.
    const bad = all<{ tool: string; outcome: string; n: number }>("SELECT tool, outcome, COUNT(*) AS n FROM actions WHERE agent_id = ? AND at >= ? AND outcome IN ('failed', 'refused') GROUP BY tool, outcome ORDER BY n DESC", id, since);
    for (const b of bad) {
      const last = one<{ last_error: string | null }>('SELECT last_error FROM tool_health WHERE agent_id = ? AND tool = ?', id, b.tool)?.last_error;
      lines.push(`${b.tool} ${b.outcome} ${b.n}x${b.outcome === 'failed' && last ? `: ${short(last, 160)}` : ''}`);
    }
    // The same request filed more than once in the last week.
    const repeats = all<{ what: string; n: number; ids: string }>(
      "SELECT what, COUNT(*) AS n, group_concat('#' || id || ' ' || status, ', ') AS ids FROM requests WHERE agent_id = ? AND created_at >= ? AND status != 'withdrawn' GROUP BY what HAVING COUNT(*) > 1",
      id,
      now - 7 * 24 * HOUR,
    );
    for (const r of repeats) lines.push(`filed ${r.n} times: "${short(r.what, 100)}" (${r.ids})`);
    // Open ones, and how long they've waited.
    for (const r of all<{ id: number; what: string; stage: string | null; created_at: number }>("SELECT id, what, stage, created_at FROM requests WHERE agent_id = ? AND status = 'open' ORDER BY id", id))
      lines.push(`open #${r.id} (${r.stage ?? 'new'}, ${ago(r.created_at, now)}): ${short(r.what, 100)}`);
    // What it was answered recently, to catch it asking again.
    const answered = all<{ id: number; what: string; answer: string | null }>(
      "SELECT id, what, answer FROM requests WHERE agent_id = ? AND status IN ('done', 'rejected') AND answered_at >= ? ORDER BY answered_at DESC LIMIT 8",
      id,
      now - 7 * 24 * HOUR,
    );
    for (const r of answered) lines.push(`answered #${r.id}: "${short(r.what, 80)}" -> ${short(r.answer, 120)}`);
    if (lines.length) out.push(`## ${meta.name} (${id})\n${lines.map(l => `- ${l}`).join('\n')}`);
  }
  const failedApprovals = all<{ id: string; agent_id: string; tool: string; result: string }>(
    "SELECT id, agent_id, tool, result FROM approvals WHERE decided_at >= ? AND result LIKE 'Approved, but it failed%'",
    since,
  );
  if (failedApprovals.length) out.push(`## Approvals that failed when approved\n${failedApprovals.map(a => `- ${a.agent_id}: ${a.tool} - ${short(a.result, 160)}`).join('\n')}`);
  const waiting = all<{ agent_id: string; tool: string; created_at: number }>("SELECT agent_id, tool, created_at FROM approvals WHERE status = 'pending' ORDER BY created_at");
  if (waiting.length) out.push(`## Waiting for a person\n${waiting.map(a => `- ${a.agent_id}: ${a.tool} (${ago(a.created_at, now)})`).join('\n')}`);
  return out.length > 1 ? out.join('\n\n') : `${out[0]} Nothing happened in the fleet.`;
}

async function readAgent(id: string): Promise<string> {
  const agent = await loadAgent(id);
  if (!agent) throw new Error(`No agent "${id}".`);
  const level = one<{ ferocity: number }>('SELECT ferocity FROM agent_state WHERE agent_id = ?', id)?.ferocity ?? 0;
  const runs = all<{ trigger: string; status: string; acts: number; floor: number | null; summary: string | null }>(
    'SELECT trigger, status, acts, floor, summary FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 5',
    id,
  );
  return [
    `# ${agent.name} (${id}) - ${LEVELS[level] ?? level}`,
    `Counts as output: ${agent.ferocity.counts.join(', ') || agent.output.map(o => o.action).join(', ') || 'nothing set'}`,
    `Tools (level): ${Object.entries(agent.tiers).map(([t, tier]) => `${t} ${tier}`).join(', ')}`,
    `## Instructions\n${agent.charter.slice(0, 6000)}`,
    `## Last runs\n${runs.map(r => `- ${r.trigger}, ${r.status}, ${r.acts}${r.floor != null ? `/${r.floor}` : ''}: ${short(r.summary, 400)}`).join('\n') || '- none'}`,
  ].join('\n\n');
}

// --- What it does -------------------------------------------------------------------------

const RULES_HEADING = '## Rules from the Agency Doctor';
export async function addRule(agentId: string, rule: string) {
  const file = join(DATA, slug(agentId), 'CHARTER.md');
  const charter = await readFile(file, 'utf8');
  const line = `- ${rule.trim().replace(/\s+/g, ' ')}`;
  const next = charter.includes(RULES_HEADING) ? charter.replace(RULES_HEADING, `${RULES_HEADING}\n${line}`) : `${charter.trimEnd()}\n\n${RULES_HEADING}\n${line}\n`;
  await writeFile(file, next);
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });
const nameOf = async (id: string) => (await readMeta(id))?.name ?? id;
const ordinaryAgent = async (id: string) => {
  const meta = await readMeta(id);
  if (!meta || meta.service || meta.builtIn || id === FLEET_ENGINEER || id === DOCTOR) throw new Error(`"${id}" isn't one of the fleet's own agents.`);
  return meta;
};

const TOOLS: ToolDef[] = [
  {
    id: 'doctor.fleet_report',
    tier: 'T0',
    description: "Since your last look (or the last day): each agent's runs and failures, what its counted output was made of, tools failing or refused, requests filed more than once, open requests and their age, what it was recently answered, and approvals that failed or are waiting.",
    schema: obj({ hours: { type: 'number', description: 'Optional: look this many hours back instead' } }),
    impl: a => fleetReport(Date.now(), Number(a.hours) > 0 ? Date.now() - Math.min(168, Number(a.hours)) * HOUR : undefined),
  },
  {
    id: 'doctor.read_agent',
    tier: 'T0',
    description: "An agent's instructions, its tools and their levels, what counts as its output, and its last five runs.",
    schema: obj({ agent_id: str('The agent') }, ['agent_id']),
    impl: a => readAgent(String(a.agent_id)),
  },
  {
    id: 'doctor.tell_agent',
    tier: 'T1',
    description: 'Put something in an agent\'s memory, so it knows from its next run: an answer it was already given, how to call a tool, what to stop doing. Say where it comes from ("You were answered on request #15: ...").',
    schema: obj({ agent_id: str('The agent'), note: str('What it should know, in a sentence or two') }, ['agent_id', 'note']),
    impl: async a => {
      const id = String(a.agent_id);
      await ordinaryAgent(id);
      const r = remember(id, `From the Agency Doctor: ${String(a.note)}`, []);
      if (!r.ok) throw new Error(r.message);
      return `${await nameOf(id)} will know from its next run.`;
    },
  },
  {
    id: 'doctor.close_request',
    tier: 'T1',
    description: "Close an agent's open request that's a repeat or a loop, with why - the agent is told. Not for one that needs doing: those are the Agency Engineer's.",
    schema: obj({ request_id: { type: 'integer', description: 'The request' }, why: str('Why it closes, for the agent: "Already given in #12" or "The Agency Engineer is fixing the cause in #31"') }, ['request_id', 'why']),
    impl: async a => {
      const r = one<{ id: number; agent_id: string; status: string }>('SELECT id, agent_id, status FROM requests WHERE id = ?', Number(a.request_id));
      if (!r) throw new Error(`No request #${a.request_id}.`);
      if (r.status !== 'open') throw new Error(`Request #${r.id} is already ${r.status}.`);
      if (r.agent_id === FLEET_ENGINEER || r.agent_id === DOCTOR) throw new Error("That's a built-in agent's own request: leave it.");
      if (one('SELECT 1 FROM approvals WHERE status = ? AND (CAST(json_extract(args, ?) AS INTEGER) = ?)', 'pending', '$.request_id', r.id))
        throw new Error(`Request #${r.id} has a card waiting for a person's approval: leave it to them.`);
      exec("UPDATE requests SET status = 'done', answer = ?, answered_at = ?, stage = NULL WHERE id = ?", `Closed by the Agency Doctor: ${String(a.why)}`, Date.now(), r.id);
      return `Closed #${r.id}; ${await nameOf(r.agent_id)} is told why.`;
    },
  },
  {
    id: 'doctor.propose_rule',
    tier: 'T2',
    description: "Propose a short rule for an agent's instructions, for a pattern that keeps going wrong (padding its target, asking what it was told). A person approves; then it's added under \"Rules from the Agency Doctor\".",
    schema: obj({ agent_id: str('The agent'), rule: str('The rule, one or two plain sentences'), why: str('What you saw that calls for it - the person reads this') }, ['agent_id', 'rule', 'why']),
    preview: async a => {
      await ordinaryAgent(String(a.agent_id));
      return { agent_name: await nameOf(String(a.agent_id)) };
    },
    impl: async a => {
      const id = String(a.agent_id);
      await ordinaryAgent(id);
      await addRule(id, String(a.rule));
      return `Added to ${await nameOf(id)}'s instructions.`;
    },
  },
];

registerTools(TOOLS);
