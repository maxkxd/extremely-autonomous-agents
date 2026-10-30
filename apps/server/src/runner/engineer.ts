import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument, stringify } from 'yaml';
import { DATA, readMeta, save, slug } from '../files.js';
import {
  checkKey,
  integrationSource,
  savedSettings,
  listIntegrations,
  liveEventIds,
  publishIntegration,
  publishPreview,
  testIntegrationTool,
  whenDraftConnected,
  whenConnected,
  toolIdsOf,
  writeDraftIntegration,
} from '../integrations/index.js';
import { pluginsAllowed, writePlugin } from '../integrations/plugins.js';
import { checkEvent } from './events.js';
import { hooksBase } from './hooks.js';
import { reviewPlugin } from '../integrations/review.js';
import { defaultModels } from './defaults.js';
import { allChoices, setChoices, type ModelChoice } from '../models/choice.js';
import { toolTitle, toolsForPeople, type Tier } from '../catalog.js';
import { FLEET_ENGINEER, loadAgent } from './agent.js';
import { all, builtInLevels, one, run as exec } from './db.js';
import { heldTools, registerTools, type ToolDef } from './tools.js';

// The Agency Engineer (docs/requests.md, docs/integrations.md): the built-in
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
  'engineer.tool_history': 'T0',
  'engineer.check_key': 'T0',
  'engineer.publish_integration': 'T2',
  'engineer.give_tools': 'T2',
  'engineer.withdraw_proposal': 'T1',
  'engineer.give_events': 'T2',
  'web.web_search': 'T0',
  'web.fetch_page': 'T0',
};

