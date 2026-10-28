import { execFile } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySig } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CopilotClient } from '@github/copilot-sdk';
import { deleteSecret, getSecret, mask, setSecret } from '../vault.js';
import { ConnectError, PROVIDERS, provider, verify } from './providers.js';

// Model connections (docs/model-connections.md): what's connected, and the
// sign-in flows for the plans and one-click keys. Secrets live in the vault;
// this keeps only what's safe to show.

const run = promisify(execFile);
const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const STATE = join(DATA, 'connections.json');
const PORT = Number(process.env.PORT ?? 5175);

type Saved = { label: string; models: string[]; baseUrl?: string; connectedAt: string };
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

async function connected(id: string, label: string, models: string[], baseUrl?: string) {
  await update(s => {
    s.connections[id] = { label, models, baseUrl, connectedAt: new Date().toISOString() };
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
  setupNeeded?: string; // why it can't connect yet, in plain words
  claudeCode?: ClaudeCodeStatus;
};

export async function list(): Promise<ConnectionView[]> {
  const s = await load();
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
      connected: !!saved,
      label: saved?.label,
      models: saved?.models.length ?? 0,
    };
    if (p.id === 'claude-code') {
      view.claudeCode = cc;
      view.connected = cc.loggedIn && !!saved;
    }
    if (p.id === 'copilot') {
      if (!process.env.GITHUB_OAUTH_CLIENT_ID) view.setupNeeded = 'Needs a GitHub OAuth App for this app (GITHUB_OAUTH_CLIENT_ID).';
      if (copilotPending) view.pending = { userCode: copilotPending.userCode, verificationUri: copilotPending.verificationUri };
    }
    return view;
  });
}

// --- API keys and local servers ---------------------------------------------

export async function connectKey(id: string, key: string, baseUrl?: string) {
  const p = provider(id);
  if (!p || p.kind === 'plan') throw new ConnectError('Unknown provider.');
  const k = key.trim();
  if (p.kind === 'key' && !k) throw new ConnectError('Paste the key first.');
  const models = await verify(id, k, baseUrl?.trim() || p.baseUrl);
  if (p.kind === 'key') await setSecret(id, { key: k });
  const label = p.kind === 'local' ? `${models.length} model${models.length === 1 ? '' : 's'} on this computer` : mask(k);
  await connected(id, label, models, p.editableBaseUrl ? baseUrl?.trim() || p.baseUrl : undefined);
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

async function chatGptModels(accessToken: string): Promise<string[]> {
  const res = await fetch(`${OPENAI_RESOURCE}/models`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) return [];
  const j = (await res.json()) as { models?: { slug?: string; id?: string; visibility?: string }[]; data?: { id: string }[] };
  if (j.models) return j.models.filter(m => !m.visibility || m.visibility === 'list').map(m => m.slug ?? m.id ?? '').filter(Boolean);
  return (j.data ?? []).map(m => m.id);
}

// --- GitHub Copilot: device sign-in, then the official Copilot SDK -------------
// https://docs.github.com/en/copilot/how-tos/copilot-sdk/setup/github-oauth
// Needs a GitHub OAuth App registered for this product, with device flow on.

let copilotPending: { userCode: string; verificationUri: string } | null = null;

export async function copilotStart() {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) throw new ConnectError('GitHub Copilot needs a GitHub OAuth App for this app first (see docs/model-connections.md).');
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope: 'read:user' }),
  });
  const d = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number; error?: string };
  if (!res.ok || d.error) throw new ConnectError(`GitHub didn't start the sign-in (${d.error ?? res.status}).`);
  copilotPending = { userCode: d.user_code, verificationUri: d.verification_uri };
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
      if (!t.access_token) return;
      // Confirm the account has Copilot before calling it connected.
      const client = new CopilotClient({ gitHubToken: t.access_token, useLoggedInUser: false, logLevel: 'error' });
      try {
        const models = (await client.listModels()).map(m => m.id);
        await setSecret('copilot', { token: t.access_token });
        const user = (await (await fetch('https://api.github.com/user', { headers: { authorization: `Bearer ${t.access_token}` } })).json()) as { login?: string };
        await connected('copilot', user.login ? `@${user.login}` : 'Signed in', models);
      } finally {
        await client.stop().catch(() => {});
      }
      return;
    }
  } catch (e) {
    console.error('Copilot sign-in failed:', (e as Error).message);
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
// environment doesn't count, and is kept out of the check.
export type ClaudeCodeStatus = { installed: boolean; version?: string; loggedIn: boolean; authMethod?: string };

export async function claudeCodeStatus(): Promise<ClaudeCodeStatus> {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const opts = { timeout: 15000, windowsHide: true, shell: process.platform === 'win32', env };
  let version: string;
  try {
    version = (await run('claude', ['--version'], opts)).stdout.trim().split(' ')[0];
  } catch {
    return { installed: false, loggedIn: false };
  }
  // Exits non-zero when nobody is signed in, but still prints its status.
  const out = await run('claude', ['auth', 'status', '--json'], opts).then(
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

export async function claudeCodeConnect() {
  const s = await claudeCodeStatus();
  if (!s.installed) throw new ConnectError('Claude Code isn\'t installed on this computer.');
  if (!s.loggedIn) throw new ConnectError('Claude Code is installed but not signed in. Run `claude` in a terminal and sign in, then try again.');
  await connected('claude-code', `Claude Code ${s.version ?? ''}`.trim(), ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
}

// For the builder: an Anthropic key from the connections, else the server's own.
export async function anthropicKey(): Promise<string | undefined> {
  return (await getSecret<{ key: string }>('anthropic'))?.key ?? process.env.ANTHROPIC_API_KEY;
}
