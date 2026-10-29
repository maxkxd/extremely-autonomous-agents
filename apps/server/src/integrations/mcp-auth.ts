import { safeFetch } from '../runner/net.js';
import { OAUTH_REDIRECT } from './oauth.js';
import type { OAuthDef } from './schema.js';

// Signing in to a remote MCP server that needs it (the MCP authorization spec):
// the server says where its sign-in lives, the authorization server says how
// it works, and this app registers itself there (dynamic client registration) -
// so the person never makes an OAuth client; they just sign in.

const json = async (url: string, init?: Parameters<typeof safeFetch>[1]) => {
  const { res } = await safeFetch(url, { headers: { accept: 'application/json' }, ...init });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { res, body };
};

// The protected-resource metadata: from the server's 401 header, else the well-known path.
async function resourceMetadata(serverUrl: string): Promise<{ authorization_servers?: string[]; scopes_supported?: string[]; resource?: string }> {
  const { res } = await safeFetch(serverUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Extremely Autonomous Agents', version: '1.0.0' } } }),
  });
  const hinted = /resource_metadata="([^"]+)"/.exec(res.headers.get('www-authenticate') ?? '')?.[1];
  const u = new URL(serverUrl);
  for (const url of [hinted, `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[]) {
    const { res: r, body } = await json(url).catch(() => ({ res: null, body: {} }));
    if (r?.ok && Array.isArray(body.authorization_servers)) return body as never;
  }
  // Older servers: the server is its own authorization server.
  return { authorization_servers: [u.origin] };
}

async function serverMetadata(issuer: string): Promise<Record<string, unknown>> {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, '');
  for (const url of [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`]) {
    const { res, body } = await json(url).catch(() => ({ res: null, body: {} }));
    if (res?.ok && body.authorization_endpoint && body.token_endpoint) return body;
  }
  throw new Error("The server asks for a sign-in but doesn't say where it is, so it can't be signed in to from here.");
}

// Finds the sign-in and registers this app. Returns how to sign in, and the client to sign in as.
export async function discoverMcpSignIn(serverUrl: string, name: string): Promise<{ auth: OAuthDef; clientId: string; clientSecret?: string }> {
  const rm = await resourceMetadata(serverUrl);
  const issuer = rm.authorization_servers?.[0];
  if (!issuer) throw new Error("The server didn't say where to sign in.");
  const as = await serverMetadata(issuer);
  if (!as.registration_endpoint) throw new Error(`${name} needs an OAuth client made by hand; it doesn't let apps register themselves.`);
  const { res, body } = await json(String(as.registration_endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Extremely Autonomous Agents',
      redirect_uris: [OAUTH_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (!res.ok || typeof body.client_id !== 'string') throw new Error(`${name} wouldn't register this app (${res.status}).`);
  const scopes = (rm.scopes_supported ?? (as.scopes_supported as string[] | undefined) ?? []).filter(s => typeof s === 'string');
  return {
    auth: {
      type: 'oauth2',
      authorize_url: String(as.authorization_endpoint),
      token_url: String(as.token_endpoint),
      revoke_url: typeof as.revocation_endpoint === 'string' ? as.revocation_endpoint : undefined,
      scopes: scopes.length ? scopes : ['openid'],
      // The resource this sign-in is for (RFC 8707), as the MCP spec asks.
      params: { resource: rm.resource ?? serverUrl },
      resource: rm.resource ?? serverUrl,
    },
    clientId: body.client_id,
    clientSecret: typeof body.client_secret === 'string' ? body.client_secret : undefined,
  };
}