const CHARTER = `# CHARTER - Agency Engineer

## Mission
You are the agency's engineer. Every request an agent files comes to you first. You make sure each one ends well: handed to an agent that can already do it, answered by a tool you build, or put to a person with exactly what only they can do. You are owned by no one; what you build is for the agent that asked, and its owner approves it.

## Two kinds of request
- Something is missing: the agent needs a tool, an event or an answer it doesn't have. Handle it as below.
- Something is broken: a tool the agent already holds is failing. That is a fault to diagnose, not something to build - see "When a tool is failing" first.

## How you handle a request (engineer.list_requests shows them, with the asking agent's missing tools)
0. Questions only the person can answer - their budget or spend, targets, prices, policies, who to contact, what they prefer: engineer.hand_to_person straight away, as asked. Never answer them yourself or suggest numbers - the agent already said what it does meanwhile.
1. Another agent in the fleet can already do it (it holds the tool, it's its job)? Hand the work over with tasks.delegate_task, then engineer.close_request saying who does it now. Only genuinely related agents - not, say, customer support for an outreach email.
   Two agents asking for the same connection is not a duplicate: never close one agent's request because another asked first. Each needs its own tools. Handle it with the other (engineer.ask_for_connection on both, so the person sees one item and connecting wakes both; publish_integration's also for the second agent).
2. A tool that already exists and is live (engineer.list_integrations) would do it? Propose giving it to the agent: engineer.give_tools (a person approves).
3. A service with an API would do it? Build an integration:
   a. Read the service's API docs (web.web_search, web.fetch_page). Prefer, in order: an HTTP definition (kind: http), a remote MCP server the service runs (kind: mcp), a code plugin only when neither can do it and plugins are allowed.
   b. Write it with engineer.write_integration (YAML; to add a tool to a service that already has a connection - one you built or one a person added, but not a built-in like gmail or github - rewrite that same connection with the tool added, same id: never a second connection for the same service, and never ask the person to edit one; engineer.read_integration shows the shipped ones - brave-search, github, gmail - as examples of the format). Every http definition needs: kind, id, name, what, auth, base_url, test: { tool, args }, and each tool's id, tier, description, input (JSON schema) and request: { method, path } - leaving any out is refused. A request that names options ("a CRM (HubSpot, Zoho, Salesforce)") is naming examples: build the one the agent's instructions name (engineer.read_agent); none named, ask the person which they use before building. Give a tool only what the agent's instructions allow it to do (Bug Triage may change only status and tags: its update tool changes only those). One connection per service, named after the service ("DataForSEO", "Google Ads") - never after its tools: adding a tool later extends the same one, under the same name and id. Name each tool exactly the id the agent already expects, if it has one (its missing tools are listed with the request). Give the person what they need to connect it: key_url (where to make the key), key_help (which permissions/plan, one or two sentences), or for OAuth client_url and numbered client_help steps. A remote MCP server that has its own sign-in (Notion, Linear and the like): \`auth: { type: mcp_oauth }\` - the app finds its sign-in and registers itself, so the person just signs in. Anything else a service takes - an id and a secret, an account and a key, a region, a client id + secret + refresh token the person already has: \`auth: { type: fields }\` with the fields to ask for (name, label, help, secret: false for ids and regions), put where the service wants them with {{name}} in headers, query or base_url, and token: { url, form, pick, expires_in } when they're swapped for a short-lived token ({{token}}). A field that goes in the host (a region) takes options: the exact values it may be, shown as a list - it is refused without them. Zoho, say: fields client_id, client_secret, refresh_token, region (secret: false, options [com, eu, in, com.au, jp, ca, sa, uk], default com); token url https://accounts.zoho.{{region}}/oauth/v2/token with form grant_type refresh_token; header authorization: "Zoho-oauthtoken {{token}}"; base_url https://www.zohoapis.{{region}}. A login and password sent as HTTP Basic (DataForSEO): fields login and password, and basic: { username: "{{login}}", password: "{{password}}" } - the app encodes it; never ask a person to encode, convert or combine anything. A code plugin on a fields sign-in gets its key as JSON: the fields, plus token when there is a token exchange - renewed and kept by the app, so use that token; never renew it in the plugin (services limit renewals: Zoho allows 10 in 10 minutes). When the person says what they have, shape the fields to that - never send them back to a different way of signing in. Pick tiers by the rules: reads T0, reversible internal writes T1, anything outside the organisation or hard to undo T2.
   c. It's saved as a draft: it shows in Settings -> Connectors so the person can connect it, and no agent can call it. Then tell them it's ready with engineer.ask_for_connection - exact steps (including making an account, if it needs one), and that the key goes in Settings, never in the chat. You're woken the moment they connect it. Other agents' requests already waiting on the same connection (engineer.list_requests): one key serves them all, so the steps ask for every permission any of them needs, and say so ("covers Lead Researcher's reads and Content & SEO's pull requests") - never a narrower key than one already asked for.
   d. Test it like a careful person: the real call with real-looking inputs, then the edge cases - empty and missing inputs, a limit, nonsense - and read what an agent would see. Results must be clean, plain text; errors one readable line. Fix the definition and test again until they are.
   e. Connecting it was the person's yes to the connection itself; what they approve is which agents get which tools. engineer.publish_integration - and when other agents' open requests need the same connection, put them in also, so it's one card. A short summary for the person approving: what it lets the agent do, and its limits (which account, which repository, read-only...). Not how you tested it, and no risks unless one is obvious and significant to someone who isn't technical (it costs money, emails people outside, deletes their files) - never technical or hypothetical ones. That's the one approval: approved, it goes live, the agent gets the tools, and the request closes.
4. Something only a person can do (buy a plan, make an account, decide)? engineer.reply_to_request with the steps, and what you'll do once they're done. Not a tool problem at all, or beyond you? engineer.hand_to_person with why and what they should do.

## When a tool is failing
Find the cause before you tell anyone what to do. The agent's report is where you start, not the diagnosis: it saw one error, at one moment.
1. History first (engineer.list_requests shows it for the tools a request names; engineer.tool_history for any). A tool that has worked many times since it failed isn't broken: tell the agent so and close the request.
2. Tell the key apart from the tool with engineer.check_key: the stored key, sent straight to the service.
   - A call that should work with that key (a read, or the service's "who am I"): refused means the key is wrong or expired.
   - The failing call itself (its exact URL, from the tool's code; a write with an empty body): 400/422 means the key is allowed there, so the fault is in the tool - its URL, method, headers or body. 401/403 at that exact URL, while the key works elsewhere, is the key missing that permission; read the error body and the service's docs for which one.
   - Before blaming a URL or a permission, read the tool's code (engineer.read_integration) against the service's API docs (web.fetch_page).
3. The fault is in a tool you built: fix it yourself - the definition, or the plugin - and propose it again (engineer.publish_integration). The person only approves; they have nothing to change. Tell the agent with engineer.close_request once it's live.
4. The fault is the key or the account: engineer.reply_to_request with what you checked and what it showed (the key works for reading issues, and is refused at the comment endpoint with 403), then exactly what to change. They can't see your checks, so say what they were.
5. They did what you asked and it still fails the same way: your diagnosis was most likely wrong. Check again from step 1 before asking for anything else, and say what you found.

## Events
Some agents are woken by something happening at a service - a new Sentry issue, a support ticket, an alarm - as well as by their schedule. A request to "Set up the event sentry.new_issue" means: add it to an integration (a new one, or the service's existing one) under events:, each with an id (server.event), a description, and how it's detected:
- poll: a request like a tool's (base_url defaults to the integration's) that lists recent items, items (dot path to the list; empty when the answer is the list), id (dot path to each item's unique id), fields (what the agent sees of each), every_minutes (5 is a good default; slower for things that can wait). Each item is told once; what's there at the first check isn't news. Works from this computer with no setup beyond the key.
- webhook: the service posts to the agency's address. items/id/fields as for poll, but in the posted body; signature (header, algorithm, prefix, encoding) when the service signs its posts, with secret_help saying where the person finds the signing secret; setup_help: where in the service to paste the address.
Prefer webhook when the service has one for it, with poll as well when the service's API lists the same things (it catches anything missed). Test with engineer.test_event: a poll for real, and the webhook address to give the person (engineer.ask_for_connection with the steps: the key, the webhook address, the signing secret). The agent that asked is subscribed when the integration goes live; for one that's live already, engineer.give_events.

## Code plugins
Only if allowed (engineer.list_integrations says). For what HTTP and MCP can't do - an action on this computer, a file format to build. A plugin is a TypeScript module: \`export default { tools: [{ id, tier, description, input, run: async (args, token, kit) => string }] }\` (token is the key, if the integration takes one; return text the agent reads; throw an Error with a one-line message on failure). Node built-ins only (node:fs, node:child_process...). The network only through \`await kit.fetch(url, { method, headers, body })\`, which returns a Response and refuses this computer and its network - never fetch(), node:http(s), or downloading from a shell; writing the plugin is refused if it does. Pair it with a kind: code definition naming the module, and declare in it exactly what the plugin touches: \`permissions: { write: [folders], read: [folders], commands: true|false }\` (absolute paths or ~/...; a whole drive or the whole home folder is refused). It runs in a sandbox that allows nothing else - no other files, no programs unless commands is true, and no network but kit.fetch. Before you can propose it, an independent security review reads it: inputs agents choose must never reach commands, scripts or paths unchecked (pass them as data, e.g. environment variables, never built into a command line). If the review sends it back, fix what it says. Its code never runs before a person approves giving it to an agent, so you can't test it first: write it carefully, and test it as soon as it's live; if it fails, fix it and propose again.

## When a person turns a request down
A no to the way you picked (HubSpot) is rarely a no to what the agent needs (somewhere to keep its leads). Never let one leave an agent stuck with nothing to do.
1. They said why: act on it. They use something else (Zoho, not HubSpot)? Build or connect that instead. They don't want it at all? Tell the agent with tasks.delegate_task to carry on without it, and how (keep leads in a file in its workspace, say).
2. They didn't say why: ask them once, with requests.request_resource. In a sentence what the agent needs it for, then 2 to 4 options as a list: the usual alternatives to what you picked, and a simple fallback (a Google Sheet, or keeping it in the agent's own files). They can answer in a word.
3. They turn your own ask down, or say it isn't needed: tell the agent with tasks.delegate_task to carry on with the fallback, and leave it there - don't ask again.

## Talking to the person
- Decide, build, then tell them. Pick the best way yourself and write the draft first - never ask whether you should. If they don't want it, they reply or reject the request (that discards the draft).
- Short: what you set up and, in a sentence or two, why it's the best way; then numbered steps for what they do. No account of your research, no list of alternatives unless they ask. About 5 sentences plus the steps.
- Name tools by what they do ("Web search"), never their ids (web.web_search), and their levels as silent, logged or approval - never T0, T1 or T2.
- Brevity is everything: the person reading may not be technical. Leave out what's implied or minor - no edge cases, no hypothetical risks, no testing details.
- Each step on its own line, numbered (1. 2. 3.); points on their own lines starting with "- ". The app shows them as lists.
- When another request needs the same thing (the same repository, key or decision), point to it instead of asking again: write "request #41" - the person can click it. Do the shared work once and use it for both.

## Rules
- Woken for a request that isn't in engineer.list_requests any more? It was closed (turned down, handed over, or its agent deleted): drop it and move on. Never ask anyone to restore or resend it.
- A card you proposed can't be proposed again while it waits. When it should change - the person asks for something different on the request, or a better way turns up - engineer.withdraw_proposal, then propose the updated one. Never leave the old one waiting next to the new.
- A withdrawn request's agent was deleted; nobody turned it down. Never undo or strip back work for it - a connection you drafted stays as it is.
- Always tell the person what to do next - never just why something can't be done.
- Never ask for keys, passwords or tokens in a conversation; if someone pastes one, tell them it belongs in Settings -> Connectors and not to share it.
- Steer people to the right button: replying doesn't approve anything (that's the Approvals page); DIY and Reject are on the request itself; keys and sign-ins are in Settings -> Connectors.
- Agents can't reach this computer's network, and integrations can't call local addresses: don't build for one.
- One request at a time, carried as far as it can go in this run; your memory keeps what you're waiting on.
- Refer to people by name, or as "they", unless their profile states their pronouns.

## What a good run looks like
Every request you touched moved: handed over, a draft written, a person asked something precise, a test run, or a go-live proposed.
`;

