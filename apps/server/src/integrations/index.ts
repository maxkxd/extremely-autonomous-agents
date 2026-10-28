import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import type { Tier } from '../catalog.js';
import { getSetting, setSetting } from '../runner/db.js';
import { registerTools, type ToolDef } from '../runner/tools.js';
import { deleteSecret, getSecret, setSecret } from '../vault.js';
import { callHttp } from './http.js';
import { callMcpTool, listMcpTools, type McpTool } from './mcp-client.js';
import { MODULES } from './modules/index.js';
import { oauthAccessToken, oauthCallback, oauthSecret, oauthSignOut, oauthStart, setOAuthAccount } from './oauth.js';
import { Integration, type HttpIntegration, type McpIntegration } from './schema.js';

// Integrations (docs/integrations.md): the ones that ship with the app
// (apps/server/integrations/*.yaml) and the ones added later - by a person,
// or by the Fleet Engineer behind a person's approval (data/integrations/).
// Keys live in the vault; whether each is connected, its last test, and an
// MCP server's discovered tools live in the runner's store.

const HERE = dirname(fileURLToPath(import.meta.url));
const SHIPPED = join(HERE, '..', '..', 'integrations');
const ADDED = join(HERE, '..', '..', 'data', 'integrations');

type State = { connectedAt?: number; test?: { ok: boolean; at: number; message: string }; tools?: McpTool[] };
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

export async function loadIntegrations() {
  loaded = [];
  problems = [];
  await readDir(SHIPPED, true);
  await readDir(ADDED, false);
  register();
}

const find = (id: string) => loaded.find(l => l.integration.id === id)?.integration;
const isConnected = (id: string) => !!states()[id]?.connectedAt;

// MCP tools are named after their integration: deepwiki.ask_question.
const mcpToolId = (integration: McpIntegration, name: string) => `${integration.id}.${name.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
// A discovered tool's tier: the definition's override, else T0 when the server
// marks it read-only or its name plainly reads (get_, list_, search_...), else
// T2 - an unknown action waits for a person until someone decides otherwise.
const READS = /^(read|get|list|search|fetch|find|query|lookup|look_up|describe|ask|view|show|count)(_|$)/i;
const mcpTier = (integration: McpIntegration, t: McpTool): Tier => integration.tiers?.[t.name] ?? (t.readOnly || READS.test(t.name) ? 'T0' : 'T2');

type Provider = { integration: Integration; call: (args: Record<string, unknown>) => Promise<string> };

// Every tool any integration offers, with who can serve it.
function providers(): Map<string, { def: Omit<ToolDef, 'impl'>; by: Provider[] }> {
  const out = new Map<string, { def: Omit<ToolDef, 'impl'>; by: Provider[] }>();
  const add = (id: string, def: Omit<ToolDef, 'impl'>, p: Provider) => {
    const entry = out.get(id) ?? { def, by: [] };
    entry.by.push(p);
    out.set(id, entry);
  };
  for (const { integration } of loaded) {
    if (integration.kind === 'http') {
      for (const tool of integration.tools)
        add(tool.id, { id: tool.id, tier: tool.tier, description: tool.description, schema: tool.input }, {
          integration,
          call: async args => callHttp(integration, tool, args, await keyOf(integration.id)),
        });
    } else if (integration.kind === 'code') {
      for (const tool of MODULES[integration.module]?.tools ?? [])
        add(tool.id, { id: tool.id, tier: tool.tier, description: tool.description, schema: tool.input }, {
          integration,
          call: async args => tool.run(args, await keyOf(integration.id)),
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
// integration that provides it is connected; the first connected one serves it.
function register() {
  const defs: ToolDef[] = [];
  for (const [id, { def, by }] of providers())
    defs.push({
      ...def,
      ready: () => by.some(p => isConnected(p.integration.id)),
      impl: args => {
        const p = by.find(p => isConnected(p.integration.id));
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
      const mod = MODULES[integration.module];
      if (!mod) throw new Error(`Its code ("${integration.module}") isn't part of this app.`);
      const key = await keyOf(integration.id);
      if (integration.auth.type === 'oauth2' && !key) throw new Error('Not signed in yet.');
      const tool = mod.tools.find(t => t.id === integration.test.tool) ?? mod.tools[0];
      await tool.run(integration.test.args, key);
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
  if (integration.auth.type === 'oauth2') {
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
  return result;
}

// Signing in (OAuth): the person's OAuth client in, the service's sign-in page out.
export async function startIntegrationSignIn(id: string, client: { clientId?: string; clientSecret?: string }) {
  const integration = find(id);
  if (integration?.auth.type !== 'oauth2') throw new Error("That integration doesn't sign in.");
  return { url: await oauthStart(id, integration.auth, client) };
}

// The sign-in landed: test it straight away, so it's live only if it works.
export async function finishIntegrationSignIn(q: URLSearchParams) {
  const id = await oauthCallback(q);
  return connectIntegration(id);
}

export async function disconnectIntegration(id: string) {
  const auth = find(id)?.auth;
  if (auth?.type === 'oauth2') await oauthSignOut(id, auth);
  else await deleteSecret(secretKey(id));
  putState(id, null);
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
  await rm(join(ADDED, `${id}.yaml`), { force: true });
  await loadIntegrations();
}

// --- For the app and the builder ---------------------------------------------------

export async function listIntegrations() {
  const st = states();
  // Which signed-in integrations already have the person's OAuth client saved.
  const clients = new Set<string>();
  for (const { integration } of loaded) if (integration.auth.type === 'oauth2' && (await oauthSecret(integration.id))?.clientId) clients.add(integration.id);
  return loaded.map(({ integration, shipped }) => ({
    id: integration.id,
    name: integration.name,
    what: integration.what,
    kind: integration.kind,
    keyUrl: integration.key_url,
    needsKey: integration.auth.type !== 'none' && integration.auth.type !== 'oauth2',
    signIn: integration.auth.type === 'oauth2' ? { clientUrl: integration.auth.client_url ?? null, help: integration.auth.client_help ?? null, hasClient: clients.has(integration.id) } : null,
    shipped,
    connected: !!st[integration.id]?.connectedAt,
    test: st[integration.id]?.test ?? null,
    tools:
      integration.kind === 'http'
        ? integration.tools.map(t => ({ id: t.id, tier: t.tier }))
        : integration.kind === 'code'
          ? (MODULES[integration.module]?.tools ?? []).map(t => ({ id: t.id, tier: t.tier }))
          : (st[integration.id]?.tools ?? []).map(t => ({ id: mcpToolId(integration, t.name), tier: mcpTier(integration, t) })),
  }));
}

export const integrationProblems = () => problems;

// The ids of tools a connected integration provides, which a build may use.
export function integrationToolIds(): string[] {
  return [...providers()].filter(([, { by }]) => by.some(p => isConnected(p.integration.id))).map(([id]) => id);
}

// Tools from connected integrations, for the builder's catalogue.
export function integrationToolsForPrompt(): string {
  const lines: string[] = [];
  for (const [id, { def, by }] of providers()) {
    const connected = by.filter(p => isConnected(p.integration.id)).map(p => p.integration.name);
    if (connected.length) lines.push(`- ${id} [${def.tier}] ${def.description.split('\n')[0].slice(0, 160)} (via ${connected.join(', ')})`);
  }
  return lines.join('\n');
}

export type { HttpIntegration, McpIntegration };
