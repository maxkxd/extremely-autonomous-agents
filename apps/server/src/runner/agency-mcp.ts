import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { createAgent, deleteAgent } from '../agents.js';
import { BuildSchema } from '../builder.js';
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
import { loadAgent } from './agent.js';
import { answerRequest } from './api.js';
import { all, getSetting, run as exec, setSetting } from './db.js';
import { giveEvents, giveTools } from './engineer.js';
import { checkEvent } from './events.js';
import { hooksBase } from './hooks.js';
import { LEVELS } from './ferocity.js';
import { openBridge } from './mcp.js';
import { stateOf } from './run.js';
import { abortRun, book } from './scheduler.js';

// The agency as an MCP server, for the person's own AI IDE (Claude Code,
// Cursor, Codex...): everything the Fleet Engineer and the agent builder can
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

async function agentOrThrow(id: unknown) {
  const agentId = String(id ?? '');
  const meta = await readMeta(agentId);
  if (!meta) throw new Error(`No agent "${agentId}". list_agents shows them.`);
  return { agentId, meta };
}

const FILES = { 'CHARTER.md': 'charter', 'TOOLS.yaml': 'tools', 'KPI.yaml': 'kpi' } as const;

const TOOLS: Tool[] = [
  // --- Requests ---
  {
    name: 'list_requests',
    description: "Requests agents filed for things they can't do themselves: what they need, why, where each stands, and the conversation with the Fleet Engineer.",
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
          conversation: thread.map(m => `${m.from_who === 'you' ? 'Person' : 'Fleet Engineer'}: ${m.text}`),
        });
      }
      return json(out);
    },
  },
  {
    name: 'answer_request',
    description: "Close a request: done (say what was done, so the agent knows) or rejected (anything drafted for it is discarded). The agent hears on its next run.",
    schema: obj({ request_id: num('The request number'), status: { type: 'string', enum: ['done', 'rejected'] }, answer: str('What was done, or why not') }, ['request_id', 'status']),
    run: async a =>
      (await answerRequest(Number(a.request_id), a.status as 'done' | 'rejected', a.answer ? String(a.answer) : null))
        ? `Request #${a.request_id} closed as ${a.status}.`
        : `Request #${a.request_id} isn't open.`,
  },

  // --- Agents ---
  {
    name: 'list_agents',
    description: 'Every agent: id, name, department, owner, state (active / draining = standby / stopped), ferocity level, models, and whether it is built in.',
    schema: obj({}),
    run: async () => {
      const choices = await allChoices();
      const out = [];
      for (const id of await listIds()) {
        const m = await readMeta(id);
        if (!m) continue;
        const st = stateOf(id);
        out.push({ id, name: m.name, department: m.department, owner: m.builtIn ? 'built in' : m.owner, status: m.status, state: st.state, ferocity: LEVELS[st.ferocity], models: choices[id] ?? [], builtIn: !!m.builtIn });
      }
      return json(out);
    },
  },
  {
    name: 'read_agent',
    description: "An agent's files (CHARTER.md, TOOLS.yaml, KPI.yaml), its models and state, its last runs and its memory notes.",
    schema: obj({ agent_id: str('The agent id') }, ['agent_id']),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      const dir = join(DATA, slug(agentId));
      const read = (f: string) => readFile(join(dir, f), 'utf8').catch(() => '');
      const runs = all<{ trigger: string; status: string; started_at: number; summary: string | null; error: string | null }>(
        'SELECT trigger, status, started_at, summary, error FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 5',
        agentId,
      );
      const memory = all<{ text: string }>('SELECT text FROM memories WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20', agentId);
      return [
        `# ${meta.name} (${agentId})${meta.builtIn ? ' - built in' : ''}`,
        `Models: ${json((await allChoices())[agentId] ?? [])}`,
        `State: ${stateOf(agentId).state}, ferocity ${LEVELS[stateOf(agentId).ferocity]}`,
        `\n## CHARTER.md\n${await read('CHARTER.md')}`,
        `\n## TOOLS.yaml\n${await read('TOOLS.yaml')}`,
        `\n## KPI.yaml\n${await read('KPI.yaml')}`,
        `\n## Last runs\n${runs.map(r => `- ${new Date(r.started_at).toISOString()} ${r.trigger} ${r.status}: ${(r.summary ?? r.error ?? '').slice(0, 400)}`).join('\n') || 'None yet.'}`,
        `\n## Memory (newest first)\n${memory.map(m => `- ${m.text}`).join('\n') || 'Empty.'}`,
      ].join('\n');
    },
  },
  {
    name: 'write_agent_file',
    description: "Replace one of an agent's files: CHARTER.md (its job), TOOLS.yaml (tools, tiers, approval windows, ferocity plan) or KPI.yaml (which actions count as output). read_agent first. Its next run uses it.",
    schema: obj({ agent_id: str('The agent id'), file: { type: 'string', enum: Object.keys(FILES) }, content: str('The whole new file') }, ['agent_id', 'file', 'content']),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      if (meta.builtIn) throw new Error(`${meta.name} is built in: its files are rewritten every time the app starts.`);
      const file = String(a.file) as keyof typeof FILES;
      if (!(file in FILES)) throw new Error('file is CHARTER.md, TOOLS.yaml or KPI.yaml.');
      const content = String(a.content ?? '');
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
      if (file === 'KPI.yaml') await writeMeta(agentId, { ...meta, output: kpiLabels(content) });
      return `${file} saved for ${meta.name}.`;
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
    description: `An agent's ferocity (how hard it works: ${LEVELS.join(', ')}) or state (active, draining = standby: starts nothing itself, stopped: runs nothing). Built-in agents have neither.`,
    schema: obj({ agent_id: str('The agent id'), ferocity: { type: 'string', enum: [...LEVELS] }, state: { type: 'string', enum: ['active', 'draining', 'stopped'] } }, ['agent_id']),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
      if (meta.builtIn) throw new Error(`${meta.name} is built in: it has no ferocity or state of its own.`);
      stateOf(agentId);
      const now = Date.now();
      if (a.ferocity !== undefined) {
        const level = LEVELS.indexOf(String(a.ferocity) as (typeof LEVELS)[number]);
        if (level < 0) throw new Error(`ferocity is one of ${LEVELS.join(', ')}.`);
        exec('UPDATE agent_state SET ferocity = ?, updated_at = ? WHERE agent_id = ?', level, now, agentId);
      }
      if (a.state !== undefined) {
        const state = String(a.state);
        if (!['active', 'draining', 'stopped'].includes(state)) throw new Error('state is active, draining or stopped.');
        exec('UPDATE agent_state SET state = ?, updated_at = ? WHERE agent_id = ?', state, now, agentId);
        if (state === 'stopped') abortRun(agentId);
        if (state === 'active') exec('UPDATE agent_state SET fail_streak = 0, backoff_until = NULL WHERE agent_id = ?', agentId);
      }
      const st = stateOf(agentId);
      return `${meta.name}: ${st.state}, ${LEVELS[st.ferocity]}.`;
    },
  },
  {
    name: 'create_agent',
    description:
      "Add a new agent, as the app's agent builder would: the full build (name, department, Charter, tools with tiers, KPIs, models, ferocity plan). Use tools from list_integrations or the built-in ones (read_agent on an existing agent shows them); define new_tools for ones nothing provides yet - a request goes to the Fleet Engineer for each.",
    schema: z.toJSONSchema(BuildSchema) as Record<string, unknown>,
    run: async a => {
      const parsed = BuildSchema.safeParse(a);
      if (!parsed.success) throw new Error(`The build doesn't fit: ${parsed.error.issues.slice(0, 8).map(i => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`);
      const b = parsed.data;
      const taken = new Set(await listIds());
      let id = slug(b.name);
      for (let n = 2; taken.has(id); n++) id = `${slug(b.name)}-${n}`;
      const fleet = await scanFleet();
      const files = compose(b, id, new Set([...fleet.tools.map(t => t.id), ...integrationToolIds()]), await availableModels(), new Set(liveEventIds()));
      const owners = (await Promise.all([...taken].map(async x => (await readMeta(x))?.owner))).filter((o): o is string => !!o);
      const person = hostPerson() ?? owners[0] ?? 'The host';
      await createAgent({ person, org: null, files });
      return `Created ${b.name} (${id}), owned by ${person}. It's on the dashboard${files.models.length ? '' : ' - give it models with set_agent_models'}.`;
    },
  },
  {
    name: 'delete_agent',
    description: "Delete an agent: its files go, its approvals and requests are closed, work handed to it is closed as not done. Its past runs stay in Usage. Built-in agents can't be deleted.",
    schema: obj({ agent_id: str('The agent id') }, ['agent_id']),
    run: async a => {
      const { agentId, meta } = await agentOrThrow(a.agent_id);
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
        exec("INSERT INTO dm (agent_id, kind, body, at) VALUES (?, 'you', ?, ?)", agentId, JSON.stringify({ kind: 'you', text }), Date.now());
        book(agentId, 'your message', text);
        return `Sent to ${meta.name}; its answer goes in its DM channel in the app (read_agent shows its last runs).`;
      }
      if (meta.service) throw new Error(`${meta.name} runs only when the agency calls it.`);
      book(agentId, 'run now', null);
      return `${meta.name} starts as soon as it can.`;
    },
  },
  {
    name: 'list_approvals',
    description: "Agents' actions waiting on a person in the app (sending, posting, going live...). Read-only: they're decided in the app.",
    schema: obj({}),
    run: async () => {
      const rows = all<{ id: string; agent_id: string; tool: string; args: string; expires_at: number }>("SELECT id, agent_id, tool, args, expires_at FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at", Date.now());
      return rows.length ? json(rows.map(r => ({ ...r, args: JSON.parse(r.args), expires: new Date(r.expires_at).toISOString() }))) : 'Nothing waiting.';
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
      'Save an integration definition (YAML, kind http | mcp | code) as a draft: it shows in the app\'s Settings -> Connectors to be connected, and no agent can call it until publish_integration. Redrafting a live one keeps the live one working meanwhile. Keys and sign-ins are added by the person in Settings, never here.',
    schema: obj({ yaml: str('The whole definition') }, ['yaml']),
    run: async a => {
      const { integration } = await writeDraftIntegration(String(a.yaml ?? ''), 'fleet', undefined, true);
      return `Saved "${integration.name}" (${integration.id}) as a draft. ${integration.auth.type === 'none' ? 'It needs no key: test it now.' : 'The person connects it in Settings -> Connectors; then test it.'}`;
    },
  },
  {
    name: 'write_plugin',
    description:
      "Save a code plugin's TypeScript (only if code plugins are allowed in Settings): export default { tools: [{ id, tier, description, input, run: async (args, token, kit) => string }] }. Network only through kit.fetch; it runs sandboxed with the permissions its kind: code definition declares. It runs only once published.",
    schema: obj({ module: str('The module name its definition names'), code: str('The whole TypeScript file') }, ['module', 'code']),
    run: async a => {
      if (!pluginsAllowed()) throw new Error('Code plugins are off in Settings -> Connectors.');
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
      await giveTools(agentId, tools);
      return `${meta.name} now has ${tools.map(t => `${t.id} (${t.tier})`).join(', ')}.`;
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
      tools: TOOLS.map(t => ({ name: t.name, description: t.description, schema: t.schema })),
      call: async c => {
        const tool = TOOLS.find(t => t.name === c.name);
        if (!tool) return { content: `No tool "${c.name}".`, error: true };
        try {
          return { content: await tool.run(c.args ?? {}), error: false };
        } catch (e) {
          return { content: (e as Error).message, error: true };
        }
      },
    },
    token,
  );
  close = bridge.close;
  url = bridge.url;
  return url;
}

export const agencyMcpUrl = () => url || startAgencyMcp();
export const agencyToolNames = () => TOOLS.map(t => t.name);
