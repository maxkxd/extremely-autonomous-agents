import { execFile, spawn } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySig } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CopilotClient } from '@github/copilot-sdk';
import { copilotConnection, copilotRuntimeProgress, ensureCopilotRuntime } from './copilotRuntime.js';
import { deleteSecret, getSecret, mask, setSecret } from '../vault.js';
import { chatGptModels as chatGptList, keepChat, knownModel, type ModelInfo, type Native } from './caps.js';
import type { Effort } from './choice.js';
import { ConnectError, PROVIDERS, provider, verify } from './providers.js';
import { DATA_DIR } from '../paths.js';

// Model connections (docs/model-connections.md): what's connected, and the
// sign-in flows for the plans and one-click keys. Secrets live in the vault;
// this keeps only what's safe to show.

const run = promisify(execFile);
const DATA = DATA_DIR;
const STATE = join(DATA, 'connections.json');
const PORT = Number(process.env.PORT ?? 5175);

// broken: a key that was saved but didn't check out, and why - kept so the
// row can say so until it's fixed, retried or removed.
// models: only those that can run an agent (models/caps.ts); efforts: the
// levels each takes, for the ones that take any; native: what to send the
// provider for a level whose name differs from ours. caps: which version of
// the capability check made the list - older lists are checked again at start.
type Saved = {
  label: string;
  models: string[];
  efforts?: Record<string, Effort[]>;
  native?: Record<string, Native>;
  caps?: number;
  baseUrl?: string;
  connectedAt: string;
  broken?: string;
};
const CAPS = 4;
type State = { connections: Record<string, Saved>; chatgptHostId?: string; chatgptClientId?: string };

async function load(): Promise<State> {
  try {
    return JSON.parse(await readFile(STATE, 'utf8')) as State;
  } catch {
    return { connections: {} };
  }
}
let saving = Promise.resolve();
function update(fn: (s: State) => void) {
  saving = saving.then(async () => {
    const s = await load();
    fn(s);
    await mkdir(DATA, { recursive: true });
    await writeFile(STATE, JSON.stringify(s, null, 2) + '\n');
  });
  return saving;
}

async function connected(id: string, label: string, models: ModelInfo[], baseUrl?: string) {
  const efforts = Object.fromEntries(models.filter(m => m.efforts.length).map(m => [m.id, m.efforts]));
  const native = Object.fromEntries(models.filter(m => m.native).map(m => [m.id, m.native!]));
  await update(s => {
    s.connections[id] = { label, models: models.map(m => m.id), efforts, native, caps: CAPS, baseUrl, connectedAt: new Date().toISOString() };
  });
}

export async function disconnect(id: string) {
  await deleteSecret(id);
  await update(s => {
    delete s.connections[id];
  });
}

// --- What the app shows ------------------------------------------------------

export type ConnectionView = {
  id: string;
  name: string;
  kind: string;
  what: string;
  keyUrl?: string;
  keyPrefix?: string;
  baseUrl?: string;
  editableBaseUrl?: boolean;
  oneClick?: boolean;
  connected: boolean;
  label?: string; // masked key, account, or status line
  models: number;
  pending?: { userCode?: string; verificationUri?: string }; // a sign-in in progress
  preparing?: number; // Copilot: its runtime downloading, % done (copilotRuntime.ts)
  setupNeeded?: string; // why it can't connect yet, in plain words
  broken?: string; // a saved key that didn't check out, and why
  lastError?: string; // why the last sign-in didn't finish
  claudeCode?: ClaudeCodeStatus;
};