const KPI = `# KPI - Agency Engineer: successful calls of these actions are its output.
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
    tool_tiers: { ...ENGINEER_TOOLS, ...builtInLevels(FLEET_ENGINEER) },
    approval_windows: { 'engineer.publish_integration': { window_seconds: 7 * 86400 }, 'engineer.give_tools': { window_seconds: 7 * 86400 }, 'engineer.give_events': { window_seconds: 7 * 86400 } },
    new_tools: [],
    // It runs when there's work (requests, connections, replies); a daily look otherwise.
    ferocity: { every_hours: [24, 24, 24, 24], soft_floor: 0, floor: 0, apocalyptic_floor: 0, counts: [], hint: '', extra_effort: '' },
  });
  await save(
    { id: FLEET_ENGINEER, name: 'Agency Engineer', department: 'engineering', charter: CHARTER, tools: `# TOOLS - Agency Engineer (built in)\n${tools}`, kpi: KPI, models },
    { name: 'Agency Engineer', department: 'engineering', output: ['integrations written', 'tests run', 'requests closed'], status: 'ready', builtIn: true },
  );
  return dir;
}

// --- Requests ------------------------------------------------------------------------

type RequestRow = { id: number; agent_id: string; what: string; why: string; evidence: string | null; expected_effect: string | null; status: string; stage: string | null; created_at: number };

export function postToRequest(id: number, from: 'engineer' | 'you', text: string, now = Date.now()) {
  exec('INSERT INTO request_messages (request_id, from_who, text, at) VALUES (?, ?, ?, ?)', id, from, text.slice(0, 6000), now);
}
const setStage = (id: number, stage: string) => exec('UPDATE requests SET stage = ? WHERE id = ?', stage, id);
// The connection a request waits for the person to connect, by id: recorded by
// engineer.ask_for_connection. Older ones only have its message, ending
// "Settings -> Connectors -> Integrations -> <name>", and a connection's name can
// grow as tools are added ("DataForSEO Keyword Research" -> "... and SERP"), so
// the name is matched to the connection it became.
const ASKED_TO_CONNECT = /Settings\s*->\s*Connectors\s*->\s*Integrations\s*->\s*(.+?)\s*$/m;
export function waitingOn(requestId: number, connections: { id: string; name: string }[]): { id: string; name: string } | null {
  const recorded = one<{ waiting_on: string | null }>('SELECT waiting_on FROM requests WHERE id = ?', requestId)?.waiting_on;
  const byId = recorded ? connections.find(c => c.id === recorded) : undefined;
  if (byId) return byId;
  const said = all<{ text: string }>("SELECT text FROM request_messages WHERE request_id = ? AND from_who = 'engineer' ORDER BY id DESC", requestId);
  for (const m of said) {
    const name = ASKED_TO_CONNECT.exec(m.text)?.[1]?.trim();
    if (!name) continue;
    // Its name then, or the connection sharing the longest beginning with it (reworded as it grew).
    const shared = (c: { name: string }) => {
      let n = 0;
      while (n < Math.min(c.name.length, name.length) && c.name[n].toLowerCase() === name[n].toLowerCase()) n++;
      return n;
    };
    const best = connections.find(c => c.name === name) ?? [...connections].sort((x, y) => shared(y) - shared(x))[0];
    return best && (best.name === name || shared(best) >= 12) ? best : { id: name, name };
  }
  return null;
}
// Every request waiting on the person to connect this one.
const waitingFor = (id: string, connections: { id: string; name: string }[]) =>
  all<{ id: number }>("SELECT id FROM requests WHERE status = 'open' AND stage = 'waiting_you'")
    .map(r => r.id)
    .filter(r => waitingOn(r, connections)?.id === id);
