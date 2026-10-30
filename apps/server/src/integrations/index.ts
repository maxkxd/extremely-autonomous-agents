import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import type { Tier } from '../catalog.js';
import { all, getSetting, setSetting } from '../runner/db.js';
import { registerTools, type ToolDef, unregisterTools } from '../runner/tools.js';
import { deleteSecret, getSecret, setSecret } from '../vault.js';
import { authParts, callHttp, at, baseFor, errorText, putFields, redact } from './http.js';
import { callMcpTool, listMcpTools, type McpTool } from './mcp-client.js';
import { MODULES, type CodeModule } from './modules/index.js';
import { codeHash, dropPluginBackup, installPlugin, pluginModule, readPlugin, readPluginBackup, removePlugin, restorePlugin, tryDraftTool } from './plugins.js';
import { resolvePermissions } from './sandbox.js';
import { safeFetch } from '../runner/net.js';
import type { Kit } from './modules/types.js';

// What a code tool gets besides its inputs: the safe fetcher, its only way out.
const KIT: Kit = { fetch: async (url, init) => (await safeFetch(url, init)).res as unknown as Response };
import { discoverMcpSignIn } from './mcp-auth.js';
import { stopStdioServer } from './mcp-stdio.js';
import { oauthAccessToken, oauthCallback, oauthSecret, oauthSignOut, oauthStart, setOAuthAccount, OAUTH_REDIRECT } from './oauth.js';
import { Integration, type EventDefT, type HttpIntegration, type McpIntegration, type AuthDef } from './schema.js';
import { DATA_DIR } from '../paths.js';

// Integrations (docs/integrations.md): the ones that ship with the app
// (apps/server/integrations/*.yaml) and the ones added later - by a person,
// or by the Agency Engineer behind a person's approval (data/integrations/).
// Keys live in the vault; whether each is connected, its last test, and an
// MCP server's discovered tools live in the runner's store.

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED = join(HERE, '..', '..', 'integrations');
const ADDED = join(DATA_DIR, 'integrations');
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
// A fields sign-in's fields, with its defaults, and the token they're swapped
// for when it has one (kept until it expires).
type FieldsAuth = Extract<AuthDef, { type: 'fields' }>;
// Kept in the vault too, so a restart doesn't renew it (Zoho allows 10 renewals in
// 10 minutes, and a morning of restarts used them up), and one renewal is shared
// by calls that arrive together.
const tokens = new Map<string, { token: string; until: number }>();
const renewing = new Map<string, Promise<{ token: string; until: number }>>();
const tokenKey = (id: string) => `integration-token:${id}`;
async function keptToken(id: string, cacheKey: string) {
  const had = tokens.get(cacheKey) ?? (await getSecret<Record<string, { token: string; until: number }>>(tokenKey(id)))?.[cacheKey];
  if (!had || had.until <= Date.now()) return null;
  tokens.set(cacheKey, had);
  return had;
}
async function keepToken(id: string, cacheKey: string, t: { token: string; until: number }) {
  tokens.set(cacheKey, t);
  const all = (await getSecret<Record<string, { token: string; until: number }>>(tokenKey(id))) ?? {};
  for (const [k, v] of Object.entries(all)) if (v.until <= Date.now()) delete all[k];
  await setSecret(tokenKey(id), { ...all, [cacheKey]: t });
}
async function fieldsOf(id: string, auth: FieldsAuth): Promise<Record<string, string> | undefined> {
  const saved = (await getSecret<{ fields: Record<string, string> }>(secretKey(id)))?.fields;
  if (!saved) return undefined;
  const creds: Record<string, string> = {};
  for (const f of auth.fields) if (saved[f.name] ?? f.default) creds[f.name] = saved[f.name] ?? f.default!;
  if (!auth.token) return creds;
  const cacheKey = `${id} ${putFields(auth.token.url, creds)}`;
  const had = await keptToken(id, cacheKey);
  if (had) return { ...creds, token: had.token };
  let pending = renewing.get(cacheKey);
  if (!pending) {
    pending = renewToken(id, auth, creds, cacheKey).finally(() => renewing.delete(cacheKey));
    renewing.set(cacheKey, pending);
  }
  return { ...creds, token: (await pending).token };
}