export async function list(): Promise<ConnectionView[]> {
  await refreshLocal();
  const s = await load();
  cached = s.connections;
  const cc = await claudeCodeStatus();
  return PROVIDERS.map(p => {
    const saved = s.connections[p.id];
    const view: ConnectionView = {
      id: p.id,
      name: p.name,
      kind: p.kind,
      what: p.what,
      keyUrl: p.keyUrl,
      keyPrefix: p.keyPrefix,
      baseUrl: saved?.baseUrl ?? p.baseUrl,
      editableBaseUrl: p.editableBaseUrl,
      oneClick: p.oneClick,
      connected: !!saved && !saved.broken,
      label: saved?.label,
      models: saved?.models.length ?? 0,
      broken: saved?.broken,
    };
    if (p.id === 'claude-code') {
      view.claudeCode = cc;
      view.connected = cc.loggedIn && !!saved;
    }
    if (p.id === 'copilot') {
      if (copilotPending) view.pending = { userCode: copilotPending.userCode, verificationUri: copilotPending.verificationUri };
      else if (!saved && copilotError) view.lastError = copilotError;
      // Its runtime coming down (first connect on an installed app): how far.
      view.preparing = copilotRuntimeProgress() ?? undefined;
    }
    return view;
  });
}

// --- API keys and local servers ---------------------------------------------

// What people paste: stray spaces and line breaks, quotes, a "Bearer " prefix.
export const cleanKey = (key: string) =>
  key
    .replace(/\s+/g, '')
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/^bearer/i, '');

// Distinctive key prefixes, to catch a key pasted into the wrong provider.
const PREFIXES: [string, string][] = [
  ['sk-ant-', 'Anthropic'],
  ['sk-or-', 'OpenRouter'],
  ['AIza', 'Google Gemini'],
  ['AQ.', 'Google Gemini'],
  ['xai-', 'xAI'],
  ['gsk_', 'Groq'],
];
function wrongProvider(id: string, key: string): string | null {
  const hit = PREFIXES.find(([prefix]) => key.startsWith(prefix));
  if (!hit || hit[1] === provider(id)?.name) return null;
  return `This looks like a${/^[AEIOU]/.test(hit[1]) ? 'n' : ''} ${hit[1]} key, not a ${provider(id)?.name} one.`;
}

// Saves a key and checks it with the provider. A key that doesn't check out
// is still saved, marked broken with the reason, so it shows up as needing
// attention instead of vanishing; the error is also thrown to the caller.
export async function connectKey(id: string, key: string, baseUrl?: string) {
  const p = provider(id);
  if (!p || p.kind === 'plan') throw new ConnectError('Unknown provider.');
  const k = p.kind === 'key' ? cleanKey(key) : '';
  if (p.kind === 'key' && !k) throw new ConnectError('Paste the key first.');
  const url = p.editableBaseUrl ? baseUrl?.trim() || p.baseUrl : undefined;
  if (p.kind === 'key') await setSecret(id, { key: k });
  try {
    const wrong = wrongProvider(id, k);
    if (wrong) throw new ConnectError(wrong);
    const models = await verify(id, k, url);
    const label = p.kind === 'local' ? localLabel(models) : mask(k);
    await connected(id, label, models, url);
  } catch (e) {
    const reason = e instanceof ConnectError ? e.message : "That key couldn't be checked.";
    // A local server that isn't running isn't a broken key: just say so.
    if (p.kind === 'key') await markBroken(id, mask(k), reason, url);
    throw e instanceof ConnectError ? e : new ConnectError(reason);
  }
}

const localLabel = (models: ModelInfo[]) => `${models.length} model${models.length === 1 ? '' : 's'} on this computer`;

// Models on this computer come and go (ollama pull / rm), so a local
// connection's list is read again whenever the app looks - at most every 15
// seconds. Listing and reading capabilities never loads a model into memory.
// If the server isn't running, the last list stays (and a pick's check says so).
const LOCAL_EVERY_MS = 15_000;
const localSeen: Record<string, number> = {};
async function refreshLocal() {
  const s = await load();
  for (const p of PROVIDERS.filter(p => p.kind === 'local')) {
    const saved = s.connections[p.id];
    if (!saved || saved.broken || Date.now() - (localSeen[p.id] ?? 0) < LOCAL_EVERY_MS) continue;
    localSeen[p.id] = Date.now();
    try {
      const models = await verify(p.id, '', saved.baseUrl);
      if (models.map(m => m.id).join('\n') !== saved.models.join('\n')) await connected(p.id, localLabel(models), models, saved.baseUrl);
    } catch {
      // Not running right now: keep what was there.
    }
  }
}

