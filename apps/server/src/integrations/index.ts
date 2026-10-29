import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import type { Tier } from '../catalog.js';
import { all, getSetting, setSetting } from '../runner/db.js';
import { registerTools, type ToolDef } from '../runner/tools.js';
import { deleteSecret, getSecret, setSecret } from '../vault.js';
import { authParts, callHttp } from './http.js';
import { callMcpTool, listMcpTools, type McpTool } from './mcp-client.js';
import { MODULES, type CodeModule } from './modules/index.js';
import { codeHash, dropPluginBackup, installPlugin, pluginModule, readPlugin, readPluginBackup, removePlugin, restorePlugin } from './plugins.js';
import { resolvePermissions } from './sandbox.js';
import { safeFetch } from '../runner/net.js';
import type { Kit } from './modules/types.js';

// What a code tool gets besides its inputs: the safe fetcher, its only way out.
const KIT: Kit = { fetch: async (url, init) => (await safeFetch(url, init)).res as unknown as Response };
import { discoverMcpSignIn } from './mcp-auth.js';
import { stopStdioServer } from './mcp-stdio.js';
import { oauthAccessToken, oauthCallback, oauthSecret, oauthSignOut, oauthStart, setOAuthAccount } from './oauth.js';
import { Integration, type EventDefT, type HttpIntegration, type McpIntegration } from './schema.js';

// Integrations (docs/integrations.md): the ones that ship with the app
// (apps/server/integrations/*.yaml) and the ones added later - by a person,
// or by the Agency Engineer behind a person's approval (data/integrations/).
// Keys live in the vault; whether each is connected, its last test, and an
// MCP server's discovered tools live in the runner's store.

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED = join(HERE, '..', '..', 'integrations');
const ADDED = join(HERE, '..', '..', 'data', 'integrations');
// The live definition of one being redrafted, until the draft goes live or is turned down.
const LIVE = join(ADDED, '.live');

// draft: written by the Agency Engineer and not live yet - no agent can call it
// until a person approves it (it can be connected and tested meanwhile).
// codeHash: for a code plugin, the code a person approved.
type State = {
  connectedAt?: number;
  test?: { ok: boolean; at: number; message: string };
  tools?: McpTool[];
  draft?: boolean;
  by?: string;
  request?: number;
  codeHash?: string;
  published?: boolean; // it has been live: a turned-down draft of it puts the live version back
  liveHash?: string; // while it's redrafted: the live plugin code's approved hash
};
const STATE_KEY = 'integrations';
const states = () => getSetting<Record<string, State>>(STATE_KEY, {});
const putState = (id: string, s: State | null) => {
  const all = states();
  if (s) all[id] = s;
  else delete all[id];
  setSetting(STATE_KEY, all);
};
const secretKey = (id: string) => `integration:${id}`;
// The key, or for a signed-in (OAuth) integration its current access token.
const keyOf = async (id: string) => {
  const auth = find(id)?.auth;
  if (auth?.type === 'oauth2') return oauthAccessToken(id, auth);
  if (auth?.type === 'mcp_oauth') {
    const found = (await oauthSecret(id))?.discovered;
    return found ? oauthAccessToken(id, found) : undefined;
  }
  return (await getSecret<{ key: string }>(secretKey(id)))?.key;
};

let loaded: { integration: Integration; shipped: boolean }[] = [];
let problems: { file: string; error: string }[] = [];

async function readDir(dir: string, shipped: boolean) {
  const files = (await readdir(dir).catch(() => [] as string[])).filter(f => /\.ya?ml$/.test(f)).sort();
  for (const file of files) {
    try {
      const parsed = Integration.parse(parse(await readFile(join(dir, file), 'utf8')));
      loaded = loaded.filter(l => l.integration.id !== parsed.id);
      loaded.push({ integration: parsed, shipped });
    } catch (e) {
      problems.push({ file, error: (e as Error).message.slice(0, 300) });
    }
  }
}

// A live integration being redrafted: the version agents keep using meanwhile.
let liveCopies = new Map<string, Integration>();

