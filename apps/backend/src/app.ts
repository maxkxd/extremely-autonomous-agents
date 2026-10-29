import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from './db.js';
import {
  acceptInvite,
  ApiError,
  createInvite,
  createOrg,
  displayName,
  deleteOrg,
  ensureUser,
  hostBySecret,
  hostOf,
  leave,
  members,
  myOrgs,
  pendingInvites,
  previewInvite,
  registerHost,
  removeMember,
  renameOrg,
  revokeInvite,
  roleIn,
  setDisplayName,
  setRole,
} from './directory.js';
import type { Auth } from './tokens.js';

// Our backend's API (docs/architecture.md, "Accounts and organisations").
// Every route but /health and the keys needs a signed-in person: their Clerk
// session token as "Authorization: Bearer ...". It knows who's in which
// organisation and where each host is; it never sees an agency's contents.

type Ctx = { db: Db; auth: Auth; userId: string; params: string[]; body: Record<string, unknown>; authorization?: string };
type Route = { method: string; path: RegExp; open?: boolean; run: (c: Ctx) => Promise<unknown> };

// Signed in: their record kept current, and the name they go by (their own choice, if they made one).
const user = async (c: Ctx) => {
  const p = await c.auth.profile(c.userId);
  await ensureUser(c.db, p);
  return { ...p, name: (await displayName(c.db, p.id)) || p.name };
};