async function markBroken(id: string, label: string, reason: string, baseUrl?: string) {
  await update(s => {
    s.connections[id] = { label, models: [], baseUrl, connectedAt: new Date().toISOString(), broken: reason };
  });
}

// Checks a saved key again (the provider may have been down, or the key fixed
// on their side).
export async function retryKey(id: string) {
  const saved = (await load()).connections[id];
  const secret = await getSecret<{ key: string }>(id);
  if (!saved || !secret) throw new ConnectError('There is no saved key to check.');
  await connectKey(id, secret.key, saved.baseUrl);
}

// --- PKCE helpers -------------------------------------------------------------

const b64url = (b: Buffer) => b.toString('base64url');
function pkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash('sha256').update(verifier).digest()) };
}

// Sign-ins started but not finished, by their state value. Short-lived.
const pending = new Map<string, { provider: string; verifier: string; nonce?: string; clientId?: string; redirectUri: string; at: number }>();
function remember(state: string, v: Omit<Parameters<typeof pending.set>[1], 'at'>) {
  for (const [k, p] of pending) if (Date.now() - p.at > 10 * 60_000) pending.delete(k);
  pending.set(state, { ...v, at: Date.now() });
}

// --- OpenRouter: one click, and it hands back a key ---------------------------
// https://openrouter.ai/docs/use-cases/oauth-pkce

export function openRouterStart(): string {
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const redirectUri = `http://localhost:${PORT}/api/oauth/openrouter/callback?state=${state}`;
  remember(state, { provider: 'openrouter', verifier, redirectUri });
  return `https://openrouter.ai/auth?${new URLSearchParams({ callback_url: redirectUri, code_challenge: challenge, code_challenge_method: 'S256' })}`;
}

export async function openRouterCallback(q: URLSearchParams) {
  const p = pending.get(q.get('state') ?? '');
  if (!p || p.provider !== 'openrouter') throw new ConnectError('That sign-in has expired. Start it again from Settings.');
  pending.delete(q.get('state')!);
  const code = q.get('code');
  if (!code) throw new ConnectError('OpenRouter sign-in was cancelled.');
  const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: p.verifier, code_challenge_method: 'S256' }),
  });
  if (!res.ok) throw new ConnectError(`OpenRouter didn't issue a key (${res.status}).`);
  const { key } = (await res.json()) as { key: string };
  await connectKey('openrouter', key);
}

// --- Sign in with ChatGPT -----------------------------------------------------
// https://developers.openai.com/siwc - the documented protocol, implemented
// here (OpenAI's devkit is noncommercial-licensed). Self-serve for local use;
// a paid product needs OpenAI's approval before it ships.

const OPENAI_AUTH = 'https://auth.openai.com';
const OPENAI_RESOURCE = 'https://api.openai.com/v1';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const APP_NAME = 'Extremely Autonomous Agents';

type ChatGptTokens = {
  clientId: string;
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string;
  email: string;
  subject: string;
};

