import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { DATA, readMeta, save, slug } from '../files.js';
import {
  integrationSource,
  listIntegrations,
  liveEventIds,
  publishIntegration,
  publishPreview,
  testIntegrationTool,
  whenDraftConnected,
  writeDraftIntegration,
} from '../integrations/index.js';
import { pluginsAllowed, writePlugin } from '../integrations/plugins.js';
import { checkEvent } from './events.js';
import { hooksBase } from './hooks.js';
import { reviewPlugin } from '../integrations/review.js';
import { defaultModels } from './defaults.js';
import { allChoices, setChoices, type ModelChoice } from '../models/choice.js';
import type { Tier } from '../catalog.js';
import { FLEET_ENGINEER, loadAgent } from './agent.js';
import { all, one, run as exec } from './db.js';
import { registerTools, type ToolDef } from './tools.js';

// The Fleet Engineer (docs/requests.md, docs/integrations.md): the built-in
// agent, owned by no one, that every request goes to first. It hands work to an
// agent that can already do it, or builds what's missing - an integration in
// Settings, written as a draft, connected by a person, tested for real, and made
// live behind one approval - or tells the person exactly what only they can do.

const ENGINEER_TOOLS: Record<string, Tier> = {
  'engineer.list_requests': 'T0',
  'engineer.reply_to_request': 'T0',
  'engineer.hand_to_person': 'T0',
  'engineer.close_request': 'T0',
  'engineer.read_agent': 'T0',
  'engineer.list_integrations': 'T0',
  'engineer.read_integration': 'T0',
  'engineer.write_integration': 'T0',
  'engineer.write_plugin': 'T0',
  'engineer.ask_for_connection': 'T0',
  'engineer.test_integration': 'T0',
  'engineer.test_event': 'T0',
  'engineer.publish_integration': 'T2',
  'engineer.give_tools': 'T2',
  'engineer.give_events': 'T2',
  'web.web_search': 'T0',
  'web.fetch_page': 'T0',
};