export async function loadIntegrations() {
  loaded = [];
  problems = [];
  liveCopies = new Map();
  await readDir(SHIPPED, true);
  await readDir(ADDED, false);
  for (const file of (await readdir(LIVE).catch(() => [] as string[])).filter(f => /\.ya?ml$/.test(f))) {
    const parsed = Integration.safeParse(parse(await readFile(join(LIVE, file), 'utf8').catch(() => '')));
    if (parsed.success && states()[parsed.data.id]?.draft) liveCopies.set(parsed.data.id, parsed.data);
  }
  // Plugins a person approved, loaded only if their code is still what they saw.
  // One being redrafted runs its live code (kept aside) until the new code is approved.
  for (const { integration: drafted } of loaded) {
    const st = states()[drafted.id];
    const integration = liveCopies.get(drafted.id) ?? drafted;
    const hash = st?.codeHash ?? (liveCopies.has(drafted.id) ? st?.liveHash : undefined);
    if (integration.kind !== 'code' || MODULES[integration.module] || !hash) continue;
    const source = st?.codeHash ? undefined : ((await readPluginBackup(integration.module)) ?? undefined);
    await installPlugin(integration.module, hash, resolvePermissions(integration.permissions), source).catch(e => problems.push({ file: `${integration.module}.ts`, error: (e as Error).message }));
  }
  register();
}

const find = (id: string) => loaded.find(l => l.integration.id === id)?.integration;
const isConnected = (id: string) => !!states()[id]?.connectedAt;
// What agents can use: connected, and not a draft - or a draft of one that's
// live, whose live version they keep using until the draft is approved.
const isLive = (id: string) => isConnected(id) && (!states()[id]?.draft || liveCopies.has(id));
// A code integration's tools: shipped modules, or an approved plugin.
const moduleOf = (name: string): CodeModule | undefined => MODULES[name] ?? pluginModule(name);