export async function chatGptStart(): Promise<string> {
  // One opaque id per install ("host"), reused for every sign-in.
  const s = await load();
  const hostId = s.chatgptHostId ?? `urn:uuid:${randomUUID()}`;
  if (!s.chatgptHostId) await update(x => void (x.chatgptHostId = hostId));
  const clientId = s.chatgptClientId ?? 'dynamic_agent_client';
  const { verifier, challenge } = pkce();
  const state = b64url(randomBytes(16));
  const nonce = b64url(randomBytes(16));
  // Loopback on 127.0.0.1 - OpenAI requires that, not "localhost".
  const redirectUri = `http://127.0.0.1:${PORT}/api/oauth/chatgpt/callback`;
  remember(state, { provider: 'chatgpt', verifier, nonce, clientId, redirectUri });
  const params = new URLSearchParams({
    client_id: clientId,
    ext_agent_host_id: hostId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`,
    resource: OPENAI_RESOURCE,
    state,
    nonce,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  });
  if (clientId === 'dynamic_agent_client') params.set('agent_name_hint', APP_NAME);
  return `${OPENAI_AUTH}/api/accounts/authorize?${params}`;
}

type Discovery = { issuer: string; jwks_uri: string; token_endpoint: string };
const discovery = async () => (await (await fetch(`${OPENAI_AUTH}/.well-known/openid-configuration`)).json()) as Discovery;

// Verifies the ID token's signature (RS256 against OpenAI's published keys),
// issuer, audience, expiry and nonce. Returns its claims.
async function verifyIdToken(token: string, clientId: string, nonce?: string) {
  const [h, p, sig] = token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { kid: string; alg: string };
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
  const d = await discovery();
  const { keys } = (await (await fetch(d.jwks_uri)).json()) as { keys: (Record<string, string> & { kid: string })[] };
  const jwk = keys.find(k => k.kid === header.kid);
  if (!jwk || header.alg !== 'RS256') throw new ConnectError("ChatGPT's sign-in couldn't be verified.");
  const ok = verifySig('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' } as Parameters<typeof createPublicKey>[0]), Buffer.from(sig, 'base64url'));
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!ok || claims.iss !== d.issuer || !aud.includes(clientId) || Number(claims.exp) * 1000 < Date.now() || (nonce && claims.nonce !== nonce))
    throw new ConnectError("ChatGPT's sign-in couldn't be verified.");
  return claims;
}

async function tokenRequest(body: Record<string, string>) {
  const d = await discovery();
  if (new URL(d.token_endpoint).origin !== OPENAI_AUTH) throw new ConnectError("ChatGPT's sign-in couldn't be verified.");
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...body, resource: OPENAI_RESOURCE }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new ConnectError(json.error === 'invalid_grant' ? 'That sign-in has expired. Start it again.' : `ChatGPT sign-in failed (${res.status}).`);
  return json as { id_token?: string; access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}

export async function chatGptCallback(q: URLSearchParams) {
  const state = q.get('state') ?? '';
  const p = pending.get(state);
  if (!p || p.provider !== 'chatgpt') throw new ConnectError('That sign-in has expired. Start it again from Settings.');
  pending.delete(state);
  if (q.get('error')) throw new ConnectError(q.get('error') === 'access_denied' ? 'ChatGPT sign-in was cancelled.' : 'ChatGPT sign-in failed.');
  const code = q.get('code');
  if (!code) throw new ConnectError('ChatGPT sign-in failed.');
  // A first sign-in registers this app and returns its issued client id.
  let clientId = p.clientId!;
  const issued = q.get('client_id');
  if (clientId === 'dynamic_agent_client') {
    if (!issued?.startsWith('oaiapp_')) throw new ConnectError("ChatGPT didn't finish registering this app. Try again.");
    clientId = issued;
    await update(s => void (s.chatgptClientId = clientId));
  } else if (issued && issued !== clientId) throw new ConnectError("ChatGPT's sign-in couldn't be verified.");

  const t = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri });
  if (!t.id_token || !t.refresh_token) throw new ConnectError('ChatGPT sign-in failed.');
  const claims = await verifyIdToken(t.id_token, clientId, p.nonce);
  const scopes = t.scope ?? q.get('scope') ?? '';
  if (!scopes.split(' ').includes(PLAN_SCOPE)) throw new ConnectError("You signed in, but didn't allow this app to use your ChatGPT plan.");
  const tokens: ChatGptTokens = {
    clientId,
    idToken: t.id_token,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
    scopes,
    email: String(claims.email ?? ''),
    subject: String(claims.sub),
  };
  await setSecret('chatgpt', tokens);
  const models = await chatGptModels(tokens.accessToken);
  await connected('chatgpt', tokens.email || 'Signed in', models);
}

// A current access token, refreshed when it's about to run out.
export async function chatGptAccessToken(): Promise<string> {
  const t = await getSecret<ChatGptTokens>('chatgpt');
  if (!t) throw new ConnectError('ChatGPT is not connected.');
  if (t.expiresAt - Date.now() > 60_000) return t.accessToken;
  const r = await tokenRequest({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refreshToken });
  const next = { ...t, accessToken: r.access_token, refreshToken: r.refresh_token ?? t.refreshToken, expiresAt: Date.now() + r.expires_in * 1000, scopes: r.scope ?? t.scopes };
  await setSecret('chatgpt', next);
  return next.accessToken;
}

async function chatGptModels(accessToken: string): Promise<ModelInfo[]> {
  const res = await fetch(`${OPENAI_RESOURCE}/models`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return [];
  const j = (await res.json()) as { models?: unknown; data?: { id: string }[] };
  if (j.models) return keepChat(chatGptList(j.models));
  return keepChat((j.data ?? []).map(m => knownModel('openai', m.id)));
}

// --- GitHub Copilot: device sign-in, then the official Copilot SDK -------------
// https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth
// Needs a GitHub OAuth App registered for this product, with device flow on.
// Its client id is public by design (device flow has no secret), so it's built
// in - the installed app has no .env. GITHUB_OAUTH_CLIENT_ID still overrides it.
const GITHUB_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || 'Ov23liRZprRaqnQxYLB8';

let copilotPending: { userCode: string; verificationUri: string } | null = null;
let copilotError: string | null = null;

export async function copilotStart() {
  const clientId = GITHUB_CLIENT_ID;
  // Its runtime, if this install doesn't have it, comes down while they sign in (copilotRuntime.ts).
  void copilotConnection().catch(e => (copilotError = (e as Error).message));
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
  });
  const d = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number; error?: string };
  if (!res.ok || d.error) throw new ConnectError(`GitHub didn't start the sign-in (${d.error ?? res.status}).`);
  copilotPending = { userCode: d.user_code, verificationUri: d.verification_uri };
  copilotError = null;
  void pollCopilot(clientId, d.device_code, d.interval, Date.now() + d.expires_in * 1000);
  return copilotPending;
}

async function pollCopilot(clientId: string, deviceCode: string, interval: number, until: number) {
  let wait = interval;
  try {
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, wait * 1000));
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      });
      const t = (await res.json()) as { access_token?: string; error?: string; interval?: number };
      if (t.error === 'authorization_pending') continue;
      if (t.error === 'slow_down') {
        wait = t.interval ?? wait + 5;
        continue;
      }
      if (t.error === 'expired_token') return void (copilotError = 'That code expired. Press Connect for a new one.');
      if (t.error === 'access_denied') return void (copilotError = 'Sign-in was cancelled on GitHub.');
      if (!t.access_token) return void (copilotError = `GitHub sign-in failed (${t.error ?? 'no token'}).`);
      // Confirm the account has Copilot before calling it connected.
      const client = new CopilotClient({ ...(await copilotConnection()), gitHubToken: t.access_token, useLoggedInUser: false, logLevel: 'error' });
      try {
        await client.start();
        const models = (await client.listModels()).map(m => ({ id: m.id, efforts: [] }));
        await setSecret('copilot', { token: t.access_token });
        const user = (await (await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${t.access_token}` } })).json()) as { login?: string };
        await connected('copilot', user.login ? `@${user.login}` : 'Signed in', models);
      } finally {
        await client.stop().catch(() => {});
      }
      return;
    }
    copilotError = 'That code expired. Press Connect for a new one.';
  } catch (e) {
    console.error('Copilot sign-in failed:', (e as Error).message);
    copilotError = /copilot|subscription|entitle|403/i.test((e as Error).message)
      ? "Signed in to GitHub, but this account doesn't have a Copilot plan."
      : `Copilot couldn't be checked: ${(e as Error).message}`;
  } finally {
    copilotPending = null;
  }
}

// --- Claude Code: the person's own install, signed in through Anthropic -------
// Anthropic doesn't allow apps to log into Claude.ai or hold plan credentials.
// So this app never touches the login: the person signs into the official,
// unmodified Claude Code themselves, and agents run through that. All we read
// is `claude auth status` (signed in or not - no tokens).

// loggedIn means signed in with a Claude account (a plan) - an API key in the
// environment doesn't count, and is kept out of the check. task: an install or
// sign-in this app started in a terminal window, still waiting to finish.
export type ClaudeCodeStatus = {
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  authMethod?: string;
  task?: 'installing' | 'signing-in' | 'updating';
  // A model needs a newer Claude Code than this one (learnt from a run): that version.
  needsUpdate?: string;
};

// "Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is
// required": the version runs need, until Claude Code is at least that.
let claudeNeeds: string | null = null;
const older = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};
// A run's error: if it says Claude Code is too old, remember what's needed. Returns that version.
export function noteClaudeCodeTooOld(error: string): string | null {
  const v = /version (\d+(?:\.\d+)+) or newer is required/i.exec(error)?.[1];
  if (v && (!claudeNeeds || older(claudeNeeds, v))) claudeNeeds = v;
  return v ?? null;
}
const withNeeds = (s: ClaudeCodeStatus): ClaudeCodeStatus => {
  if (claudeNeeds && s.version && !older(s.version, claudeNeeds)) claudeNeeds = null;
  return claudeNeeds && s.installed ? { ...s, needsUpdate: claudeNeeds } : s;
};