async function renewToken(id: string, auth: FieldsAuth, creds: Record<string, string>, cacheKey: string): Promise<{ token: string; until: number }> {
  if (!auth.token) throw new Error('No token exchange.');
  const url = putFields(auth.token.url, creds);
  if (!url.startsWith('https://')) throw new Error('Its token address must be https.');
  const form = auth.token.form ? new URLSearchParams(Object.entries(auth.token.form).map(([k, v]) => [k, putFields(v, creds)])).toString() : undefined;
  const json = auth.token.json ? JSON.stringify(Object.fromEntries(Object.entries(auth.token.json).map(([k, v]) => [k, putFields(v, creds)]))) : undefined;
  const { res } = await safeFetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' },
    body: form ?? json,
  } as never);
  const text = redact(await res.text(), auth, JSON.stringify(creds));
  let answer: unknown = null;
  try {
    answer = JSON.parse(text);
  } catch {
    // not JSON
  }
  const token = at(answer, auth.token.pick);
  if (!res.ok || typeof token !== 'string' || !token) throw new Error(`Getting a token from ${new URL(url).host} failed (${res.status}): ${errorText(text).slice(0, 200)}`);
  const life = Number(auth.token.expires_in ? at(answer, auth.token.expires_in) : NaN);
  const kept = { token, until: Date.now() + (Number.isFinite(life) && life > 120 ? life - 60 : 3000) * 1000 };
  await keepToken(id, cacheKey, kept);
  return kept;
}

// The key, or for a signed-in (OAuth) integration its current access token;
// for a fields sign-in, its fields (and token) as JSON.
// With the definition doing the calling: a live version while its redraft waits
// reads its own fields (the draft may have dropped one, like a region).
const keyOf = async (id: string, def?: Integration): Promise<string | undefined> => {
  const d = def ?? find(id);
  const parent = d && keyFrom(d);
  if (parent) return keyOf(parent);
  const auth = d?.auth;
  if (auth?.type === 'fields') {
    const c = await fieldsOf(id, auth);
    return c ? JSON.stringify(c) : undefined;
  }
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
// The connection an extension uses the key of (key_from), if it is one.
const keyFrom = (i: Integration) => (i.kind === 'http' || i.kind === 'code' ? i.key_from : undefined);
const isConnected = (id: string): boolean => {
  const d = find(id);
  const parent = d && keyFrom(d);
  return parent ? isConnected(parent) : !!states()[id]?.connectedAt;
};
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
          call: async args => callHttp(integration, tool, args, await keyOf(integration.id, integration)),
        });
    } else if (integration.kind === 'code') {
      for (const tool of moduleOf(integration.module)?.tools ?? [])
        add(tool.id, { id: tool.id, tier: tool.tier, description: tool.description, schema: tool.input }, {
          integration,
          call: async args => tool.run(args, await keyOf(integration.id, integration), KIT),
        });
    } else {
      for (const t of states()[integration.id]?.tools ?? []) {
        const id = mcpToolId(integration, t.name);
        add(id, { id, tier: mcpTier(integration, t), description: t.description.slice(0, 1000) || t.name, schema: t.inputSchema }, {
          integration,
          call: async args => callMcpTool(integration, await keyOf(integration.id, integration), t.name, args),
        });
      }
    }
  }
  return out;
}

// Registers every integration tool with the runner. A tool is ready when an
// integration that provides it is live; the first live one serves it.
let registered: ToolDef[] = [];
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
  const now = new Set(defs.map(d => d.id));
  unregisterTools(registered.filter(d => !now.has(d.id)));
  registerTools(defs);
  registered = defs;
}

// --- Connecting ------------------------------------------------------------------