const CHARTER = `# CHARTER - Fleet Engineer

## Mission
You are the agency's engineer. Every request an agent files comes to you first. You make sure each one ends well: handed to an agent that can already do it, answered by a tool you build, or put to a person with exactly what only they can do. You are owned by no one; what you build is for the agent that asked, and its owner approves it.

## How you handle a request (engineer.list_requests shows them, with the asking agent's missing tools)
1. Another agent in the fleet can already do it (it holds the tool, it's its job)? Hand the work over with tasks.delegate_task, then engineer.close_request saying who does it now. Only genuinely related agents - not, say, customer support for an outreach email.
2. A tool that already exists and is live (engineer.list_integrations) would do it? Propose giving it to the agent: engineer.give_tools (a person approves).
3. A service with an API would do it? Build an integration:
   a. Read the service's API docs (web.web_search, web.fetch_page). Prefer, in order: an HTTP definition (kind: http), a remote MCP server the service runs (kind: mcp), a code plugin only when neither can do it and plugins are allowed.
   b. Write it with engineer.write_integration (YAML; engineer.read_integration shows the shipped ones - brave-search, github, gmail - as examples of the format). Name each tool exactly the id the agent already expects, if it has one (its missing tools are listed with the request). Give the person what they need to connect it: key_url (where to make the key), key_help (which permissions/plan, one or two sentences), or for OAuth client_url and numbered client_help steps. A remote MCP server that has its own sign-in (Notion, Linear and the like): \`auth: { type: mcp_oauth }\` - the app finds its sign-in and registers itself, so the person just signs in. Pick tiers by the rules: reads T0, reversible internal writes T1, anything outside the organisation or hard to undo T2.
   c. It's saved as a draft: it shows in Settings -> Connectors so the person can connect it, and no agent can call it. Then tell them it's ready with engineer.ask_for_connection - exact steps (including making an account, if it needs one), and that the key goes in Settings, never in the chat. You're woken the moment they connect it.
   d. Test it like a careful person: the real call with real-looking inputs, then the edge cases - empty and missing inputs, a limit, nonsense - and read what an agent would see. Results must be clean, plain text; errors one readable line. Fix the definition and test again until they are.
   e. engineer.publish_integration with a short summary of what you tested and what you saw. That's the one approval: approved, it goes live, the agent gets the tools, and the request closes.
4. Something only a person can do (buy a plan, make an account, decide)? engineer.reply_to_request with the steps, and what you'll do once they're done. Not a tool problem at all, or beyond you? engineer.hand_to_person with why and what they should do.

## Events
Some agents are woken by something happening at a service - a new Sentry issue, a support ticket, an alarm - as well as by their schedule. A request to "Set up the event sentry.new_issue" means: add it to an integration (a new one, or the service's existing one) under events:, each with an id (server.event), a description, and how it's detected:
- poll: a request like a tool's (base_url defaults to the integration's) that lists recent items, items (dot path to the list; empty when the answer is the list), id (dot path to each item's unique id), fields (what the agent sees of each), every_minutes (5 is a good default; slower for things that can wait). Each item is told once; what's there at the first check isn't news. Works from this computer with no setup beyond the key.
- webhook: the service posts to the agency's address. items/id/fields as for poll, but in the posted body; signature (header, algorithm, prefix, encoding) when the service signs its posts, with secret_help saying where the person finds the signing secret; setup_help: where in the service to paste the address.
Prefer webhook when the service has one for it, with poll as well when the service's API lists the same things (it catches anything missed). Test with engineer.test_event: a poll for real, and the webhook address to give the person (engineer.ask_for_connection with the steps: the key, the webhook address, the signing secret). The agent that asked is subscribed when the integration goes live; for one that's live already, engineer.give_events.

## Code plugins
Only if allowed (engineer.list_integrations says). For what HTTP and MCP can't do - an action on this computer, a file format to build. A plugin is a TypeScript module: \`export default { tools: [{ id, tier, description, input, run: async (args, token, kit) => string }] }\` (token is the key, if the integration takes one; return text the agent reads; throw an Error with a one-line message on failure). Node built-ins only (node:fs, node:child_process...). The network only through \`await kit.fetch(url, { method, headers, body })\`, which returns a Response and refuses this computer and its network - never fetch(), node:http(s), or downloading from a shell; writing the plugin is refused if it does. Pair it with a kind: code definition naming the module, and declare in it exactly what the plugin touches: \`permissions: { write: [folders], read: [folders], commands: true|false }\` (absolute paths or ~/...; a whole drive or the whole home folder is refused). It runs in a sandbox that allows nothing else - no other files, no programs unless commands is true, and no network but kit.fetch. Before you can propose it, an independent security review reads it: inputs agents choose must never reach commands, scripts or paths unchecked (pass them as data, e.g. environment variables, never built into a command line). If the review sends it back, fix what it says. Its code never runs before a person approves it with the code shown, so you can't test it first: write it carefully, and test it as soon as it's live; if it fails, fix it and propose again.

## Talking to the person
- Decide, build, then tell them. Pick the best way yourself and write the draft first - never ask whether you should. If they don't want it, they reply or reject the request (that discards the draft).
- Short: what you set up and, in a sentence or two, why it's the best way; then numbered steps for what they do. No account of your research, no list of alternatives unless they ask. About 5 sentences plus the steps.
- Each step on its own line, numbered (1. 2. 3.); points on their own lines starting with "- ". The app shows them as lists.
- When another request needs the same thing (the same repository, key or decision), point to it instead of asking again: write "request #41" - the person can click it. Do the shared work once and use it for both.

## Rules
- Woken for a request that isn't in engineer.list_requests any more? It was closed (turned down, handed over, or its agent deleted): drop it and move on. Never ask anyone to restore or resend it.
- Always tell the person what to do next - never just why something can't be done.
- Never ask for keys, passwords or tokens in a conversation; if someone pastes one, tell them it belongs in Settings -> Connectors and not to share it.
- Steer people to the right button: replying doesn't approve anything (that's the Approvals page); DIY and Reject are on the request itself; keys and sign-ins are in Settings -> Connectors.
- Agents can't reach this computer's network, and integrations can't call local addresses: don't build for one.
- One request at a time, carried as far as it can go in this run; your memory keeps what you're waiting on.
- Refer to people by name, or as "they", unless their profile states their pronouns.

## What a good run looks like
Every request you touched moved: handed over, a draft written, a person asked something precise, a test run, or a go-live proposed.
`;