// Without the server's own Anthropic key, so Claude Code reports (and signs in
// to) the person's Claude account, not that key.
function claudeEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

// Where Claude Code is: on the PATH, or where the official installer puts it
// (a fresh install isn't on this server's PATH until it restarts).
async function claudeBin(): Promise<string | null> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const candidates = [
    'claude',
    process.platform === 'win32' ? join(home, '.local', 'bin', 'claude.exe') : join(home, '.local', 'bin', 'claude'),
  ];
  for (const bin of candidates) {
    try {
      await run(bin, ['--version'], claudeOpts());
      return bin;
    } catch {
      // try the next one
    }
  }
  return null;
}
const claudeOpts = () => ({ timeout: 15000, windowsHide: true, shell: process.platform === 'win32', env: claudeEnv() });
const quoted = (bin: string) => (bin.includes(' ') ? `"${bin}"` : bin);

let claudeTask: ClaudeCodeStatus['task'];

type ClaudeCodeFacts = Omit<ClaudeCodeStatus, 'task'>;

async function checkClaudeCode(): Promise<ClaudeCodeFacts> {
  const bin = await claudeBin();
  if (!bin) return { installed: false, loggedIn: false };
  const version = (await run(quoted(bin), ['--version'], claudeOpts())).stdout.trim().split(' ')[0];
  // Exits non-zero when nobody is signed in, but still prints its status.
  const out = await run(quoted(bin), ['auth', 'status', '--json'], claudeOpts()).then(
    r => r.stdout,
    (e: { stdout?: string }) => e.stdout ?? '',
  );
  try {
    const s = JSON.parse(out) as { loggedIn?: boolean; authMethod?: string };
    const plan = !!s.loggedIn && !!s.authMethod && !/none|api.?key/i.test(s.authMethod);
    return { installed: true, version, loggedIn: plan, authMethod: s.authMethod };
  } catch {
    return { installed: true, version, loggedIn: false };
  }
}