const ROUTES: Route[] = [
  { method: 'GET', path: /^\/health$/, open: true, run: async () => ({ ok: true }) },
  // How the apps sign people in: Clerk, or (development only) by email alone.
  { method: 'GET', path: /^\/config$/, open: true, run: async c => ({ signIn: c.auth.devSignIn ? 'dev' : 'clerk', issuer: c.auth.issuer }) },
  {
    method: 'POST',
    path: /^\/dev\/sign-in$/,
    open: true,
    run: async c => {
      if (!c.auth.devSignIn) throw new ApiError(404, 'Not found.');
      const email = typeof c.body.email === 'string' ? c.body.email.trim() : '';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ApiError(400, "That isn't an email address.");
      return c.auth.devSignIn(email, typeof c.body.name === 'string' ? c.body.name.slice(0, 80) : '');
    },
  },
  // The keys hosts check org access tokens against.
  { method: 'GET', path: /^\/\.well-known\/jwks\.json$/, open: true, run: async c => c.auth.jwks() },

  // You, your personal agency (made the first time), and every organisation you're in.
  {
    method: 'GET',
    path: /^\/me$/,
    run: async c => {
      const p = await user(c);
      return { user: p, orgs: await myOrgs(c.db, p.id) };
    },
  },
  // The name they go by (Settings > Account); blank goes back to the sign-in provider's.
  {
    method: 'PATCH',
    path: /^\/me$/,
    run: async c => {
      await user(c);
      await setDisplayName(c.db, c.userId, c.body.name);
      return { user: await user(c) };
    },
  },

  { method: 'POST', path: /^\/orgs$/, run: async c => (await user(c), createOrg(c.db, c.userId, c.body.name)) },
  { method: 'PATCH', path: /^\/orgs\/([\w-]+)$/, run: async c => (await renameOrg(c.db, c.params[0], c.userId, c.body.name), { ok: true }) },
  { method: 'DELETE', path: /^\/orgs\/([\w-]+)$/, run: async c => (await deleteOrg(c.db, c.params[0], c.userId), { ok: true }) },

  { method: 'GET', path: /^\/orgs\/([\w-]+)\/members$/, run: async c => members(c.db, c.params[0], c.userId) },
  { method: 'PATCH', path: /^\/orgs\/([\w-]+)\/members\/([^/]+)$/, run: async c => (await setRole(c.db, c.params[0], c.userId, decodeURIComponent(c.params[1]), c.body.role), { ok: true }) },
  { method: 'DELETE', path: /^\/orgs\/([\w-]+)\/members\/([^/]+)$/, run: async c => (await removeMember(c.db, c.params[0], c.userId, decodeURIComponent(c.params[1])), { ok: true }) },
  { method: 'POST', path: /^\/orgs\/([\w-]+)\/leave$/, run: async c => (await leave(c.db, c.params[0], c.userId), { ok: true }) },

  { method: 'POST', path: /^\/orgs\/([\w-]+)\/invites$/, run: async c => createInvite(c.db, c.params[0], c.userId, { email: c.body.email, role: c.body.role }) },
  { method: 'GET', path: /^\/orgs\/([\w-]+)\/invites$/, run: async c => pendingInvites(c.db, c.params[0], c.userId) },
  { method: 'DELETE', path: /^\/invites\/([\w-]+)$/, run: async c => (await revokeInvite(c.db, c.params[0], c.userId), { ok: true }) },
  { method: 'GET', path: /^\/invites\/([\w-]+)$/, run: async c => previewInvite(c.db, c.params[0]) },
  { method: 'POST', path: /^\/invites\/([\w-]+)\/accept$/, run: async c => acceptInvite(c.db, c.params[0], await user(c)) },

  // An org access token, for talking to one of your organisations' hosts.
  {
    method: 'POST',
    path: /^\/orgs\/([\w-]+)\/token$/,
    run: async c => {
      const p = await user(c);
      const me = await roleIn(c.db, c.params[0], p.id);
      return c.auth.orgToken({ sub: p.id, org: c.params[0], role: me.role, name: p.name, kind: me.kind });
    },
  },

  // A host asking whether someone's still in its organisation, and as what: for
  // connections that act as a person without a fresh org token (their own agency
  // MCP address). Signed with the host's secret, not a person's session.
  {
    method: 'GET',
    path: /^\/host\/members\/([^/]+)$/,
    open: true,
    run: async c => {
      const secret = /^Host\s+(.+)$/i.exec(c.authorization ?? '')?.[1];
      const orgId = secret ? await hostBySecret(c.db, secret) : null;
      if (!orgId) throw new ApiError(401, 'Not a registered host.');
      const userId = decodeURIComponent(c.params[0]);
      const m = await roleIn(c.db, orgId, userId).catch(() => null);
      if (!m) throw new ApiError(404, 'Not a member.');
      const u = { name: await displayName(c.db, userId) };
      await c.db.query('UPDATE hosts SET last_seen = $1 WHERE org_id = $2', [Date.now(), orgId]);
      return { role: m.role, name: u?.name ?? '' };
    },
  },

  // The machine hosting it: its owner registers it; members get its public key.
  { method: 'POST', path: /^\/orgs\/([\w-]+)\/host$/, run: async c => registerHost(c.db, c.params[0], c.userId, c.body.publicKey) },
  { method: 'GET', path: /^\/orgs\/([\w-]+)\/host$/, run: async c => ({ host: await hostOf(c.db, c.params[0], c.userId) }) },
];

const MAX_BODY = 64_000;

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new ApiError(413, 'Too much.');
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new ApiError(400, 'Not JSON.');
  }
}

export function createApp(db: Db, auth: Auth) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // The apps call it from anywhere (desktop, mobile, the website); a bearer
    // token, never a cookie, so any origin is fine.
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    const send = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
    if (req.method === 'OPTIONS') return void res.writeHead(204).end();
    try {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const route = ROUTES.find(r => r.method === req.method && r.path.test(path));
      if (!route) return send(404, { error: 'Not found.' });
      const params = (route.path.exec(path) ?? []).slice(1);
      let userId = '';
      if (!route.open) {
        const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
        userId = (token && (await auth.session(token))) || '';
        if (!userId) return send(401, { error: 'Sign in first.' });
      }
      const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
      send(200, await route.run({ db, auth, userId, params, body, authorization: req.headers.authorization }));
    } catch (e) {
      if (e instanceof ApiError) return send(e.status, { error: e.message });
      console.error(e);
      send(500, { error: 'Something went wrong.' });
    }
  };
}