// The same proposal already waiting on a person (a later run proposing it
// again doesn't see it): refused, so a person never approves it twice.
// A request already on a card waiting for a person - its own, or grouped into
// another agent's (publish_integration's also): refused, one card per agent.
const cardFor = (requestId: number) =>
  one<{ id: string; args: string; created_at: number }>(
    `SELECT id, args, created_at FROM approvals WHERE status = 'pending' AND agent_id = ? AND tool IN ('engineer.publish_integration', 'engineer.give_tools', 'engineer.give_events')
       AND (CAST(json_extract(args, '$.request_id') AS INTEGER) = ? OR EXISTS (SELECT 1 FROM json_each(args, '$.also') WHERE CAST(json_extract(value, '$.request_id') AS INTEGER) = ?))`,
    FLEET_ENGINEER,
    requestId,
    requestId,
  );
export const requestNotWaiting = (requestId: unknown) => {
  const n = Number(requestId);
  const same = cardFor(n);
  if (same)
    throw new Error(
      `Request #${n} is already on a card waiting for a person's approval (proposed ${Math.max(1, Math.round((Date.now() - same.created_at) / 60_000))} min ago). To change what it proposes, withdraw it first (engineer.withdraw_proposal); otherwise leave it and carry on with other work.`,
    );
};
// Takes a waiting card off the Approvals page, so an updated one can replace it.
// Every request on it goes back to the engineer.
export function withdrawProposal(requestId: number, why: string) {
  const card = cardFor(requestId);
  if (!card) throw new Error(`Request #${requestId} has no card waiting for approval.`);
  exec("UPDATE approvals SET status = 'withdrawn', decided_at = ?, note = ? WHERE id = ? AND status = 'pending'", Date.now(), why.slice(0, 500), card.id);
  const args = JSON.parse(card.args) as Record<string, unknown>;
  const on = [Number(args.request_id), ...((args.also as { request_id: number }[] | undefined) ?? []).map(g => Number(g.request_id))].filter(Boolean);
  for (const id of on) exec("UPDATE requests SET stage = 'engineer' WHERE id = ? AND status = 'open'", id);
  return on;
}
export const notWaitingAlready = (tool: string, a: Record<string, unknown>, key: string) => {
  const same = one<{ created_at: number }>(
    `SELECT created_at FROM approvals WHERE status = 'pending' AND agent_id = ? AND tool = ? AND json_extract(args, '$.for_agent') = ? AND CAST(json_extract(args, '$.${key}') AS TEXT) = ?`,
    FLEET_ENGINEER,
    tool,
    String(a.for_agent),
    String(a[key]),
  );
  if (same) throw new Error(`That's already waiting for a person's approval (proposed ${Math.max(1, Math.round((Date.now() - same.created_at) / 60_000))} min ago). Don't propose it again - carry on with other work.`);
};
const openRequest = (raw: unknown): RequestRow => {
  const r = one<RequestRow>('SELECT * FROM requests WHERE id = ?', Number(raw));
  if (!r) throw new Error(`No request #${raw}.`);
  if (r.status === 'withdrawn')
    throw new Error(`Request #${r.id} was withdrawn: the agent that asked for it was deleted. Nobody turned it down - keep what you drafted for it as it is (another agent, or the same one added back, may need it) and move on.`);
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

// Who a publish_integration card gives the connection to: the agent it's for, then any grouped with it.
type Grant = { for_agent: string; request_id: number; tools: { id: string; tier: Tier }[] };
const grantsOf = (a: Record<string, unknown>): Grant[] => [
  { for_agent: String(a.for_agent), request_id: Number(a.request_id), tools: (a.tools as Grant['tools']) ?? [] },
  ...((a.also as Grant[] | undefined) ?? []).map(g => ({ for_agent: String(g.for_agent), request_id: Number(g.request_id), tools: g.tools ?? [] })),
];

// --- Tool history --------------------------------------------------------------------
// How tools have actually done for the agents holding them, from the action log
// and each tool's last failure: whether something is broken now, or failed once
// and has worked since.

const ago = (at: number, now = Date.now()) => {
  const m = Math.round((now - at) / 60_000);
  return m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function toolHistory(tools: string[], agentId?: string, days = 14, now = Date.now()): string {
  const since = now - days * 86_400_000;
  const match = (t: string) => tools.some(x => t === x || t.startsWith(`${x}.`));
  const rows = all<{ agent_id: string; tool: string; outcome: string; at: number }>(
    "SELECT agent_id, tool, outcome, at FROM actions WHERE at >= ? AND outcome IN ('ok', 'failed') ORDER BY at",
    since,
  ).filter(r => match(r.tool) && (!agentId || r.agent_id === agentId));
  const health = all<{ agent_id: string; tool: string; last_ok: number | null; last_fail: number | null; last_error: string | null }>('SELECT * FROM tool_health').filter(
    h => match(h.tool) && (!agentId || h.agent_id === agentId),
  );
  const keys = [...new Set([...rows, ...health].map(r => `${r.agent_id}\u0000${r.tool}`))];
  if (!keys.length) return `No calls of ${tools.join(', ')} in the last ${days} days.`;
  return keys
    .map(k => {
      const [agent, tool] = k.split('\u0000');
      const calls = rows.filter(r => r.agent_id === agent && r.tool === tool);
      const h = health.find(x => x.agent_id === agent && x.tool === tool);
      const ok = calls.filter(c => c.outcome === 'ok').length;
      const lastFail = h?.last_fail ? `last failure ${ago(h.last_fail, now)}: ${h.last_error ?? '(no message)'}` : 'no failures recorded';
      const lastOk = h?.last_ok ? `last success ${ago(h.last_ok, now)}` : 'never succeeded';
      const recent = calls.slice(-20).map(c => (c.outcome === 'ok' ? 'ok' : 'FAIL')).join(' ');
      return `${tool} (${agent}): ${ok} ok, ${calls.length - ok} failed in ${days} days; ${lastOk}; ${lastFail}${recent ? `\n  last ${Math.min(20, calls.length)}, oldest first: ${recent}` : ''}`;
    })
    .join('\n');
}

// The history of the tools a request names, so a stale failure shows as one.
function namedToolHistory(r: RequestRow): string {
  const text = [r.what, r.why, r.evidence ?? ''].join(' ');
  const known = new Set(all<{ tool: string }>('SELECT DISTINCT tool FROM tool_health WHERE agent_id = ?', r.agent_id).map(t => t.tool));
  const named = [...new Set([...text.matchAll(/\b[a-z][a-z0-9_-]*\.[a-z][a-z0-9_]*\b/g)].map(m => m[0]))].filter(t => known.has(t));
  return named.length ? `\n  How the tools it names have done since:\n${toolHistory(named, r.agent_id).replace(/^/gm, '    ')}` : '';
}

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
    description:
      "The open requests: yours to act on in full (what the agent asked, the conversation, its missing tools), the ones waiting on a person as one line each. request_id: just that one, in full.",
    schema: obj({ request_id: int('Optional: one request, in full') }),
    impl: async a => {
      // A tool agents already rely on that's broken comes before anything new: then
      // what's yours to do (not waiting on a person), oldest first.
      const one_ = Number(a.request_id) || 0;
      const rows = all<RequestRow>(
        `SELECT * FROM requests WHERE status = 'open' AND agent_id != ?${one_ ? ' AND id = ?' : ''} ORDER BY (what LIKE 'Fix the tool %') DESC, (stage = 'engineer') DESC, id`,
        FLEET_ENGINEER,
        ...(one_ ? [one_] : []),
      );
      if (!rows.length) return one_ ? `Request #${one_} isn't open.` : 'No open requests.';
      const out: string[] = [];
      // With fifty open the full list was too big to read: those waiting on a person
      // are one line each (request_id for the rest of one).
      const waiting = one_ ? [] : rows.filter(r => r.stage === 'waiting_you' || r.stage === 'person' || r.stage === 'approval');
      for (const r of rows) {
        if (waiting.includes(r)) continue;
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
            .join('\n') + (await missingTools(r.agent_id)) + namedToolHistory(r),
        );
      }
      if (waiting.length)
        out.push(`Waiting on a person (${waiting.length}) - engineer.list_requests with request_id for one in full:\n${waiting.map(r => `#${r.id} ${r.agent_id} · ${r.stage}: ${r.what.slice(0, 120)}`).join('\n')}`);
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
    description: 'Close a request that is settled (handed to another agent, or answered). The asking agent is woken with your answer.',
    schema: obj({ request_id: int('The request number'), answer: str('For the asking agent: what happened and what it can do now') }, ['request_id', 'answer']),
    impl: async (a, ctx) => {
      const r = openRequest(a.request_id);
      const answer = String(a.answer).slice(0, 4000);
      exec("UPDATE requests SET status = 'done', answer = ?, answered_at = ?, stage = NULL WHERE id = ?", answer, Date.now(), r.id);
      postToRequest(r.id, 'engineer', answer);
      // Woken with it: an answer that unblocks it (the playbook's real path) waited a day
      // for its next scheduled run.
      const asker = one<{ agent_id: string }>('SELECT agent_id FROM requests WHERE id = ?', r.id)?.agent_id;
      if (asker && asker !== FLEET_ENGINEER) ctx.wake(asker, 'self-booked', `Request #${r.id} is answered: ${answer.slice(0, 600)}`);
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
      const saved = await savedSettings(String(a.id));
      const settings = Object.keys(saved).length ? `\n--- saved settings (what the person entered; secrets not shown) ---\n${Object.entries(saved).map(([k, v]) => `${k}: ${v}`).join('\n')}\nBuild for these values - don't assume another region or account.` : '';
      return `${src.yaml}${src.code ? `\n--- plugin code ---\n${src.code}` : ''}${settings}`;
    },
  },
  {
    id: 'engineer.write_integration',
    tier: 'T0',
    description:
      'Save an integration definition (YAML: kind http | mcp | code, as in the shipped examples) as a DRAFT: it shows in Settings to be connected; no agent can call it until a person approves it going live. Rewriting a live one makes the change a draft; the live version keeps working for the agents that have it until the change is approved, and a connected one stays connected.',
    schema: obj({ definition: str('The whole YAML definition'), request_id: int('The request it answers') }, ['definition']),
    impl: async a => {
      const { integration, wasLive } = await writeDraftIntegration(String(a.definition), FLEET_ENGINEER, a.request_id ? Number(a.request_id) : undefined);
      // Already connected (its key or sign-in is saved): nothing to ask the person.
      const connected = (await listIntegrations()).find(i => i.id === integration.id)?.connected;
      const needs =
        integration.auth.type === 'none' || connected
          ? `${connected ? "It's still connected - its key or sign-in carries over" : 'It needs no key'}: test it now (engineer.test_integration). Don't ask the person to connect it again.`
          : 'It needs a key or sign-in: ask the person with engineer.ask_for_connection.';
      return `Saved "${integration.id}" (${integration.name}) as a draft${wasLive ? ' - the live version keeps working for the agents that have it until this change is approved' : ''}. It shows in Settings -> Connectors. ${needs}`;
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
      if (['gmail', 'github'].includes(module)) throw new Error(`"${module}" is the built-in ${module === 'gmail' ? 'Gmail' : 'GitHub'} connection's: pick another name, like "${module}-actions".`);
      if (!/^[a-z0-9-]+$/.test(module)) throw new Error('Pick another module name: lowercase letters, digits and dashes.');
      await writePlugin(module, String(a.code));
      return `Saved plugin "${module}". It runs only once the independent review passes it and a person approves giving it to an agent (engineer.publish_integration).`;
    },
  },
  {
    id: 'engineer.ask_for_connection',
    tier: 'T0',
    description: "Ask the person to connect a draft integration in Settings -> Connectors (its key or sign-in). Say what the key needs (permissions, scopes). The link to the key page (its key_url) and a button to it in Settings are added after your message - don't write them, or 'linked below'. You're woken when they connect it.",
    schema: obj({ integration_id: str('The draft integration'), request_id: int('The request it answers'), message: str('One or two sentences on what it is and why it is the best way, then the steps, numbered') }, [
      'integration_id',
      'request_id',
      'message',
    ]),
    impl: async a => {
      const r = openRequest(a.request_id);
      const i = (await listIntegrations()).find(x => x.id === String(a.integration_id));
      if (!i) throw new Error(`No integration "${a.integration_id}".`);
      // Asked already: the person has the steps - saying them again is noise.
      const was = one<{ waiting_on: string | null; stage: string | null }>('SELECT waiting_on, stage FROM requests WHERE id = ?', r.id);
      if (was?.waiting_on === i.id && was.stage === 'waiting_you') return `Request #${r.id} is already waiting on the person to connect ${i.name}, with the steps. Nothing more to say on it; you'll be woken when it's connected.`;
      // Added here, not left to the message: the real key page, and the place in
      // Settings (the app shows it as a button that opens it, glowing).
      const said = String(a.message).trim();
      postToRequest(r.id, 'engineer', `${said}\n\n${i.keyUrl && !said.includes(i.keyUrl) ? `Get the key here: ${i.keyUrl}\n` : ''}Settings -> Connectors -> Integrations -> ${i.name}`);
      setStage(r.id, 'waiting_you');
      exec('UPDATE requests SET waiting_on = ? WHERE id = ?', i.id, r.id);
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
    id: 'engineer.tool_history',
    tier: 'T0',
    description:
      "How tools have really done for the agents holding them: successes and failures over the last days, the last error, and the recent run of outcomes. Whether a tool is broken now, or failed once and has worked since.",
    schema: obj(
      {
        tools: { type: 'array', items: { type: 'string' }, description: "Tool ids (errors.resolve_issue), or a prefix (errors) for all of one server's tools" },
        agent_id: str('Optional: just this agent'),
        days: int('Optional: how far back (default 14)'),
      },
      ['tools'],
    ),
    impl: async a => toolHistory(((a.tools as unknown[]) ?? []).map(String), a.agent_id ? String(a.agent_id) : undefined, Number(a.days) || 14),
  },
  {
    id: 'engineer.check_key',
    tier: 'T0',
    description:
      "Send one request with an integration's stored key, the way the integration sends it, to see whether the service accepts the key there - without going through the tool's code. Only to the hosts the integration already uses, no redirects. GET/HEAD to read, anywhere on those hosts. POST/PATCH go with an empty body ({}), and only to an endpoint one of the integration's own tools writes to (the failing call's URL): there an allowed key gets a validation error (400/422) and a refused one 401/403, and nothing is made or changed. You see the status, any scope/permission headers, and the start of the body; never the key.",
    schema: obj({ integration_id: str('The integration whose key to use'), method: str('GET, HEAD, POST or PATCH'), url: str('The full https URL') }, ['integration_id', 'method', 'url']),
    impl: async a => checkKey(String(a.integration_id), String(a.method), String(a.url)),
  },
  {
    id: 'engineer.publish_integration',
    tier: 'T2',
    description:
      "Propose giving agents a connection the person has connected and you've tested: one card, for every agent waiting on it (also). The person approves which agents get which tools, from your summary. Approved, it goes live, each agent gets its tools, and their requests close with your summary as the answer.",
    schema: obj(
      {
        integration_id: str('The draft integration'),
        request_id: int('The request it answers'),
        for_agent: str('The agent that gets its tools'),
        tools: toolsArg,
        events: { type: 'array', items: { type: 'string' }, description: "Optional: its events the agent should wake on (default: the ones the agent expects that it provides)" },
        also: {
          type: 'array',
          description: "Other agents whose open requests need this same connection: given it on the same card, so the person approves once. Each {for_agent, request_id, tools}.",
          items: obj({ for_agent: str('The agent'), request_id: int('Its request'), tools: toolsArg }, ['for_agent', 'request_id', 'tools']),
        },
        summary: str("For the person approving: at most 3 plain sentences - what it lets the agent do, and its limits. Nothing about testing; no risks unless obvious and significant to someone who isn't technical. The card shows only this and a few bullets."),
      },
      ['integration_id', 'request_id', 'for_agent', 'tools', 'summary'],
    ),
    // What the person sees and approves, fixed when it's queued: the plugin
    // runs only if its code is still exactly this.
    preview: async a => {
      const grants = grantsOf(a);
      const seen = new Set<string>();
      for (const g of grants) {
        // One entry per agent, each for a request about this connection: the card
        // otherwise reads "Lead Researcher, Outreach and Lead Researcher".
        if (seen.has(g.for_agent)) throw new Error(`${await nameOf(g.for_agent)} is on this card twice: one entry per agent, with all its tools. Leave out request #${g.request_id}, or settle it on its own.`);
        seen.add(g.for_agent);
        const waits = one<{ waiting_on: string | null }>('SELECT waiting_on FROM requests WHERE id = ?', g.request_id)?.waiting_on;
        if (waits && waits !== String(a.integration_id)) throw new Error(`Request #${g.request_id} is waiting on ${waits}, not ${a.integration_id}: leave it off this card.`);
        openRequest(g.request_id);
        if (!(await loadAgent(g.for_agent))) throw new Error(`No agent "${g.for_agent}".`);
        requestNotWaiting(g.request_id);
      }
      notWaitingAlready('engineer.publish_integration', a, 'integration_id');
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
        // At most one warning, and only one a non-technical person would clearly care about.
        bullets = [...r.canDo.slice(0, 4), ...(r.warn ? [`Worth knowing: ${r.warn}`] : [])];
      }
      const names = await Promise.all(grants.map(g => nameOf(g.for_agent)));
      const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
      for (const g of grants) {
        setStage(g.request_id, 'approval');
        // Said on the request every time, so the person knows it's their move.
        postToRequest(g.request_id, 'engineer', `${p.name} is tested and ready. ${who} get${names.length > 1 ? '' : 's'} it when you approve it on the Approvals page.`);
      }
      return {
        name: p.name,
        for_agent_name: who,
        tools_list: grants.length > 1 ? grants.map((g, i) => `${names[i]}: ${toolsForPeople(g.tools)}`).join('; ') : toolsForPeople(grants[0].tools),
        events_list: (await eventsFor(String(a.for_agent), String(a.integration_id), a.events)).map(toolTitle).join(', '),
        review: [String(a.summary).trim(), bullets.map(x => `- ${x}`).join('\n')].filter(Boolean).join('\n\n'),
        code_hash: p.codeHash,
      };
    },
    impl: async (a, ctx) => {
      // Run without a card (a person set this below Approval): a plugin is still
      // reviewed, and pinned to the code that was reviewed.
      if (a.code_hash === undefined) {
        const p = await publishPreview(String(a.integration_id));
        if (p.code && p.permissions) {
          const r = await reviewPlugin({ name: p.name, yaml: p.yaml, code: p.code, permissions: p.permissions });
          if (r.verdict === 'fix') throw new Error(`The security review sent the plugin back. Concerns: ${r.concerns.map(c => `(${c.severity}) ${c.what}`).join('; ')}. What to change: ${r.fix || 'see the concerns'}.`);
        }
        a = { ...a, name: p.name, code_hash: p.codeHash };
      }
      // Requests closed since it was queued (answered another way) are left alone.
      const grants = grantsOf(a).filter(g => one<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE id = ? AND status = 'open'", g.request_id)?.n);
      const out = await publishIntegration(String(a.integration_id), (a.code_hash as string | null) ?? null);
      if (out.kept) {
        const why = `The new version of ${String(a.name ?? a.integration_id)} failed its test going live (${out.test}), so the version that was working stays live and nobody lost anything. The new one is still a draft.`;
        for (const g of grants) {
          setStage(g.request_id, 'engineer');
          postToRequest(g.request_id, 'engineer', `${why} I'm fixing it.`);
        }
        ctx.wake(FLEET_ENGINEER, 'request', `${why} Find out why (engineer.check_key, the service's docs), fix the draft and propose it again. Requests: ${grants.map(g => `#${g.request_id}`).join(', ')}.`);
        return `Not live: ${why}`;
      }
      const tested = out.test ? ` Its test as it went live: ${out.test}` : '';
      const said: string[] = [];
      for (const [i, g] of grants.entries()) {
        const wanted = g.tools.filter(t => out.tools.some(x => x.id === t.id));
        const given = wanted.length ? wanted : out.tools;
        await giveTools(g.for_agent, given);
        // Its events: for the agent the card was made for (the ones grouped with it get tools).
        const events = i === 0 && g.for_agent === String(a.for_agent) ? await eventsFor(g.for_agent, String(a.integration_id), a.events) : [];
        if (events.length) await giveEvents(g.for_agent, events);
        const ids = [...given.map(t => t.id), ...events.map(e => `${e} (wakes it)`)].join(', ');
        postToRequest(g.request_id, 'engineer', `${String(a.name ?? a.integration_id)} is live and given to ${await nameOf(g.for_agent)}.${tested}`);
        // A request closes only once nothing its agent needs is missing; otherwise
        // it goes back to the engineer for the rest.
        const { missing } = await stillMissing(g.for_agent);
        if (missing.length) {
          setStage(g.request_id, 'engineer');
          const rest = missing.map(t => t.id).join(', ');
          ctx.wake(FLEET_ENGINEER, 'request', `${ids} went live for ${g.for_agent}. Request #${g.request_id} still needs: ${rest}.`);
          said.push(`${g.for_agent} (request #${g.request_id} stays open for: ${rest})`);
          continue;
        }
        exec("UPDATE requests SET status = 'done', answer = ?, answered_at = ?, stage = NULL WHERE id = ?", `${String(a.summary)}\n\nYou now have: ${ids}.`, Date.now(), g.request_id);
        // Woken to use them now: an agent that was blocked runs only as Steady (scheduler).
        ctx.wake(g.for_agent, 'self-booked', `Request #${g.request_id} is done - you now have ${ids}. Use them on your real work now.`);
        said.push(g.for_agent);
      }
      return `Live: ${String(a.name ?? a.integration_id)} for ${said.join(', ') || 'nobody (their requests had closed)'}.${tested}`;
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
      requestNotWaiting(a.request_id);
      const live = new Set(liveEventIds());
      const bad = ((a.events as string[]) ?? []).filter(e => !live.has(e));
      if (bad.length) throw new Error(`Not live: ${bad.join(', ')}. Set them up and publish their integration first.`);
      setStage(Number(a.request_id), 'approval');
      postToRequest(Number(a.request_id), 'engineer', `${await nameOf(String(a.for_agent))} wakes on these when you approve it on the Approvals page.`);
      return { for_agent_name: await nameOf(String(a.for_agent)), events_list: ((a.events as string[]) ?? []).map(toolTitle).join(', ') };
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
    id: 'engineer.withdraw_proposal',
    tier: 'T1',
    description:
      "Take your card off the Approvals page - for when what it proposes should change (the person asked for something different on the request, or you found a better way). Every request on it comes back to you; then propose the updated one.",
    schema: obj({ request_id: int('A request on the card'), why: str('Why, in a sentence - said on the request') }, ['request_id', 'why']),
    impl: async a => {
      const on = withdrawProposal(Number(a.request_id), String(a.why));
      for (const id of on) postToRequest(id, 'engineer', `I took my proposal off the Approvals page: ${String(a.why)} An updated one follows.`);
      return `Withdrawn. Requests back with you: ${on.map(id => `#${id}`).join(', ')}. Propose the updated card now.`;
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
      requestNotWaiting(a.request_id);
      setStage(Number(a.request_id), 'approval');
      postToRequest(Number(a.request_id), 'engineer', `${await nameOf(String(a.for_agent))} gets these tools when you approve it on the Approvals page.`);
      return { for_agent_name: await nameOf(String(a.for_agent)), tools_list: toolsForPeople((a.tools as { id: string; tier: string }[]) ?? []) };
    },
    impl: async (a, ctx) => {
      const r = openRequest(a.request_id);
      const tools = (a.tools as { id: string; tier: Tier }[]) ?? [];
      await giveTools(String(a.for_agent), tools);
      ctx.wake(String(a.for_agent), 'self-booked', `Request #${r.id} is done - you now have ${tools.map(t => t.id).join(', ')}. Use them on your real work now.`);
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
  whenDraftConnected(async (id, request) => {
    const all = [...new Set([...(request ? [request] : []), ...waitingFor(id, await listIntegrations())])];
    book(FLEET_ENGINEER, 'connected', `The person connected the draft integration "${id}"${all.length ? ` (for request #${all.join(', #')})` : ''}.`);
  });
  // A live connection (GitHub, built in) connected: nine requests waited on it and
  // nothing woke. An agent that already holds its tools has them working now -
  // its request closes and it's woken to use them; the rest go to the engineer.
  whenConnected(async id => {
    const list = await listIntegrations();
    const name = list.find(i => i.id === id)?.name ?? id;
    const tools = new Set(toolIdsOf(id));
    const rest: number[] = [];
    for (const r of waitingFor(id, list)) {
      const req = one<{ agent_id: string }>('SELECT agent_id FROM requests WHERE id = ?', r);
      const agent = req ? await loadAgent(req.agent_id) : null;
      const has = agent ? Object.keys(heldTools(agent)).filter(t => tools.has(t)) : [];
      if (!agent || !has.length) {
        rest.push(r);
        continue;
      }
      exec("UPDATE requests SET status = 'done', answer = ?, answered_at = ?, stage = NULL WHERE id = ?", `${name} is connected - your tools from it work now: ${has.join(', ')}.`, Date.now(), r);
      book(agent.id, 'connected', `Request #${r} is done: ${name} is connected, so ${has.join(', ')} work now. Use them on your real work.`);
    }
    if (rest.length) book(FLEET_ENGINEER, 'connected', `The person connected "${id}" (${name}); request #${rest.join(', #')} waited on it. Give the agents what they need from it, or close what's settled.`);
  });
  // Requests from before it existed come to it once.
  const old = all<{ id: number; agent_id: string; what: string }>("SELECT id, agent_id, what FROM requests WHERE status = 'open' AND stage IS NULL AND agent_id != ?", FLEET_ENGINEER);
  for (const r of old) {
    setStage(r.id, 'engineer');
    book(FLEET_ENGINEER, 'request', `Request #${r.id} from ${r.agent_id}: ${r.what.slice(0, 300)}`);
  }
}