// Asking Claude Code about itself starts it three times - about a second - and
// the connections list is read by the app's Settings and by every runner tick.
// So the list gets the last answer straight away and it's checked again in the
// background (every 30 seconds, or each time while installing or signing in).
// Connecting and waiting for a sign-in ask fresh.
const CLAUDE_RECHECK_MS = 30_000;
let claudeLast: { at: number; facts: ClaudeCodeFacts } | null = null;
let claudeChecking: Promise<ClaudeCodeFacts> | null = null;
const recheckClaudeCode = () =>
  (claudeChecking ??= checkClaudeCode()
    .then(facts => ((claudeLast = { at: Date.now(), facts }), facts))
    .finally(() => (claudeChecking = null)));

export async function claudeCodeStatus(fresh = false): Promise<ClaudeCodeStatus> {
  if (fresh || !claudeLast) return withNeeds({ ...(await recheckClaudeCode()), task: claudeTask });
  if (claudeTask || Date.now() - claudeLast.at > CLAUDE_RECHECK_MS) void recheckClaudeCode().catch(() => {});
  return withNeeds({ ...claudeLast.facts, task: claudeTask });
}

const CLAUDE_CODE_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];

export async function claudeCodeConnect() {
  const s = await claudeCodeStatus(true);
  if (!s.installed) throw new ConnectError("Claude Code isn't installed on this computer.");
  if (!s.loggedIn) throw new ConnectError("Claude Code isn't signed in to a Claude account yet.");
  await connected('claude-code', `Claude Code ${s.version ?? ''}`.trim(), CLAUDE_CODE_MODELS.map(id => knownModel('claude-code', id)));
}