const KPI = `# KPI - Fleet Engineer: successful calls of these actions are its output.
agent_id: ${FLEET_ENGINEER}
output:
  - action: engineer.write_integration
    label: integrations written
  - action: engineer.test_integration
    label: tests run
  - action: engineer.close_request
    label: requests closed
`;

// Its files, rewritten from here on every start (so its rules stay current);
// its models, ferocity and state are left alone.
export async function ensureFleetEngineer() {
  const dir = join(DATA, FLEET_ENGINEER);
  const models: ModelChoice[] = (await allChoices())[FLEET_ENGINEER] ?? [];
  // None yet: the strongest connected, plans first (defaults.ts). With nothing
  // connected, the first model connected sets them (helpers.ts).
  if (!models.length) {
    models.push(...(await defaultModels('strong')));
    if (models.length) await setChoices(FLEET_ENGINEER, models);
  }
  const tools = stringify({
    agent_id: FLEET_ENGINEER,
    models,
    tools_allowed: Object.keys(ENGINEER_TOOLS),
    tool_tiers: ENGINEER_TOOLS,
    approval_windows: { 'engineer.publish_integration': { window_seconds: 7 * 86400 }, 'engineer.give_tools': { window_seconds: 7 * 86400 }, 'engineer.give_events': { window_seconds: 7 * 86400 } },
    new_tools: [],
    // It runs when there's work (requests, connections, replies); a daily look otherwise.
    ferocity: { every_hours: [24, 24, 24, 24], soft_floor: 0, floor: 0, apocalyptic_floor: 0, counts: [], hint: '', extra_effort: '' },
  });
  await save(
    { id: FLEET_ENGINEER, name: 'Fleet Engineer', department: 'engineering', charter: CHARTER, tools: `# TOOLS - Fleet Engineer (built in)\n${tools}`, kpi: KPI, models },
    { name: 'Fleet Engineer', department: 'engineering', output: ['integrations written', 'tests run', 'requests closed'], status: 'ready', builtIn: true },
  );
  return dir;
}

// --- Requests ------------------------------------------------------------------------

type RequestRow = { id: number; agent_id: string; what: string; why: string; evidence: string | null; expected_effect: string | null; status: string; stage: string | null; created_at: number };

export function postToRequest(id: number, from: 'engineer' | 'you', text: string, now = Date.now()) {
  exec('INSERT INTO request_messages (request_id, from_who, text, at) VALUES (?, ?, ?, ?)', id, from, text.slice(0, 6000), now);
}
const setStage = (id: number, stage: string) => exec('UPDATE requests SET stage = ? WHERE id = ?', stage, id);
const openRequest = (raw: unknown): RequestRow => {
  const r = one<RequestRow>('SELECT * FROM requests WHERE id = ?', Number(raw));
  if (!r) throw new Error(`No request #${raw}.`);
  if (r.status !== 'open') throw new Error(`Request #${r.id} is already ${r.status}.`);
  return r;
};

// An agent's tools that nothing provides yet, with what its builder wrote for them.
async function stillMissing(agentId: string) {
  const agent = await loadAgent(agentId);
  if (!agent) return { agent: null, missing: [], missingEvents: [] };
  const live = new Set((await listIntegrations()).filter(i => i.connected && !i.draft).flatMap(i => i.tools.map(t => t.id)));
  const events = new Set(liveEventIds());
  const missingEvents = agent.newEvents.filter(e => !events.has(e.id));
  return { agent, missing: [...agent.newTools.filter(t => !live.has(t.id)), ...missingEvents.map(e => ({ id: e.id, description: e.description, input_schema: null }))], missingEvents };
}
async function missingTools(agentId: string): Promise<string> {
  const { agent, missing, missingEvents } = await stillMissing(agentId);
  if (!agent) return '';
  const tools = missing.filter(t => !missingEvents.some(e => e.id === t.id));
  return (
    (tools.length
      ? `\n  Tools it expects that nothing provides yet:\n${tools.map(t => `  - ${t.id} [${agent.tiers[t.id] ?? 'T1'}]: ${t.description}\n    input: ${JSON.stringify(t.input_schema)}`).join('\n')}`
      : '') +
    (missingEvents.length ? `\n  Events it should wake on that nothing provides yet:\n${missingEvents.map(e => `  - ${e.id}: ${e.description}${e.how ? ` (${e.how})` : ''}`).join('\n')}` : '')
  );
}