// Checks an integration works: HTTP runs its test call; MCP signs in and lists its tools.
async function test(integration: Integration): Promise<{ ok: boolean; message: string; tools?: McpTool[] }> {
  try {
    if (integration.kind === 'mcp') {
      const tools = await listMcpTools(integration, await keyOf(integration.id, integration));
      return { ok: true, message: `${tools.length} tool${tools.length === 1 ? '' : 's'} found`, tools };
    }
    if (integration.kind === 'code') {
      const mod = moduleOf(integration.module);
      // A plugin's code doesn't run before it's approved: keep the key, test it then.
      if (!mod && states()[integration.id]?.draft) return { ok: true, message: 'Key saved. It is tested once its code is approved.' };
      if (!mod) throw new Error(`Its code ("${integration.module}") isn't loaded.`);
      const key = await keyOf(integration.id, integration);
      if (integration.auth.type === 'oauth2' && !key) throw new Error('Not signed in yet.');
      const tool = mod.tools.find(t => t.id === integration.test.tool) ?? mod.tools[0];
      await tool.run(integration.test.args, key, KIT);
      const account = mod.account ? await mod.account(key) : '';
      if (account && integration.auth.type === 'oauth2') await setOAuthAccount(integration.id, account);
      return { ok: true, message: account ? `Connected as ${account}` : 'Connected and working' };
    }
    const tool = integration.tools.find(t => t.id === integration.test.tool) ?? integration.tools[0];
    const out = await callHttp(integration, tool, integration.test.args, await keyOf(integration.id, integration));
    return { ok: true, message: out === 'No results.' ? 'Connected (the test search found nothing)' : 'Connected and working' };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function connectIntegration(id: string, key?: string, fields?: Record<string, unknown>) {
  const integration = find(id);
  if (!integration) throw new Error('Unknown integration.');
  const parent = keyFrom(integration);
  if (parent) {
    // An extension has nothing of its own to enter: it works once its parent is connected.
    if (!isConnected(parent)) throw new Error(`Connect ${find(parent)?.name ?? parent} first - this uses its connection.`);
  } else if (integration.auth.type === 'fields') {
    const auth = integration.auth;
    if (fields) {
      const had = (await getSecret<{ fields: Record<string, string> }>(secretKey(id)))?.fields ?? {};
      const next: Record<string, string> = {};
      for (const f of auth.fields) {
        // A secret left blank keeps the one saved (it's never shown back to fill in).
        const v = typeof fields[f.name] === 'string' ? (fields[f.name] as string).trim() : '';
        if (v && f.options && !f.options.includes(v)) throw new Error(`${f.label} must be one of: ${f.options.join(', ')}.`);
        if (v) next[f.name] = v;
        else if (had[f.name]) next[f.name] = had[f.name];
        else if (!f.optional && f.default === undefined) throw new Error(`Fill in ${f.label}.`);
      }
      await setSecret(secretKey(id), { fields: next });
      for (const k of tokens.keys()) if (k.startsWith(`${id} `)) tokens.delete(k);
      await deleteSecret(tokenKey(id));
    } else if (!(await getSecret(secretKey(id)))) throw new Error('Fill in the fields first.');
  } else if (integration.auth.type === 'oauth2' || integration.auth.type === 'mcp_oauth') {
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
  else onConnected?.(id);
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
// A live one (a built-in like GitHub) connected: requests waiting on it are settled.
let onConnected: ((id: string) => void) | null = null;
export const whenConnected = (fn: (id: string) => void) => void (onConnected = fn);
export const toolIdsOf = (id: string) => toolsOf(id).map(([t]) => t);

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
  // A fields sign-in's saved fields (secrets only as saved-or-not).
  const savedFields = new Map<string, Record<string, string>>();
  for (const { integration } of loaded)
    if (integration.auth.type === 'fields') savedFields.set(integration.id, (await getSecret<{ fields: Record<string, string> }>(secretKey(integration.id)))?.fields ?? {});
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
    needsKey: !keyFrom(integration) && integration.auth.type !== 'none' && integration.auth.type !== 'oauth2' && integration.auth.type !== 'mcp_oauth' && integration.auth.type !== 'fields',
    // A fields sign-in: what to ask for. Saved secrets are never sent back; non-secret ones are, to edit.
    fields:
      integration.auth.type === 'fields' && !keyFrom(integration)
        ? integration.auth.fields.map(f => {
            const saved = savedFields.get(integration.id) ?? {};
            return { name: f.name, label: f.label, help: f.help ?? null, secret: f.secret, options: f.options ?? null, optional: !!f.optional || f.default !== undefined, saved: !!saved[f.name], value: f.secret ? null : (saved[f.name] ?? f.default ?? '') };
          })
        : null,
    // An MCP server's sign-in needs no client from the person (it registers itself).
    signIn: keyFrom(integration)
      ? null
      : integration.auth.type === 'oauth2'
        ? { clientUrl: integration.auth.client_url ?? null, help: integration.auth.client_help ?? null, hasClient: clients.has(integration.id), redirect: OAUTH_REDIRECT }
        : integration.auth.type === 'mcp_oauth'
          ? { clientUrl: null, help: null, hasClient: true, redirect: null }
          : null,
    shipped,
    connected: isConnected(integration.id),
    // An extension: connected through this one, nothing to enter.
    keyFrom: keyFrom(integration) ? { id: keyFrom(integration)!, name: find(keyFrom(integration)!)?.name ?? keyFrom(integration)! } : null,
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
    for (const event of integration.events ?? []) out.push({ integration, event, key: () => keyOf(integration.id, integration) });
  }
  return out;
}

// One event as written, draft or live (the engineer checking it).
export function anyEvent(integrationId: string, eventId: string): EventSource | null {
  const integration = find(integrationId);
  const event = integration?.events?.find(e => e.id === eventId);
  return integration && event ? { integration, event, key: () => keyOf(integration.id, integration) } : null;
}

export const liveEventIds = () => liveEvents().map(e => e.event.id);

// Every event written, draft or live (Settings shows a draft's webhook address,
// so the person can set it up before it goes live).
export function everyEvent(): (EventSource & { live: boolean })[] {
  const live = new Set(liveEvents().map(e => e.event.id));
  const out = liveEvents().map(e => ({ ...e, live: true }));
  for (const { integration } of loaded)
    for (const event of integration.events ?? []) if (!live.has(event.id) && !out.some(o => o.event.id === event.id)) out.push({ integration, event, key: () => keyOf(integration.id, integration), live: false });
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
// Each integration tool's description and the service it comes through (Settings > Tools).
export function integrationToolInfo(): Map<string, { description: string; via: string }> {
  const out = new Map<string, { description: string; via: string }>();
  for (const [id, { def, by }] of providers(true)) out.set(id, { description: def.description, via: by.map(p => p.integration.name).join(', ') });
  return out;
}

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
  // An extension uses another connection's key: that one must exist and not be an
  // extension itself, and its auth is the parent's (so the key is sent its way).
  const parentId = keyFrom(integration);
  if (parentId) {
    const parent = find(parentId);
    if (!parent || parentId === integration.id) throw new Error(`key_from "${parentId}" isn't a connection here (engineer.list_integrations).`);
    if (keyFrom(parent)) throw new Error(`"${parentId}" is itself an extension; use the connection it extends, "${keyFrom(parent)}".`);
    // A signed-in parent hands over its access token: sent as a bearer token.
    (integration as { auth: Integration['auth'] }).auth = parent.auth.type === 'oauth2' || parent.auth.type === 'mcp_oauth' ? { type: 'bearer' } : parent.auth;
  }
  // A field that picks the server (accounts.zoho.{{region}}) could send the keys anywhere
  // ("attacker.com"): it must be one of a fixed list.
  if (integration.kind === 'http' && integration.auth.type === 'fields') {
    const auth = integration.auth;
    for (const url of [integration.base_url, auth.token?.url ?? '']) {
      const host = /^https?:\/\/([^/?#]*)/.exec(url)?.[1] ?? '';
      for (const [, name] of host.matchAll(/\{\{(\w+)\}\}/g)) {
        const f = auth.fields.find(x => x.name === name);
        if (f && !f.options) throw new Error(`The field "${name}" is part of the address's host (${url}): give it options, the exact values it may take (a region: [com, eu, in, com.au, jp, ca]), so it can't point the keys at another server.`);
      }
    }
  }
  // Programs on this computer, or local addresses, are a person's call alone.
  if (integration.kind === 'mcp' && (integration.command || integration.local))
    throw new Error("MCP servers on this computer (a command, or a local address) can only be added by a person, in Settings -> Connectors. Tell them which one and how, with engineer.reply_to_request.");
  if (integration.kind === 'mcp' && !integration.url) throw new Error('An MCP server needs its address (url).');
  const existing = loaded.find(l => l.integration.id === integration.id);
  if (existing?.shipped) throw new Error(`"${integration.id}" is a built-in integration's id; pick another.`);
  const prev = states()[integration.id];
  // One a person added stays theirs (by), but the Agency Engineer may extend it: its change is
  // a draft a person approves, and the live version keeps working meanwhile.
  if (existing && prev?.by && prev.by !== by) by = prev.by;
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
  // A plugin not yet approved (or a redraft, whose loaded code is still the live
  // version): its silent tools can be tried, reads only, to its own service.
  if (integration.kind === 'code' && !MODULES[integration.module] && (!moduleOf(integration.module) || liveCopies.has(id)))
    return tryDraftTool(integration.module, resolvePermissions(integration.permissions), toolId, args, await keyOf(id, integration), (await targetsOf(integration)).hosts);
  const p = providers().get(toolId)?.by.find(x => x.integration.id === id);
  if (!p) throw new Error(`${integration.name} has no tool "${toolId}". Its tools: ${toolsOf(id).map(([t]) => t).join(', ') || 'none found yet'}.`);
  return p.call(args);
}

// Where an integration's key may go (engineer.check_key): the hosts it sends it
// to, and the endpoints its own tools write to. An http integration's come from
// its definition; a code one's from the addresses its code calls - quoted
// strings and template literals, not links in comments - with ${...} parts as
// wildcards. An empty-body write goes only to one of those endpoints: one the
// tool would write to anyway, never an endpoint that acts on a bare POST.
type WriteTarget = { method: string | null; pattern: RegExp; shown: string };
export type KeyTargets = { hosts: Set<string>; writes: WriteTarget[] };

const PLACEHOLDER = /\{\{[^}]+\}\}|\$\{[^}]+\}/g;
function endpoint(url: string, method: string | null): WriteTarget {
  const bare = url.split(/[?#]/)[0].replace(/\/+$/, '');
  const source = bare
    .split(PLACEHOLDER)
    .map(part => part.replace(/[.*+?^()|[\]\\{}$]/g, '\\$&'))
    .join('[^/]+');
  return { method, pattern: new RegExp(`^${source}/?$`), shown: `${method ?? 'POST/PATCH'} ${bare}` };
}

export function keyTargets(integration: Integration, code = '', baseUrl?: string): KeyTargets {
  if (integration.kind === 'http') {
    const base = (baseUrl ?? integration.base_url).replace(/\/+$/, '');
    const writes = integration.tools
      .filter(t => t.request.method === 'POST' || t.request.method === 'PATCH')
      .map(t => endpoint(base + (t.request.path.startsWith('/') ? t.request.path : `/${t.request.path}`), t.request.method));
    return { hosts: new Set([new URL(base).host]), writes };
  }
  if (integration.kind === 'mcp') return { hosts: new Set(integration.url ? [new URL(integration.url).host] : []), writes: [] };
  const urls = [...code.matchAll(/[`'"](https:\/\/[^`'"\s]+)[`'"]/g)].map(m => m[1]);
  const hosts = new Set(urls.map(u => /^https:\/\/([a-z0-9.-]+)/i.exec(u)?.[1]?.toLowerCase()).filter((h): h is string => !!h && h.includes('.') && !h.includes('$')));
  return { hosts, writes: urls.map(u => endpoint(u, null)) };
}

async function targetsOf(integration: Integration): Promise<KeyTargets> {
  if (integration.kind === 'http') return keyTargets(integration, '', baseFor(integration.base_url, integration.auth, await keyOf(integration.id, integration)));
  if (integration.kind !== 'code') return keyTargets(integration);
  const code = MODULES[integration.module]
    ? await readFile(join(HERE, 'modules', `${integration.module}.ts`), 'utf8').catch(() => '')
    : ((await readPlugin(integration.module)) ?? '');
  return keyTargets(integration, code);
}

// One request with an integration's stored key, sent the way the integration
// sends it (the engineer separating "the key is refused" from "the tool is
// wrong"). Only to the integration's own hosts, no redirects; reads anywhere
// there, and a POST or PATCH with an empty body only to an endpoint its own
// tools write to (keyTargets). The key is never shown.
export async function checkKey(id: string, method: string, url: string): Promise<string> {
  const integration = find(id);
  if (!integration) throw new Error(`No integration "${id}".`);
  if (integration.auth.type === 'none') throw new Error(`${integration.name} takes no key.`);
  const key = await keyOf(id);
  if (!key) throw new Error(`${integration.name} has no key stored: it isn't connected.`);
  const m = method.toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PATCH'].includes(m)) throw new Error('Method must be GET, HEAD, POST or PATCH.');
  const target = new URL(url);
  const { hosts, writes } = await targetsOf(integration);
  if (target.protocol !== 'https:' || !hosts.has(target.host))
    throw new Error(`The key only goes where ${integration.name} sends it: https://${[...hosts].join(', https://') || '(nowhere found)'}.`);
  const write = m !== 'GET' && m !== 'HEAD';
  // A bare POST can act (resolve, restart, send a test): only where its tools write anyway.
  const at = `${target.origin}${target.pathname}`;
  if (write && !writes.some(w => (w.method === null || w.method === m) && w.pattern.test(at)))
    throw new Error(
      `A ${m} only goes to an endpoint ${integration.name}'s own tools write to${writes.length ? `: ${writes.map(w => w.shown).join('; ')}` : ' - it has none, so check with a read'}.`,
    );
  const { headers, query } = authParts(integration.auth, key);
  for (const [k, v] of Object.entries(query)) target.searchParams.set(k, v);
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

// A connection's saved settings that aren't secret (a region, an account id), as
// the person entered them: the engineer guessed Zoho's Australian data centre
// for a key saved as "com", and two go-lives failed.
export async function savedSettings(id: string): Promise<Record<string, string>> {
  const defs = [find(id), liveCopies.get(id)].filter((d): d is Integration => !!d);
  const open = new Set(defs.flatMap(d => (d.auth.type === 'fields' ? d.auth.fields.filter(f => f.secret === false).map(f => f.name) : [])));
  if (!open.size) return {};
  const saved = (await getSecret<{ fields: Record<string, string> }>(secretKey(id)))?.fields ?? {};
  return Object.fromEntries(Object.entries(saved).filter(([k]) => open.has(k)));
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
    // An extension: the connection whose key it uses.
    usesKeyOf: keyFrom(integration) ? (find(keyFrom(integration)!)?.name ?? keyFrom(integration)!) : null,
  };
}

// Makes a draft live. A plugin is loaded only if its code is what was approved.
export async function publishIntegration(id: string, approvedHash: string | null): Promise<{ tools: { id: string; tier: Tier }[]; test: string | null; kept?: boolean }> {
  const integration = find(id);
  if (!integration) throw new Error(`No integration "${id}".`);
  const before = states()[id] ?? {};
  // A redraft of one that's working: tried first (a plugin's other tools can't be tried before
  // it's approved), and if it fails the working version stays live and the
  // redraft stays a draft - agents keep what they had.
  const replacing = !!before.draft && liveCopies.has(id) && isConnected(id);
  if (integration.kind === 'code' && !MODULES[integration.module]) {
    if (!approvedHash) throw new Error('Approve its code first.');
    await installPlugin(integration.module, approvedHash, resolvePermissions(integration.permissions));
    putState(id, { ...states()[id], codeHash: approvedHash });
  }
  if (replacing) {
    const r = await test(integration);
    if (!r.ok) {
      const live = liveCopies.get(id);
      if (integration.kind === 'code' && live?.kind === 'code' && live.module === integration.module) await restorePlugin(integration.module);
      putState(id, { ...states()[id], codeHash: before.codeHash });
      await loadIntegrations();
      return { tools: [], test: r.message, kept: true };
    }
  }
  putState(id, { ...states()[id], draft: false, published: true, liveHash: undefined });
  // The new version is the live one now.
  await rm(join(LIVE, `${id}.yaml`), { force: true });
  liveCopies.delete(id);
  if (integration.kind === 'code') await dropPluginBackup(integration.module);
  // Tested now that all of it can run (before approval only its silent tools could).
  let tested: string | null = null;
  if (integration.auth.type === 'none' || isConnected(id)) {
    const r = await connectIntegration(id).catch(e => ({ ok: false, message: (e as Error).message }));
    tested = r.message;
  }
  register();
  return { tools: toolsOf(id).map(([t, e]) => ({ id: t, tier: e.def.tier })), test: tested };
}

// A request's draft integrations (to link a go-live to the request it answers).
export const draftsFor = (request: number) => Object.entries(states()).filter(([, st]) => st.draft && st.request === request).map(([id]) => id);