// Opens a visible terminal window running one command, so the person sees
// Anthropic's own installer or sign-in doing its thing.
function openTerminal(title: string, command: { win: string; unix: string }) {
  const opts = { env: claudeEnv(), detached: true, stdio: 'ignore' as const };
  let child;
  if (process.platform === 'win32') {
    // A new PowerShell window that stays open, so any message stays readable.
    // Quoted, or cmd would split the command at its & and | characters.
    child = spawn('cmd.exe', ['/c', 'start', `"${title}"`, 'powershell', '-NoExit', '-Command', `"${command.win}"`], { ...opts, windowsVerbatimArguments: true });
  } else if (process.platform === 'darwin') {
    const script = command.unix.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    child = spawn('osascript', ['-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate'], opts);
  } else {
    child = spawn('x-terminal-emulator', ['-e', `bash -lc '${command.unix.replace(/'/g, "'\\''")}; exec bash'`], opts);
  }
  child.on('error', () => {});
  child.unref();
}

// Checks every couple of seconds until done() says so, or ten minutes pass.
function waitFor(done: () => Promise<boolean>, then: () => Promise<void>) {
  const until = Date.now() + 10 * 60_000;
  const tick = async () => {
    try {
      if (await done()) {
        claudeTask = undefined;
        return then();
      }
    } catch {
      // keep waiting
    }
    if (Date.now() > until) claudeTask = undefined;
    else setTimeout(tick, 2000);
  };
  setTimeout(tick, 2000);
}

// Anthropic's official installer (code.claude.com/docs/en/setup).
export async function claudeCodeInstall() {
  if (await claudeBin()) throw new ConnectError('Claude Code is already installed.');
  claudeTask = 'installing';
  openTerminal('Install Claude Code', {
    win: 'irm https://claude.ai/install.ps1 | iex',
    unix: 'curl -fsSL https://claude.ai/install.sh | bash',
  });
  waitFor(async () => !!(await claudeBin()), async () => {});
}

// Claude Code's own update, in a terminal window like its install and sign-in;
// the row follows along and the warning goes once it's new enough.
export async function claudeCodeUpdate() {
  const bin = await claudeBin();
  if (!bin) throw new ConnectError("Claude Code isn't installed on this computer.");
  claudeTask = 'updating';
  const run = `& ${process.platform === 'win32' ? `'${bin === 'claude' ? 'claude' : bin}'` : bin} update`;
  openTerminal('Update Claude Code', { win: run, unix: `${quoted(bin)} update` });
  waitFor(async () => !(await claudeCodeStatus(true)).needsUpdate, async () => {});
}

