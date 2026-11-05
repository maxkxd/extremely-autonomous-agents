import { createHash, randomBytes } from 'node:crypto';
import { ConnectError } from '../models/providers.js';
import { safeFetch } from '../runner/net.js';
import { deleteSecret, getSecret, setSecret } from '../vault.js';
import type { OAuthDef } from './schema.js';
import { sharedClient, type SharedProvider } from './shared-clients.js';

// Signing in to an integration with OAuth 2 (authorization code + PKCE), for
// any definition with `auth: oauth2` - shipped ones (Gmail) and ones the Fleet
// Engineer writes. The person brings their own OAuth client, or a built-in
// uses ours (shared-clients.ts); the sign-in runs in their browser and lands
// back on this server at http://127.0.0.1:<port>,
// exactly that - no path: Google's desktop clients match the loopback address
// exactly and document it without one. The server's root takes the landing.
//
// The token endpoint comes from a definition someone may have written, so it
// goes through the safe fetcher like every other call agents can cause.

const PORT = Number(process.env.PORT ?? 5175);
export const OAUTH_REDIRECT = `http://127.0.0.1:${PORT}`;
export const LOCALHOST_REDIRECT = `http://localhost:${PORT}`;
const redirectOf = (auth: OAuthDef) => (auth.loopback === 'localhost' ? LOCALHOST_REDIRECT : OAUTH_REDIRECT);

export type OAuthSecret = {
  clientId: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  account?: string; // who signed in, when the service says
  discovered?: OAuthDef; // an MCP server's sign-in, as found when it was set up (mcp-auth.ts)
  registeredFor?: string; // the MCP server address that sign-in was found and registered for
  // Signed in with our client: its secret isn't kept here but read from the app,
  // and the client is never handed on to a connection that isn't built in.
  shared?: SharedProvider;
};

const secretKey = (id: string) => `integration:${id}`;
export const oauthSecret = (id: string) => getSecret<OAuthSecret>(secretKey(id));

// Who a token request is from: our client, its secret read from the app (only
// while it's still the client that signed in), or the person's own.
export const clientParams = (s: OAuthSecret): Record<string, string> => {
  const ours = s.shared && sharedClient(s.shared);
  const secret = s.shared ? (ours && ours.clientId === s.clientId ? ours.clientSecret : undefined) : s.clientSecret;
  return { client_id: s.clientId, ...(secret ? { client_secret: secret } : {}) };
};

const pending = new Map<string, { id: string; auth: OAuthDef; verifier: string; at: number }>();
export const SIGN_IN_LIFE_MS = 30 * 60_000;

// Saves the person's OAuth client and returns the address to sign in at.
export async function oauthStart(id: string, auth: OAuthDef, client?: { clientId?: string; clientSecret?: string }, keep?: Partial<OAuthSecret>): Promise<string> {
  const prev = await oauthSecret(id);
  const clientId = client?.clientId?.trim() || prev?.clientId;
  if (!clientId) throw new ConnectError('Paste your OAuth client ID first.');
  const clientSecret = client?.clientSecret?.trim() || (client?.clientId?.trim() ? undefined : prev?.clientSecret);
  // A new client starts a clean sign-in; the same one keeps its tokens until replaced.
  await setSecret(secretKey(id), { ...(clientId === prev?.clientId ? { ...prev, clientSecret: clientSecret ?? prev.clientSecret } : { clientId, clientSecret }), ...keep });
  // Kept 30 minutes: picking an account, a code on the phone or making an account can
  // take longer than 10, and the person then came back to "That sign-in has expired".
  for (const [k, p] of pending) if (Date.now() - p.at > SIGN_IN_LIFE_MS) pending.delete(k);
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(16).toString('base64url');
  pending.set(state, { id, auth, verifier, at: Date.now() });
  const url = new URL(auth.authorize_url);
  for (const [k, v] of Object.entries({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectOf(auth),
    ...(auth.scopes.length ? { scope: auth.scopes.join(' ') } : {}),
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    ...auth.params,
  }))
    url.searchParams.set(k, v);
  return url.toString();
}

async function tokenRequest(auth: OAuthDef, body: Record<string, string>) {
  const { res } = await safeFetch(auth.token_url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ ...body, ...(auth.resource ? { resource: auth.resource } : {}) }).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const why = String(json.error_description ?? json.error ?? res.status);
    throw new ConnectError(json.error === 'invalid_grant' ? 'The sign-in has expired or was revoked. Sign in again.' : `Sign-in failed: ${why}`);
  }
  return json as { access_token: string; refresh_token?: string; expires_in?: number; scope?: string };
}