// --- Its tools -----------------------------------------------------------------------

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'number', description });
const toolsArg = {
  type: 'array',
  description: 'The tools, each with its tier',
  items: obj({ id: str('server.tool'), tier: { type: 'string', enum: ['T0', 'T1', 'T2'] } }, ['id', 'tier']),
};

// Subscribes an agent to events (docs/events.md), in its TOOLS.yaml.
export async function giveEvents(agentId: string, events: string[]) {
  const file = join(DATA, slug(agentId), 'TOOLS.yaml');
  const doc = parseDocument(await readFile(file, 'utf8'));
  const have = ((doc.get('events') as { toJSON(): string[] } | undefined)?.toJSON() ?? []) as string[];
  doc.set('events', [...new Set([...have, ...events])]);
  await writeFile(file, doc.toString());
}

// Adds tools to an agent's TOOLS.yaml, keeping the builder's comments.
export async function giveTools(agentId: string, tools: { id: string; tier: Tier }[]) {
  const file = join(DATA, slug(agentId), 'TOOLS.yaml');
  const doc = parseDocument(await readFile(file, 'utf8'));
  const allowed = new Set(((doc.get('tools_allowed') as { toJSON(): string[] } | undefined)?.toJSON() ?? []) as string[]);
  const tiers = (((doc.get('tool_tiers') as { toJSON(): Record<string, Tier> } | undefined)?.toJSON() ?? {}) as Record<string, Tier>);
  const servers = new Set(((doc.get('servers') as { toJSON(): string[] } | undefined)?.toJSON() ?? []) as string[]);
  for (const t of tools) {
    allowed.add(t.id);
    tiers[t.id] ??= t.tier; // the builder's tier for a tool it defined wins
    servers.add(t.id.split('.')[0]);
  }
  doc.set('tools_allowed', [...allowed]);
  doc.set('tool_tiers', tiers);
  doc.set('servers', [...servers]);
  await writeFile(file, doc.toString());
}


const nameOf = async (agentId: string) => (await readMeta(agentId))?.name ?? agentId;

// The events an agent should get from an integration: the ones asked for, else
// the ones it expects (its builder's) that the integration provides.
async function eventsFor(agentId: string, integrationId: string, asked: unknown): Promise<string[]> {
  const provided = ((await listIntegrations()).find(i => i.id === integrationId)?.events ?? []).map(e => e.id);
  if (Array.isArray(asked)) return asked.map(String).filter(e => provided.includes(e));
  const agent = await loadAgent(agentId);
  const wants = new Set([...(agent?.events ?? []), ...(agent?.newEvents ?? []).map(e => e.id)]);
  return provided.filter(e => wants.has(e));
}