// Claude Code's own sign-in, straight to the Claude-subscription login. When
// it finishes, the plan connects by itself.
export async function claudeCodeLogin() {
  const bin = await claudeBin();
  if (!bin) throw new ConnectError("Claude Code isn't installed on this computer.");
  claudeTask = 'signing-in';
  const run = `& ${process.platform === 'win32' ? `'${bin === 'claude' ? 'claude' : bin}'` : bin} auth login --claudeai`;
  openTerminal('Sign in to Claude', { win: run, unix: `${quoted(bin)} auth login --claudeai` });
  waitFor(async () => (await claudeCodeStatus(true)).loggedIn, claudeCodeConnect);
}

// The models agents can be given: every working connection and its models
// that can run one, with the effort levels each takes (none listed: it has no
// effort setting). Copilot picks its own model, so it offers one choice, "auto".
export type Available = { connection: string; name: string; kind: string; models: string[]; efforts: Record<string, Effort[]> };
export async function availableModels(): Promise<Available[]> {
  return (await list())
    .filter(c => c.connected)
    .map(c => {
      const saved = cached[c.id];
      if (c.id === 'copilot') return { connection: c.id, name: c.name, kind: c.kind, models: ['auto'], efforts: {} };
      return { connection: c.id, name: c.name, kind: c.kind, models: saved?.models ?? [], efforts: saved?.efforts ?? {} };
    })
    .filter(a => a.models.length);
}
// Filled by list(), which availableModels calls first.
let cached: Record<string, Saved> = {};

// A saved connection's base URL (custom and local providers), for the model check.
export async function connectionBaseUrl(id: string): Promise<string | undefined> {
  return (await load()).connections[id]?.baseUrl;
}

// A model's effort levels as a live check found them (models/check.ts),
// replacing what the model list or the known table said.
export async function setModelLevels(connection: string, info: ModelInfo) {
  await update(s => {
    const saved = s.connections[connection];
    if (!saved || !saved.models.includes(info.id)) return;
    saved.efforts = { ...saved.efforts };
    saved.native = { ...saved.native };
    if (info.efforts.length) saved.efforts[info.id] = info.efforts;
    else delete saved.efforts[info.id];
    if (info.native) saved.native[info.id] = info.native;
    else delete saved.native[info.id];
  });
}

// A model's level names where they differ from ours, from the last list()
// (the runner refreshes it every tick).
export const nativeEffortSync = (connection: string, model: string) => cached[connection]?.native?.[model];

// What to send a provider for one of our effort levels on a model, for the
// runner: the provider's own name where it differs (our "max" as "xhigh").
export async function nativeEffort(connection: string, model: string, effort: Effort): Promise<string> {
  return (await load()).connections[connection]?.native?.[model]?.[effort] ?? effort;
}

// Connections saved before the capability check (or by an older one) still
// list every model the provider had, chat or not. Checks them again once, at
// start; one that can't be reached, or answers with nothing, keeps its list
// (and is tried again next start) rather than losing it.
export async function recheckCapabilities() {
  const s = await load();
  for (const [id, saved] of Object.entries(s.connections)) {
    if (saved.caps === CAPS || saved.broken) continue;
    try {
      let models: ModelInfo[];
      if (id === 'claude-code') models = CLAUDE_CODE_MODELS.map(m => knownModel(id, m));
      else if (id === 'chatgpt') models = await chatGptModels(await chatGptAccessToken());
      else if (id === 'copilot') models = keepChat(saved.models.map(m => ({ id: m, efforts: [] })));
      else {
        const key = provider(id)?.kind === 'key' ? (await getSecret<{ key: string }>(id))?.key : '';
        if (key === undefined) continue;
        models = await verify(id, key, saved.baseUrl);
      }
      if (!models.length && id !== 'copilot') {
        console.error(`Rechecking ${id}'s models found none; keeping the old list.`);
        continue;
      }
      await connected(id, saved.label, models, saved.baseUrl);
    } catch (e) {
      console.error(`Couldn't recheck ${id}'s models:`, (e as Error).message);
    }
  }
}

// For the builder: an Anthropic key from the connections, else the server's own.
export async function anthropicKey(): Promise<string | undefined> {
  return (await getSecret<{ key: string }>('anthropic'))?.key ?? process.env.ANTHROPIC_API_KEY;
}