// The browser lands here. Returns the integration's id, signed in.
// Google's consent page lets a person untick a permission, and the sign-in still
// works - then every call it needed fails ("insufficient authentication scopes"),
// long after, with nothing saying why. What was asked for and not granted, by name
// (gmail.modify); only for Google, where granting part is a choice on the page.
export function missingGoogleScopes(auth: OAuthDef, granted: string | undefined): string[] {
  if (granted === undefined || !/(^|\.)(googleapis|google)\.com$/.test(new URL(auth.token_url).hostname)) return [];
  const have = new Set(granted.split(/\s+/).filter(Boolean));
  return auth.scopes.filter(sc => !have.has(sc)).map(sc => sc.replace(/^https:\/\/www\.googleapis\.com\/auth\//, ''));
}

// Which connection a sign-in coming back is for, before it's handled (so a failed
// one can still be told to the Agency Engineer).
export const pendingSignIn = (state: string | null) => pending.get(state ?? '')?.id ?? null;

export async function oauthCallback(q: URLSearchParams): Promise<string> {
  const p = pending.get(q.get('state') ?? '');
  if (!p) throw new ConnectError('That sign-in has expired. Start it again from Settings.');
  pending.delete(q.get('state')!);
  if (q.get('error')) throw new ConnectError(q.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in failed: ${q.get('error_description') ?? q.get('error')}`);
  const code = q.get('code');
  if (!code) throw new ConnectError('Sign-in failed.');
  const s = await oauthSecret(p.id);
  if (!s) throw new ConnectError('Start the sign-in again from Settings.');
  const t = await tokenRequest(p.auth, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectOf(p.auth),
    code_verifier: p.verifier,
    ...clientParams(s),
  });
  const missing = missingGoogleScopes(p.auth, t.scope);
  if (missing.length)
    throw new ConnectError(`Google wasn't given everything this needs: ${missing.join(', ')}. Sign in again and tick every box on Google's page.`);
  await setSecret(secretKey(p.id), {
    ...s,
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? s.refreshToken,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
  } satisfies OAuthSecret);
  return p.id;
}

export async function setOAuthAccount(id: string, account: string) {
  const s = await oauthSecret(id);
  if (s) await setSecret(secretKey(id), { ...s, account });
}

// A current access token, refreshed when it's about to run out.
// One renewal at a time per connection: agents calling at once each renewed it, and
// a service that hands out a new refresh token every time (most MCP servers) takes
// the second use of the old one as theft and ends the whole sign-in; Zoho allows
// only 10 renewals in 10 minutes. The rest wait for that one and share its token.
const renewing = new Map<string, Promise<string>>();
export function once<T>(map: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const going = map.get(key);
  if (going) return going;
  const p = run().finally(() => map.delete(key));
  map.set(key, p);
  return p;
}

// A sign-in the service has ended (expired, revoked, a password changed): said the
// moment an agent finds out, not at the next daily check (index.ts tells the Engineer).
let onEnded: ((id: string, message: string) => void) | null = null;
export const whenSignInEnded = (fn: (id: string, message: string) => void) => void (onEnded = fn);

export async function oauthAccessToken(id: string, auth: OAuthDef): Promise<string | undefined> {
  const s = await oauthSecret(id);
  if (!s?.accessToken) return undefined;
  if (s.expiresAt && s.expiresAt - Date.now() > 60_000) return s.accessToken;
  if (!s.refreshToken) throw new Error('The sign-in has run out and has no way to renew itself. Sign in again in Settings > Connectors.');
  return once(renewing, id, async () => {
    // Renewed by the call before this one while it waited: use that.
    const now = await oauthSecret(id);
    if (now?.accessToken && now.expiresAt && now.expiresAt - Date.now() > 60_000) return now.accessToken;
    const current = now ?? s;
    let t: Awaited<ReturnType<typeof tokenRequest>>;
    try {
      t = await tokenRequest(auth, { grant_type: 'refresh_token', refresh_token: current.refreshToken ?? s.refreshToken!, ...clientParams(current) });
    } catch (e) {
      if (/expired or was revoked/.test((e as Error).message)) onEnded?.(id, (e as Error).message);
      throw e;
    }
    await setSecret(secretKey(id), {
      ...current,
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? current.refreshToken,
      expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    } satisfies OAuthSecret);
    return t.access_token;
  });
}

// Signing out: the service forgets the sign-in (where it can), and only the
// person's OAuth client is kept, so signing back in is one click. Ours isn't
// kept: signing back in uses whichever the app has then.
export async function oauthSignOut(id: string, auth: OAuthDef) {
  const s = await oauthSecret(id);
  if (!s) return;
  const token = s.refreshToken ?? s.accessToken;
  if (auth.revoke_url && token)
    await safeFetch(auth.revoke_url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    }).catch(() => {});
  if (s.shared) await deleteSecret(secretKey(id));
  else await setSecret(secretKey(id), { clientId: s.clientId, clientSecret: s.clientSecret, discovered: s.discovered } satisfies OAuthSecret);
}