const TOOLS: ToolDef[] = [
  {
    id: 'engineer.list_requests',
    tier: 'T0',
    description: 'The open requests, newest last: what the agent asked, the conversation so far, where each stands, and the tools the asking agent expects that nothing provides yet.',
    schema: obj({}),
    impl: async () => {
      const rows = all<RequestRow>("SELECT * FROM requests WHERE status = 'open' AND agent_id != ? ORDER BY id", FLEET_ENGINEER);
      if (!rows.length) return 'No open requests.';
      const out: string[] = [];
      for (const r of rows) {
        const thread = all<{ from_who: string; text: string }>('SELECT from_who, text FROM request_messages WHERE request_id = ? ORDER BY id', r.id);
        out.push(
          [
            `#${r.id} from ${await nameOf(r.agent_id)} (${r.agent_id}) · stage: ${r.stage ?? 'new'}`,
            `  Needs: ${r.what}`,
            `  Why: ${r.why}`,
            r.evidence && `  Tried / shows: ${r.evidence}`,
            r.expected_effect && `  Once it has it: ${r.expected_effect}`,
            thread.length && `  Conversation:\n${thread.map(m => `    ${m.from_who === 'you' ? 'Person' : 'You'}: ${m.text}`).join('\n')}`,
          ]
            .filter(Boolean)
            .join('\n') + (await missingTools(r.agent_id)),
        );
      }
      return out.join('\n\n');
    },
  },
  {
    id: 'engineer.reply_to_request',
    tier: 'T0',
    description: 'Write to the person on a request: a question, or the steps only they can do and what you will do once they are done. It then waits on them.',
    schema: obj({ request_id: int('The request number'), message: str('Plain text, about 5 sentences: what you did and why, then numbered steps. No research story.') }, ['request_id', 'message']),
    impl: async a => {
      const r = openRequest(a.request_id);
      postToRequest(r.id, 'engineer', String(a.message));
      setStage(r.id, 'waiting_you');
      return `Posted on request #${r.id}; it now waits on the person. You'll be woken when they reply.`;
    },
  },
  {
    id: 'engineer.hand_to_person',
    tier: 'T0',
    description: "Give a request to the person: it isn't a tool problem, or it's beyond you. Say why and what they should do.",
    schema: obj({ request_id: int('The request number'), message: str('Why it is theirs, and what to do') }, ['request_id', 'message']),
    impl: async a => {
      const r = openRequest(a.request_id);
      postToRequest(r.id, 'engineer', String(a.message));
      setStage(r.id, 'person');
      return `Request #${r.id} is with the person now.`;
    },
  },
  {
    id: 'engineer.close_request',
    tier: 'T0',
    description: 'Close a request that is settled (handed to another agent, or answered). The asking agent reads your answer at the start of its next run.',
    schema: obj({ request_id: int('The request number'), answer: str('For the asking agent: what happened and what it can do now') }, ['request_id', 'answer']),
    impl: async a => {
      const r = openRequest(a.request_id);
      const answer = String(a.answer).slice(0, 4000);
      exec("UPDATE requests SET status = 'done', answer = ?, answered_at = ?, stage = NULL WHERE id = ?", answer, Date.now(), r.id);
      postToRequest(r.id, 'engineer', answer);
      return `Closed #${r.id}.`;
    },
  },
  {
    id: 'engineer.read_agent',
    tier: 'T0',
    description: "An agent's Charter and the tools it holds, with their tiers - to judge what it needs, or whether it can take work over.",
    schema: obj({ agent_id: str('The agent id') }, ['agent_id']),
    impl: async a => {
      const agent = await loadAgent(String(a.agent_id));
      if (!agent) throw new Error(`No agent "${a.agent_id}".`);
      return `${agent.name} (${agent.id})\nTools: ${Object.entries(agent.tiers).map(([t, tier]) => `${t} [${tier}]`).join(', ')}${await missingTools(agent.id)}\n\n${agent.charter.slice(0, 6000)}`;
    },
  },
  {
    id: 'engineer.list_integrations',
    tier: 'T0',
    description: 'Every integration: shipped and added, live or draft, connected or not, its last test, and its tools. Also says whether code plugins are allowed.',
    schema: obj({}),
    impl: async () => {
      const list = await listIntegrations();
      return `Code plugins: ${pluginsAllowed() ? 'allowed' : 'NOT allowed (a person can turn them on in Settings -> Connectors)'}\n\n${list
        .map(
          i =>
            `- ${i.id} (${i.name}, ${i.kind}${i.shipped ? ', shipped' : ''}${i.draft ? ', DRAFT' : ''}): ${i.connected ? 'connected' : 'not connected'}${i.test ? ` · last test: ${i.test.ok ? 'ok' : 'failed'} - ${i.test.message}` : ''}\n  tools: ${i.tools.map(t => `${t.id} [${t.tier}]`).join(', ') || '(found when it connects)'}`,
        )
        .join('\n')}`;
    },
  },
  {
    id: 'engineer.read_integration',
    tier: 'T0',
    description: "An integration's definition (YAML), and a code plugin's code - yours to edit, or the shipped ones as examples (brave-search: HTTP + API key; github, gmail: code + token/OAuth).",
    schema: obj({ id: str('The integration id') }, ['id']),
    impl: async a => {
      const src = await integrationSource(String(a.id));
      if (!src) throw new Error(`No integration "${a.id}".`);
      return `${src.yaml}${src.code ? `\n--- plugin code ---\n${src.code}` : ''}`;
    },
  },
  {
    id: 'engineer.write_integration',
    tier: 'T0',
    description:
      'Save an integration definition (YAML: kind http | mcp | code, as in the shipped examples) as a DRAFT: it shows in Settings to be connected; no agent can call it until a person approves it going live. Rewriting a live one of yours makes it a draft again.',
    schema: obj({ definition: str('The whole YAML definition'), request_id: int('The request it answers') }, ['definition']),
    impl: async a => {
      const { integration, wasLive } = await writeDraftIntegration(String(a.definition), FLEET_ENGINEER, a.request_id ? Number(a.request_id) : undefined);
      const needs = integration.auth.type === 'none' ? 'It needs no key: test it now.' : 'It needs a key or sign-in: ask the person with engineer.ask_for_connection.';
      return `Saved "${integration.id}" (${integration.name}) as a draft${wasLive ? ' - it was live, so its tools are off until it is approved again' : ''}. It shows in Settings -> Connectors. ${needs}`;
    },
  },
  {
    id: 'engineer.write_plugin',
    tier: 'T0',
    description: "Save a code plugin's TypeScript (only when code plugins are allowed). Pair it with a kind: code definition naming this module. It doesn't run until a person approves it.",
    schema: obj({ module: str('Lowercase name, a-z 0-9 -'), code: str('The whole module: export default { tools: [...] }') }, ['module', 'code']),
    impl: async a => {
      if (!pluginsAllowed()) throw new Error('Code plugins are off. A person can allow them in Settings -> Connectors; until then, build it as HTTP or MCP, or tell them what it needs.');
      const module = String(a.module);
      if (!/^[a-z0-9-]+$/.test(module) || ['gmail', 'github'].includes(module)) throw new Error('Pick another module name: lowercase letters, digits and dashes.');
      await writePlugin(module, String(a.code));
      return `Saved plugin "${module}". It runs only after a person approves it (engineer.publish_integration shows them the code).`;
    },
  },
  {
    id: 'engineer.ask_for_connection',
    tier: 'T0',
    description: "Ask the person to connect a draft integration in Settings -> Connectors (its key or sign-in). Say exactly where to get the key and what it needs. You're woken when they connect it.",
    schema: obj({ integration_id: str('The draft integration'), request_id: int('The request it answers'), message: str('One or two sentences on what it is and why it is the best way, then the steps, numbered') }, [
      'integration_id',
      'request_id',
      'message',
    ]),
    impl: async a => {
      const r = openRequest(a.request_id);
      const i = (await listIntegrations()).find(x => x.id === String(a.integration_id));
      if (!i) throw new Error(`No integration "${a.integration_id}".`);
      postToRequest(r.id, 'engineer', `${String(a.message)}\n\nWhere: Settings -> Connectors -> Integrations -> ${i.name}. Keys go there, never in this chat.`);
      setStage(r.id, 'waiting_you');
      return `Asked. Request #${r.id} waits on the person; you'll be woken when ${i.name} is connected.`;
    },
  },
  {
    id: 'engineer.test_integration',
    tier: 'T0',
    description: "Call one tool of an integration directly - draft or live - with the arguments you give, and see exactly what an agent would get back.",
    schema: obj({ integration_id: str('The integration'), tool: str('The tool id (server.tool)'), args: { type: 'object', description: 'Its arguments' } }, ['integration_id', 'tool']),
    impl: async a => testIntegrationTool(String(a.integration_id), String(a.tool), (a.args as Record<string, unknown>) ?? {}),
  },
  {
    id: 'engineer.publish_integration',
    tier: 'T2',
    description:
      "Propose a draft going live: a person approves (they see the definition, a plugin's code, and your summary). Approved, it goes live, the agent gets its tools, and the request closes with your summary as the agent's answer.",
    schema: obj(
      {
        integration_id: str('The draft integration'),
        request_id: int('The request it answers'),
        for_agent: str('The agent that gets its tools'),
        tools: toolsArg,
        events: { type: 'array', items: { type: 'string' }, description: "Optional: its events the agent should wake on (default: the ones the agent expects that it provides)" },
        summary: str('For the person approving: at most 3 plain sentences - what it gives the agent, and that it tested fine. The card shows only this and a few bullets.'),
      },
      ['integration_id', 'request_id', 'for_agent', 'tools', 'summary'],
    ),
    // What the person sees and approves, fixed when it's queued: the plugin
    // runs only if its code is still exactly this.
    preview: async a => {
      openRequest(a.request_id);
      if (!(await loadAgent(String(a.for_agent)))) throw new Error(`No agent "${a.for_agent}".`);
      const p = await publishPreview(String(a.integration_id));
      // A plugin is reviewed by a separate model first; a serious finding sends it back.
      // The card: up to 3 sentences from the engineer, then up to 5 plain bullets.
      // For a plugin the bullets come from the review - what it can do on this
      // computer - plus anything it rated worth a person's attention.
      let bullets: string[] = [];
      if (p.code && p.permissions) {
        const r = await reviewPlugin({ name: p.name, yaml: p.yaml, code: p.code, permissions: p.permissions });
        if (r.verdict === 'fix')
          throw new Error(
            `The security review sent the plugin back - it wasn't proposed. Concerns: ${r.concerns.map(c => `(${c.severity}) ${c.what}`).join('; ')}. What to change: ${r.fix || 'see the concerns'}. Fix it (engineer.write_plugin / engineer.write_integration) and propose it again.`,
          );
        bullets = [...r.canDo.slice(0, 4), ...r.concerns.filter(c => c.severity === 'medium').map(c => `Worth knowing: ${c.what}`)].slice(0, 5);
      }
      setStage(Number(a.request_id), 'approval');
      // Said on the request every time, so the person knows it's their move.
      postToRequest(Number(a.request_id), 'engineer', `${p.name} is tested and ready. It goes live for ${await nameOf(String(a.for_agent))} when you approve it on the Approvals page.`);
      return {
        name: p.name,
        for_agent_name: await nameOf(String(a.for_agent)),
        tools_list: ((a.tools as { id: string; tier: string }[]) ?? []).map(t => `${t.id} (${t.tier})`).join(', '),
        events_list: (await eventsFor(String(a.for_agent), String(a.integration_id), a.events)).join(', '),
        review: [String(a.summary).trim(), bullets.map(x => `- ${x}`).join('\n')].filter(Boolean).join('\n\n'),
        code_view: `${p.yaml}${p.code ? `\n--- Plugin code (runs in a sandbox on this computer) ---\n${p.code}` : ''}`,
        code_hash: p.codeHash,
      };
    },
    impl: async (a, ctx) => {
      const r = openRequest(a.request_id);
      const agentId = String(a.for_agent);
      const out = await publishIntegration(String(a.integration_id), (a.code_hash as string | null) ?? null);
      const wanted = ((a.tools as { id: string; tier: Tier }[]) ?? []).filter(t => out.tools.some(x => x.id === t.id));
      const given = wanted.length ? wanted : out.tools;
      await giveTools(agentId, given);
      const events = await eventsFor(agentId, String(a.integration_id), a.events);
      if (events.length) await giveEvents(agentId, events);
      const tested = out.test ? ` Its test as it went live: ${out.test}` : '';
      const ids = [...given.map(t => t.id), ...events.map(e => `${e} (wakes it)`)].join(', ');
      postToRequest(r.id, 'engineer', `${String(a.name ?? a.integration_id)} is live and given to ${await nameOf(agentId)}: ${ids}.${tested}`);
      // The request closes only once nothing the agent needs is missing; otherwise
      // it goes back to the engineer for the rest.
      const { missing } = await stillMissing(agentId);
      if (missing.length) {
        setStage(r.id, 'engineer');
        const rest = missing.map(t => t.id).join(', ');
        ctx.wake(FLEET_ENGINEER, 'request', `${ids} went live for ${agentId}. Request #${r.id} still needs: ${rest}.`);
        return `Live: ${String(a.name ?? a.integration_id)} for ${agentId}.${tested} Request #${r.id} stays open for: ${rest}.`;
      }
      const answer = `${String(a.summary)}\n\nYou now have: ${ids}.`;
      exec("UPDATE requests SET status = 'done', answer = ?, answered_at = ?, stage = NULL WHERE id = ?", answer, Date.now(), r.id);
      return `Live: ${String(a.name ?? a.integration_id)} for ${agentId}.${tested}`;
    },
  },
  {
    id: 'engineer.test_event',
    tier: 'T0',
    description: "Try one of an integration's events (draft or live) without waking anyone: a real poll showing what it finds, and its webhook address to give the person.",
    schema: obj({ integration_id: str('The integration'), event_id: str('The event (server.event)') }, ['integration_id', 'event_id']),
    impl: async a => checkEvent(String(a.integration_id), String(a.event_id), hooksBase()),
  },
  {
    id: 'engineer.give_events',
    tier: 'T2',
    description: 'Propose subscribing an agent to events that are already live (a person approves): it wakes when they happen, as well as on its schedule. Approved, the request closes.',
    schema: obj(
      { for_agent: str('The agent'), events: { type: 'array', items: { type: 'string' }, description: 'Event ids (server.event)' }, request_id: int('The request it answers'), why: str('Why it should wake on them - the person reads this') },
      ['for_agent', 'events', 'request_id', 'why'],
    ),
    preview: async a => {
      openRequest(a.request_id);
      if (!(await loadAgent(String(a.for_agent)))) throw new Error(`No agent "${a.for_agent}".`);
      const live = new Set(liveEventIds());
      const bad = ((a.events as string[]) ?? []).filter(e => !live.has(e));
      if (bad.length) throw new Error(`Not live: ${bad.join(', ')}. Set them up and publish their integration first.`);
      setStage(Number(a.request_id), 'approval');
      postToRequest(Number(a.request_id), 'engineer', `${await nameOf(String(a.for_agent))} wakes on these when you approve it on the Approvals page.`);
      return { for_agent_name: await nameOf(String(a.for_agent)), events_list: ((a.events as string[]) ?? []).join(', ') };
    },
    impl: async a => {
      const r = openRequest(a.request_id);
      const events = ((a.events as string[]) ?? []).map(String);
      await giveEvents(String(a.for_agent), events);
      exec("UPDATE requests SET status = 'done', answer = ?, answered_at = ?, stage = NULL WHERE id = ?", `${String(a.why)}\n\nYou now wake on: ${events.join(', ')}.`, Date.now(), r.id);
      postToRequest(r.id, 'engineer', `${await nameOf(String(a.for_agent))} now wakes on ${events.join(', ')}.`);
      return `${a.for_agent} now wakes on ${events.join(', ')}.`;
    },
  },
  {
    id: 'engineer.give_tools',
    tier: 'T2',
    description: 'Propose giving an agent tools that already exist and are live (a person approves). Approved, the agent has them from its next run, and the request closes.',
    schema: obj({ for_agent: str('The agent'), tools: toolsArg, request_id: int('The request it answers'), why: str('Why it needs them - the person reads this') }, [
      'for_agent',
      'tools',
      'request_id',
      'why',
    ]),
    preview: async a => {
      openRequest(a.request_id);
      if (!(await loadAgent(String(a.for_agent)))) throw new Error(`No agent "${a.for_agent}".`);
      setStage(Number(a.request_id), 'approval');
      postToRequest(Number(a.request_id), 'engineer', `${await nameOf(String(a.for_agent))} gets these tools when you approve it on the Approvals page.`);
      return { for_agent_name: await nameOf(String(a.for_agent)), tools_list: ((a.tools as { id: string; tier: string }[]) ?? []).map(t => `${t.id} (${t.tier})`).join(', ') };
    },
    impl: async a => {
      const r = openRequest(a.request_id);
      const tools = (a.tools as { id: string; tier: Tier }[]) ?? [];
      await giveTools(String(a.for_agent), tools);
      const answer = `${String(a.why)}\n\nYou now have: ${tools.map(t => t.id).join(', ')}.`;
      exec("UPDATE requests SET status = 'done', answer = ?, answered_at = ?, stage = NULL WHERE id = ?", answer, Date.now(), r.id);
      postToRequest(r.id, 'engineer', `Given to ${await nameOf(String(a.for_agent))}.`);
      return `Gave ${tools.map(t => t.id).join(', ')} to ${a.for_agent}.`;
    },
  },
];

registerTools(TOOLS);

// --- Waking it ------------------------------------------------------------------------

export function startEngineer(book: (agentId: string, trigger: 'request' | 'connected', task: string) => void) {
  // A draft it's waiting on was connected: it tests it now.
  whenDraftConnected((id, request) => book(FLEET_ENGINEER, 'connected', `The person connected the draft integration "${id}"${request ? ` (for request #${request})` : ''}.`));
  // Requests from before it existed come to it once.
  const old = all<{ id: number; agent_id: string; what: string }>("SELECT id, agent_id, what FROM requests WHERE status = 'open' AND stage IS NULL AND agent_id != ?", FLEET_ENGINEER);
  for (const r of old) {
    setStage(r.id, 'engineer');
    book(FLEET_ENGINEER, 'request', `Request #${r.id} from ${r.agent_id}: ${r.what.slice(0, 300)}`);
  }
}