// MCP tools are named after their integration: deepwiki.ask_question.
const mcpToolId = (integration: McpIntegration, name: string) => `${integration.id}.${name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
// A discovered tool's tier: the definition's override, else T0 when the server
// marks it read-only or its name plainly reads (get_, list_, search_...), else
// T2 - an unknown action waits for a person until someone decides otherwise.
const READS = /^(read|get|list|search|fetch|find|query|lookup|look_up|describe|ask|view|show|count)(_|$)/i;
const mcpTier = (integration: McpIntegration, t: McpTool): Tier => integration.tiers?.[t.name] ?? (t.readOnly || READS.test(t.name) ? 'T0' : 'T2');

type Provider = { integration: Integration; call: (args: Record<string, unknown>) => Promise<string> };

// Every tool any integration offers, with who can serve it. For agents, one
// being redrafted is its live version; for the engineer testing, the draft.
function providers(forAgents = false): Map<string, { def: Omit<ToolDef, 'impl'>; by: Provider[] }> {
  const out = new Map<string, { def: Omit<ToolDef, 'impl'>; by: Provider[] }>();
  const add = (id: string, def: Omit<ToolDef, 'impl'>, p: Provider) => {
    const entry = out.get(id) ?? { def, by: [] };
    entry.by.push(p);
    out.set(id, entry);
  };
  for (const { integration: drafted } of loaded) {
    const integration = (forAgents && liveCopies.get(drafted.id)) || drafted;
    if (integration.kind === 'http') {
      for (const tool of integration.tools)
        add(tool.id, { id: tool.id, tier: tool.tier, description: tool.description, schema: tool.input }, {
          integration,
          call: async args => callHttp(integration, tool, args, await keyOf(integration.id)),
        });
    } else if (integration.kind === 'code') {
      for (const tool of moduleOf(integration.module)?.tools ?? [])
        add(tool.id, { id: tool.id, tier: tool.tier, description: tool.description, schema: tool.input }, {
          integration,
          call: async args => tool.run(args, await keyOf(integration.id), KIT),
        });
    } else {
      for (const t of states()[integration.id]?.tools ?? []) {
        const id = mcpToolId(integration, t.name);
        add(id, { id, tier: mcpTier(integration, t), description: t.description.slice(0, 1000) || t.name, schema: t.inputSchema }, {
          integration,
          call: async args => callMcpTool(integration, await keyOf(integration.id), t.name, args),
        });
      }
    }
  }
  return out;
}

// Registers every integration tool with the runner. A tool is ready when an
// integration that provides it is live; the first live one serves it.
function register() {
  const defs: ToolDef[] = [];
  for (const [id, { def, by }] of providers(true))
    defs.push({
      ...def,
      ready: () => by.some(p => isLive(p.integration.id)),
      impl: args => {
        const p = by.find(p => isLive(p.integration.id));
        if (!p) throw new Error(`No integration that provides ${id} is connected. File a request for one.`);
        return p.call(args);
      },
    });
  registerTools(defs);
}

// --- Connecting ------------------------------------------------------------------

// Checks an integration works: HTTP runs its test call; MCP signs in and lists its tools.
async function test(integration: Integration): Promise<{ ok: boolean; message: string; tools?: McpTool[] }> {
  try {
    if (integration.kind === 'mcp') {
      const tools = await listMcpTools(integration, await keyOf(integration.id));
      return { ok: true, message: `${tools.length} tool${tools.length === 1 ? '' : 's'} found`, tools };
    }
    if (integration.kind === 'code') {
      const mod = moduleOf(integration.module);
      // A plugin's code doesn't run before it's approved: keep the key, test it then.
      if (!mod && states()[integration.id]?.draft) return { ok: true, message: 'Key saved. It is tested once its code is approved.' };
      if (!mod) throw new Error(`Its code ("${integration.module}") isn't loaded.`);
      const key = await keyOf(integration.id);
      if (integration.auth.type === 'oauth2' && !key) throw new Error('Not signed in yet.');
      const tool = mod.tools.find(t => t.id === integration.test.tool) ?? mod.tools[0];
      await tool.run(integration.test.args, key, KIT);
      const account = mod.account ? await mod.account(key) : '';
      if (account && integration.auth.type === 'oauth2') await setOAuthAccount(integration.id, account);
      return { ok: true, message: account ? `Connected as ${account}` : 'Connected and working' };
    }
    const tool = integration.tools.find(t => t.id === integration.test.tool) ?? integration.tools[0];
    const out = await callHttp(integration, tool, integration.test.args, await keyOf(integration.id));
    return { ok: true, message: out === 'No results.' ? 'Connected (the test search found nothing)' : 'Connected and working' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function connectIntegration(id: string, key?: string) {
  const integration = find(id);
  if (!integration) throw new Error('Unknown integration.');
  if (integration.auth.type === 'oauth2' || integration.auth.type === 'mcp_oauth') {
    if (!(await oauthSecret(id))?.accessToken) throw new Error('Sign in first.');
  } else if (integration.auth.type !== 'none') {
    const k = key?.trim().replace(/^bearer\s+/i, '');
    if (k) await setSecret(secretKey(id), { key: k });
    else if (!(await keyOf(id))) throw new Error('Paste the key first.');
  }
  const result = await test(integration);
  const prev = states()[id] ?? {};
  putState(id, {
    ...prev,
    connectedAt: result.ok ? Date.now() : undefined,
    test: { ok: result.ok, at: Date.now(), message: result.message },
    tools: result.tools ?? prev.tools,
  });
  register();
  if (!result.ok) throw new Error(result.message);
  // A draft the Agency Engineer is waiting on: wake it to test the real thing.
  const st = states()[id];
  if (st?.draft) onDraftConnected?.(id, st.request);
  return result;
}

// Connections nobody has checked in a day are checked again in the background
// (when Settings is opened). A failure shows on the row but doesn't disconnect
// it: a service being down for a minute shouldn't cost the person their key.
const RECHECK_MS = 24 * 3_600_000;
let rechecking = false;
export function recheckStale(now = Date.now()) {
  if (rechecking) return;
  const stale = loaded.filter(({ integration: i }) => isConnected(i.id) && now - (states()[i.id]?.test?.at ?? 0) > RECHECK_MS);
  if (!stale.length) return;
  rechecking = true;
  void (async () => {
    for (const { integration } of stale) {
      const r = await test(integration);
      putState(integration.id, { ...states()[integration.id], test: { ok: r.ok, at: Date.now(), message: r.message }, tools: r.tools ?? states()[integration.id]?.tools });
    }
    register();
  })().finally(() => (rechecking = false));
}

let onDraftConnected: ((id: string, request?: number) => void) | null = null;
export const whenDraftConnected = (fn: (id: string, request?: number) => void) => void (onDraftConnected = fn);

// Signing in (OAuth): the person's OAuth client in, the service's sign-in page out.
export async function startIntegrationSignIn(id: string, client: { clientId?: string; clientSecret?: string }) {
  const integration = find(id);
  // An MCP server's own sign-in: found and registered with here (mcp-auth.ts).
  if (integration?.kind === 'mcp' && integration.auth.type === 'mcp_oauth' && integration.url) {
    const prev = await oauthSecret(id);
    const found = prev?.discovered && prev.clientId ? { auth: prev.discovered, clientId: prev.clientId, clientSecret: prev.clientSecret } : await discoverMcpSignIn(integration.url, integration.name);
    return { url: await oauthStart(id, found.auth, { clientId: found.clientId, clientSecret: found.clientSecret }, { discovered: found.auth }) };
  }
  if (integration?.auth.type !== 'oauth2') throw new Error("That integration doesn't sign in.");
  return { url: await oauthStart(id, integration.auth, client) };
}

// The sign-in landed: test it straight away, so it's live only if it works.
export async function finishIntegrationSignIn(q: URLSearchParams) {
  const id = await oauthCallback(q);
  return connectIntegration(id);
}

export async function disconnectIntegration(id: string) {
  stopStdioServer(id);
  const auth = find(id)?.auth;
  const found = auth?.type === 'mcp_oauth' ? (await oauthSecret(id))?.discovered : undefined;
  if (auth?.type === 'oauth2') await oauthSignOut(id, auth);
  else if (found) await oauthSignOut(id, found);
  else await deleteSecret(secretKey(id));
  // Signed out; whether it's a draft, and whose, stays.
  const { draft, by, request, codeHash: hash } = states()[id] ?? {};
  putState(id, draft || by || hash ? { draft, by, request, codeHash: hash } : null);
  register();
}

// --- Adding ----------------------------------------------------------------------

// Saves a new integration's definition (YAML or JSON text, or an object).
export async function addIntegration(definition: unknown): Promise<Integration> {
  const raw = typeof definition === 'string' ? parse(definition) : definition;
  const integration = Integration.parse(raw);
  if (loaded.some(l => l.shipped && l.integration.id === integration.id)) throw new Error(`"${integration.id}" is a built-in integration's id; pick another.`);
  await mkdir(ADDED, { recursive: true });
  await writeFile(join(ADDED, `${integration.id}.yaml`), stringify(integration));
  await loadIntegrations();
  return integration;
}

export async function removeIntegration(id: string) {
  const l = loaded.find(x => x.integration.id === id);
  if (!l) return;
  if (l.shipped) throw new Error("Built-in integrations can't be removed; disconnect it instead.");
  await disconnectIntegration(id);
  await deleteSecret(secretKey(id));
  await deleteSecret(hookSecretKey(id));
  await rm(join(ADDED, `${id}.yaml`), { force: true });
  await loadIntegrations();
}

// --- For the app and the builder ---------------------------------------------------

export async function listIntegrations() {
  const st = states();
  // A draft whose go-live is waiting on a person: its approval, to go straight to.
  const waiting = new Map(
    all<{ id: string; integration: string }>(
      "SELECT id, json_extract(args, '$.integration_id') AS integration FROM approvals WHERE status = 'pending' AND tool = 'engineer.publish_integration' AND expires_at > ?",
      Date.now(),
    ).map(a => [a.integration, a.id]),
  );
  // Which have a webhook signing secret saved (events whose posts are signed).
  const secrets = new Set<string>();
  for (const { integration } of loaded) if (await webhookSecret(integration.id)) secrets.add(integration.id);
  // Which signed-in integrations already have the person's OAuth client saved.
  const clients = new Set<string>();
  for (const { integration } of loaded) if (integration.auth.type === 'oauth2' && (await oauthSecret(integration.id))?.clientId) clients.add(integration.id);
  return loaded.map(({ integration, shipped }) => ({
    id: integration.id,
    name: integration.name,
    what: integration.what,
    kind: integration.kind,
    keyUrl: integration.key_url,
    keyHelp: integration.key_help ?? null,
    needsKey: integration.auth.type !== 'none' && integration.auth.type !== 'oauth2' && integration.auth.type !== 'mcp_oauth',
    // An MCP server's sign-in needs no client from the person (it registers itself).
    signIn:
      integration.auth.type === 'oauth2'
        ? { clientUrl: integration.auth.client_url ?? null, help: integration.auth.client_help ?? null, hasClient: clients.has(integration.id) }
        : integration.auth.type === 'mcp_oauth'
          ? { clientUrl: null, help: null, hasClient: true }
          : null,
    shipped,
    connected: !!st[integration.id]?.connectedAt,
    draft: !!st[integration.id]?.draft,
    approvalId: waiting.get(integration.id) ?? null,
    by: st[integration.id]?.by ?? null,
    test: st[integration.id]?.test ?? null,
    tools:
      integration.kind === 'http'
        ? integration.tools.map(t => ({ id: t.id, tier: t.tier }))
        : integration.kind === 'code'
          ? (moduleOf(integration.module)?.tools ?? []).map(t => ({ id: t.id, tier: t.tier }))
          : (st[integration.id]?.tools ?? []).map(t => ({ id: mcpToolId(integration, t.name), tier: mcpTier(integration, t) })),
    // Its events (docs/events.md): how each is detected, and whether its webhook posts are signed.
    events: (integration.events ?? []).map(e => ({
      id: e.id,
      description: e.description,
      poll: e.poll ? e.poll.every_minutes : null,
      webhook: !!e.webhook,
      signed: !!e.webhook?.signature,
      secretHelp: e.webhook?.secret_help ?? null,
      setupHelp: e.setup_help ?? null,
    })),
    webhookSecretSet: secrets.has(integration.id),
  }));
}

// --- Events (runner/events.ts) -------------------------------------------------------

export type EventSource = { integration: Integration; event: EventDefT; key: () => Promise<string | undefined> };

// Every event agents can subscribe to now: its integration is live (one being
// redrafted keeps its live version's events meanwhile).
export function liveEvents(): EventSource[] {
  const out: EventSource[] = [];
  for (const { integration: drafted } of loaded) {
    if (!isLive(drafted.id)) continue;
    const integration = liveCopies.get(drafted.id) ?? drafted;
    for (const event of integration.events ?? []) out.push({ integration, event, key: () => keyOf(integration.id) });
  }
  return out;
}

// One event as written, draft or live (the engineer checking it).
export function anyEvent(integrationId: string, eventId: string): EventSource | null {
  const integration = find(integrationId);
  const event = integration?.events?.find(e => e.id === eventId);
  return integration && event ? { integration, event, key: () => keyOf(integration.id) } : null;
}

export const liveEventIds = () => liveEvents().map(e => e.event.id);

// Every event written, draft or live (Settings shows a draft's webhook address,
// so the person can set it up before it goes live).
export function everyEvent(): (EventSource & { live: boolean })[] {
  const live = new Set(liveEvents().map(e => e.event.id));
  const out = liveEvents().map(e => ({ ...e, live: true }));
  for (const { integration } of loaded)
    for (const event of integration.events ?? []) if (!live.has(event.id) && !out.some(o => o.event.id === event.id)) out.push({ integration, event, key: () => keyOf(integration.id), live: false });
  return out;
}

// The signing secret for an integration's webhook posts, which the person pastes in Settings.
const hookSecretKey = (id: string) => `integration-webhook:${id}`;
export const webhookSecret = async (id: string) => (await getSecret<{ secret: string }>(hookSecretKey(id)))?.secret;
export async function setWebhookSecret(id: string, secret: string) {
  if (!find(id)) throw new Error('Unknown integration.');
  if (secret.trim()) await setSecret(hookSecretKey(id), { secret: secret.trim() });
  else await deleteSecret(hookSecretKey(id));
}

export const integrationProblems = () => problems;

// The ids of tools a connected integration provides, which a build may use.
export function integrationToolIds(): string[] {
  return [...providers(true)].filter(([, { by }]) => by.some(p => isLive(p.integration.id))).map(([id]) => id);
}

// Tools from connected integrations, for the builder's catalogue.
// Events from live integrations, for the builder's catalogue.
export function integrationEventsForPrompt(): string {
  return liveEvents()
    .map(({ integration, event }) => `- ${event.id}: ${event.description} (via ${integration.name}${event.webhook ? ', instantly' : `, checked every ${event.poll?.every_minutes} minutes`})`)
    .join('\n');
}

export function integrationToolsForPrompt(): string {
  const lines: string[] = [];
  for (const [id, { def, by }] of providers(true)) {
    const connected = by.filter(p => isLive(p.integration.id)).map(p => p.integration.name);
    if (connected.length) lines.push(`- ${id} [${def.tier}] ${def.description.split('\n')[0].slice(0, 160)} (via ${connected.join(', ')})`);
  }
  return lines.join('\n');
}

export type { HttpIntegration, McpIntegration };

// --- The Agency Engineer's side (runner/engineer.ts) -----------------------------------

// Saves a definition the engineer wrote, as a draft: it shows in Settings to be
// connected, but no agent can call it until a person approves it going live.
// asPerson: written for the person (from their IDE): any added integration may
// be redrafted, and it stays whoever's it was.
export async function writeDraftIntegration(definition: string, by: string, request?: number, asPerson = false): Promise<{ integration: Integration; wasLive: boolean }> {
  let raw: unknown;
  try {
    raw = parse(definition);
  } catch (e) {
    throw new Error(`That isn't valid YAML: ${(e as Error).message.slice(0, 300)}`);
  }
  const checked = Integration.safeParse(raw);
  if (!checked.success)
    throw new Error(`The definition doesn't fit the format: ${checked.error.issues.slice(0, 6).map(i => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ')}`);
  const integration = checked.data;
  // Programs on this computer, or local addresses, are a person's call alone.
  if (integration.kind === 'mcp' && (integration.command || integration.local))
    throw new Error("MCP servers on this computer (a command, or a local address) can only be added by a person, in Settings -> Connectors. Tell them which one and how, with engineer.reply_to_request.");
  if (integration.kind === 'mcp' && !integration.url) throw new Error('An MCP server needs its address (url).');
  const existing = loaded.find(l => l.integration.id === integration.id);
  if (existing?.shipped) throw new Error(`"${integration.id}" is a built-in integration's id; pick another.`);
  const prev = states()[integration.id];
  if (existing && prev?.by !== by && !asPerson) throw new Error(`"${integration.id}" was added by a person; pick another id.`);
  if (asPerson) by = prev?.by ?? by;
  await mkdir(LIVE, { recursive: true });
  // Redrafting a live one: its live definition is kept, in case the draft is turned down.
  const wasLiveNow = !!existing && !prev?.draft;
  if (wasLiveNow) await writeFile(join(LIVE, `${integration.id}.yaml`), stringify(existing.integration));
  await writeFile(join(ADDED, `${integration.id}.yaml`), stringify(integration));
  putState(integration.id, {
    ...prev,
    draft: true,
    by,
    request: request ?? prev?.request,
    codeHash: undefined,
    published: prev?.published || wasLiveNow,
    liveHash: wasLiveNow ? prev?.codeHash : prev?.liveHash,
  });
  await loadIntegrations();
  return { integration, wasLive: !!existing && !prev?.draft };
}

// A draft nobody wants - its request or its go-live was turned down: gone from
// Settings with its key and plugin code. One that has been live goes back to
// its live version instead, as it was before the redraft.
export async function discardDraft(id: string): Promise<boolean> {
  const st = states()[id];
  if (!st?.draft) return false;
  if (st.published) {
    const yaml = await readFile(join(LIVE, `${id}.yaml`), 'utf8').catch(() => null);
    if (yaml == null) return false;
    await writeFile(join(ADDED, `${id}.yaml`), yaml);
    await rm(join(LIVE, `${id}.yaml`), { force: true });
    const live = Integration.parse(parse(yaml));
    if (live.kind === 'code' && !MODULES[live.module]) await restorePlugin(live.module);
    putState(id, { ...st, draft: false, codeHash: st.liveHash, liveHash: undefined });
    await loadIntegrations();
    return true;
  }
  const integration = find(id);
  await removeIntegration(id);
  if (integration?.kind === 'code' && !MODULES[integration.module]) await removePlugin(integration.module);
  putState(id, null);
  return true;
}

export const draftsForRequest = (request: number) =>
  Object.entries(states())
    .filter(([, s]) => s.draft && s.request === request)
    .map(([id]) => id);

export async function integrationSource(id: string): Promise<{ yaml: string; code: string | null } | null> {
  const l = loaded.find(x => x.integration.id === id);
  if (!l) return null;
  const yaml = await readFile(join(l.shipped ? SHIPPED : ADDED, `${id}.yaml`), 'utf8').catch(() => stringify(l.integration));
  const code = l.integration.kind === 'code' && !MODULES[l.integration.module] ? await readPlugin(l.integration.module) : null;
  return { yaml, code };
}

const toolsOf = (id: string) => [...providers()].filter(([, e]) => e.by.some(x => x.integration.id === id));

// One tool of one integration, draft or live, called directly (the engineer testing).
export async function testIntegrationTool(id: string, toolId: string, args: Record<string, unknown>): Promise<string> {
  const integration = find(id);
  if (!integration) throw new Error(`No integration "${id}".`);
  if (integration.auth.type !== 'none' && !isConnected(id))
    throw new Error(`${integration.name} isn't connected yet: ask the person to add its key (engineer.ask_for_connection).`);
  // A redrafted plugin's loaded code is still the live version: the draft can't be tried.
  if (integration.kind === 'code' && (!moduleOf(integration.module) || (liveCopies.has(id) && !MODULES[integration.module])))
    throw new Error("A code plugin's code runs only after a person approves it. Propose it with engineer.publish_integration; it's tested as it goes live.");
  const p = providers().get(toolId)?.by.find(x => x.integration.id === id);
  if (!p) throw new Error(`${integration.name} has no tool "${toolId}". Its tools: ${toolsOf(id).map(([t]) => t).join(', ') || 'none found yet'}.`);
  return p.call(args);
}

// Where an integration sends its key: its base_url or server, or the https
// hosts a code plugin's source names.
async function keyHosts(integration: Integration): Promise<Set<string>> {
  if (integration.kind === 'http') return new Set([new URL(integration.base_url).host]);
  if (integration.kind === 'mcp') return new Set(integration.url ? [new URL(integration.url).host] : []);
  const code = MODULES[integration.module]
    ? await readFile(join(HERE, 'modules', `${integration.module}.ts`), 'utf8').catch(() => '')
    : (await readPlugin(integration.module)) ?? '';
  return new Set([...code.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map(m => m[1].toLowerCase()));
}

// One request with an integration's stored key, sent the way the integration
// sends it (the engineer separating "the key is refused" from "the tool is
// wrong"). Only to the integration's own hosts, no redirects; reads, or a POST
// or PATCH with an empty body, which an API rejects as invalid rather than acting on.
// The key is never shown.
export async function checkKey(id: string, method: string, url: string): Promise<string> {
  const integration = find(id);
  if (!integration) throw new Error(`No integration "${id}".`);
  if (integration.auth.type === 'none') throw new Error(`${integration.name} takes no key.`);
  const key = await keyOf(id);
  if (!key) throw new Error(`${integration.name} has no key stored: it isn't connected.`);
  const m = method.toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PATCH'].includes(m)) throw new Error('Method must be GET, HEAD, POST or PATCH.');
  const target = new URL(url);
  const hosts = await keyHosts(integration);
  if (target.protocol !== 'https:' || !hosts.has(target.host))
    throw new Error(`The key only goes where ${integration.name} sends it: https://${[...hosts].join(', https://') || '(nowhere found)'}.`);
  const { headers, query } = authParts(integration.auth, key);
  for (const [k, v] of Object.entries(query)) target.searchParams.set(k, v);
  const write = m !== 'GET' && m !== 'HEAD';
  const { res } = await safeFetch(target.toString(), {
    method: m,
    headers: { accept: 'application/json', 'user-agent': 'eaa-agency-engineer', ...(write ? { 'content-type': 'application/json' } : {}), ...headers },
    body: write ? '{}' : undefined,
    maxRedirects: 0,
  });
  const body = (await res.text()).split(key).join('[key]').replace(/\s+/g, ' ').slice(0, 1500);
  const hints = [...res.headers].filter(([k]) => /scope|permission|www-authenticate|accepted/i.test(k)).map(([k, v]) => `${k}: ${v}`);
  for (const k of Object.keys(query)) target.searchParams.set(k, '[key]');
  return [`${m} ${target} -> HTTP ${res.status}`, ...hints, body].filter(Boolean).join('\n');
}

// What a person approves when a draft goes live: the definition, and a plugin's code.
export async function publishPreview(id: string) {
  const integration = find(id);
  if (!integration) throw new Error(`No integration "${id}".`);
  const src = await integrationSource(id);
  const plugin = integration.kind === 'code' && !!src?.code;
  return {
    name: integration.name,
    kind: integration.kind,
    yaml: src?.yaml ?? '',
    code: src?.code ?? null,
    codeHash: src?.code ? codeHash(src.code) : null,
    permissions: plugin && integration.kind === 'code' ? resolvePermissions(integration.permissions) : null,
  };
}

// Makes a draft live. A plugin is loaded only if its code is what was approved.
export async function publishIntegration(id: string, approvedHash: string | null): Promise<{ tools: { id: string; tier: Tier }[]; test: string | null }> {
  const integration = find(id);
  if (!integration) throw new Error(`No integration "${id}".`);
  if (integration.kind === 'code' && !MODULES[integration.module]) {
    if (!approvedHash) throw new Error('Approve its code first.');
    await installPlugin(integration.module, approvedHash, resolvePermissions(integration.permissions));
    putState(id, { ...states()[id], codeHash: approvedHash });
  }
  putState(id, { ...states()[id], draft: false, published: true, liveHash: undefined });
  // The new version is the live one now.
  await rm(join(LIVE, `${id}.yaml`), { force: true });
  liveCopies.delete(id);
  if (integration.kind === 'code') await dropPluginBackup(integration.module);
  // Tested now that it can run (a plugin's first run is after approval).
  let test: string | null = null;
  if (integration.auth.type === 'none' || isConnected(id)) {
    const r = await connectIntegration(id).catch(e => ({ ok: false, message: (e as Error).message }));
    test = r.message;
  }
  register();
  return { tools: toolsOf(id).map(([t, e]) => ({ id: t, tier: e.def.tier })), test };
}

// A request's draft integrations (to link a go-live to the request it answers).
export const draftsFor = (request: number) => Object.entries(states()).filter(([, st]) => st.draft && st.request === request).map(([id]) => id);
