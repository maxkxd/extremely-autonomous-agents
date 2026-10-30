import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { readMeta } from './files.js';
import { FLEET_ENGINEER } from './runner/agent.js';
import { getSetting, one, run as exec, setSetting } from './runner/db.js';
import { checkSelfToken, SELF_HOSTED } from './selfhost.js';

// Who's asking (docs/architecture.md, "Accounts and organisations"). The host is
// the only authority over its agency, and it checks one thing: an org access
// token - this person, this organisation, this role - short-lived and signed by
// whoever it trusts to issue them (our backend by default; a self-hosted host
// can trust its own). Requests from this computer itself, without one, are the
// host's owner: it's their machine. Anything else is turned away.
//
// What each role may do, decided 2026-10-30:
//   member - see everything; build agents; message, run, stop, start and delete
//            any agent; connect integrations (but not run commands on the host);
//            approvals and requests for agents they made;
//   admin  - everything, including AI model connections, the agency's state,
//            spend caps, the org profile, and what acts on the host's computer;
//   owner  - the same as admin; it's also the machine's own person.

export type Role = 'owner' | 'admin' | 'member';
// here: they're at the host computer itself (what opens there, like an IDE, is in front of them).
export type Actor = { id: string; name: string; role: Role; via: 'local' | 'token'; here?: boolean };

export class AccessError extends Error {
  constructor(
    public status: 401 | 403,
    message: string,
  ) {
    super(message);
  }
}

export const ORG_TOKEN_AUDIENCE = 'eaa-host';

// Who issues the tokens this host accepts, and which organisation it hosts.
// The organisation is set when the owner registers this machine (the app,
// phase 3); until then no token is accepted, only this computer.
type AccessConfig = { issuer: string; orgId: string | null };
const DEFAULT_ISSUER = process.env.EAA_TOKEN_ISSUER ?? 'http://localhost:5180';
// An organisation's agency started by hosting.ts is told both.
export const accessConfig = (): AccessConfig => ({ issuer: DEFAULT_ISSUER, orgId: process.env.EAA_HOSTED_ORG ?? null, ...getSetting<Partial<AccessConfig>>('access', {}) });
export function setAccessConfig(c: Partial<AccessConfig>) {
  const next = { ...accessConfig(), ...c };
  if (!/^https?:\/\/[^\s]+$/.test(next.issuer)) throw new AccessError(403, 'The issuer is an http(s) address.');
  setSetting('access', next);
  return next;
}

// The issuer's published keys, fetched once and refreshed when a token names a new one.
const keySets = new Map<string, JWTVerifyGetKey>();
let keysForTests: JWTVerifyGetKey | null = null;
export const useKeysForTests = (k: JWTVerifyGetKey | null) => void (keysForTests = k);
const keysOf = (issuer: string) => {
  if (keysForTests) return keysForTests;
  let k = keySets.get(issuer);
  if (!k) keySets.set(issuer, (k = createRemoteJWKSet(new URL('/.well-known/jwks.json', issuer))));
  return k;
};

const ROLES: Role[] = ['owner', 'admin', 'member'];

export async function checkToken(token: string): Promise<Actor> {
  // Self-hosted: only tokens this host signed, for accounts it still has.
  if (SELF_HOSTED) return (await checkSelfToken(token)) ?? fail401();
  const { issuer, orgId } = accessConfig();
  if (!orgId) throw new AccessError(401, "This host isn't hosting an organisation yet.");
  let payload;
  try {
    ({ payload } = await jwtVerify(token, keysOf(issuer), { issuer, audience: ORG_TOKEN_AUDIENCE, algorithms: ['EdDSA'] }));
  } catch {
    throw new AccessError(401, 'Sign in again.');
  }
  if (payload.org !== orgId) throw new AccessError(403, 'That token is for another organisation.');
  const role = payload.role as Role;
  if (typeof payload.sub !== 'string' || !ROLES.includes(role)) throw new AccessError(401, 'Sign in again.');
  return { id: payload.sub, name: typeof payload.name === 'string' && payload.name ? payload.name : 'Someone', role, via: 'token' };
}

const fail401 = (): never => {
  throw new AccessError(401, 'Sign in again.');
};

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

// The machine's own person: whoever runs the app on it.
export const localActor = (): Actor => ({ id: 'local', name: getSetting<string | null>('host_person', null) ?? 'The host', role: 'owner', via: 'local', here: true });

// Set by the person's own agency when it passes on a request from this computer
// (index.ts); an organisation's agency listens only on this computer, so only it can.
export const HERE_HEADER = 'x-eaa-here';

export async function actorFor(req: Pick<IncomingMessage, 'headers' | 'socket'>): Promise<Actor> {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1];
  if (token) return { ...(await checkToken(token)), here: !!process.env.EAA_HOSTED_ORG && req.headers[HERE_HEADER] === '1' && LOOPBACK.test(req.socket.remoteAddress ?? '') };
  if (LOOPBACK.test(req.socket.remoteAddress ?? '')) return localActor();
  throw new AccessError(401, 'Sign in first.');
}

// --- The request being served, for code deep down (who made this agent, who decided that) ---

const current = new AsyncLocalStorage<Actor>();
export const asActor = <T>(actor: Actor, fn: () => T) => current.run(actor, fn);
export const currentActor = (): Actor => current.getStore() ?? localActor();
// The person a request is about: from a token, always the token's (never what the body says).
export const personFor = (claimed: string) => {
  const a = currentActor();
  return a.via === 'token' ? a.name : claimed;
};

// --- What each route needs ---

type Level = 'member' | 'admin' | 'local';
const isAdmin = (a: Actor) => a.role === 'owner' || a.role === 'admin';

// Reads are for everyone in the organisation; writes need an admin unless they're
// listed as a member's. "local": only from this computer (where it lands, or what it sets, is the machine itself).
const NEEDS: Record<string, Level> = {
  // The agency MCP address is a key to the whole agency.
  // Everyone's own agency MCP address, acting as them (agency-mcp.ts).
  'GET /api/settings/agency-mcp': 'member',
  'POST /api/settings/agency-mcp': 'member',
  // On the host computer, for a request on an agent they made (runner/api.ts).
  'POST /api/runner/requests/ide': 'member',
  // The secret this organisation's agency asks our backend about members with (hosting.ts).
  'POST /api/settings/host-secret': 'local',
  // A self-hosted organisation's people (selfhost.ts checks who may change what).
  'POST /api/self/setup': 'local',
  'GET /api/self/members': 'member',
  'POST /api/self/role': 'member',
  'POST /api/self/remove': 'member',
  'POST /api/self/leave': 'member',
  'GET /api/self/invites': 'member',
  'POST /api/self/invites': 'member',
  'POST /api/self/invites/revoke': 'member',
  'GET /api/self/address': 'member',
  // Browser sign-ins land on the host's own address.
  'GET /': 'local',
  'GET /api/oauth/openrouter/callback': 'local',
  'GET /api/oauth/chatgpt/callback': 'local',
  'POST /api/settings/host-person': 'local',
  'POST /api/settings/access': 'local',
  // Running an organisation's agency on this computer (hosting.ts).
  'GET /api/hosting': 'local',
  'POST /api/hosting/start': 'local',
  'POST /api/hosting/secret': 'local',
  'POST /api/hosting/stop': 'local',
  'POST /api/hosting/delete': 'local',

  'POST /api/org/turn': 'member',
  'POST /api/org': 'member', // its first save, from a member's first agent; changing it needs an admin (index.ts)
  'POST /api/person': 'member',
  'POST /api/builder/match': 'member',
  'POST /api/builder/turn': 'member',
  'POST /api/builder/build': 'member',
  'POST /api/packs/add': 'member',
  'POST /api/agents': 'member',
  'POST /api/agents/delete': 'member',
  'POST /api/agents/models': 'member',
  'POST /api/models/check': 'member',
  'POST /api/runner/agent': 'member', // a spend cap needs an admin (runner/api.ts)
  'POST /api/runner/run-now': 'member',
  // Their own agents' DMs only, unless an admin (runner/api.ts).
  'POST /api/dm': 'member',
  // The agent's maker, or an admin (requireMakerOrAdmin).
  'POST /api/runner/requests/message': 'member',
  'POST /api/runner/requests/answer': 'member',
  'POST /api/runner/approvals/decide': 'member',
  // A command or a local address runs on the host: an admin's (runner/api.ts).
  'POST /api/integrations/add': 'member',
  'POST /api/integrations/connect': 'member',
  'POST /api/integrations/sign-in': 'member',
  'POST /api/integrations/disconnect': 'member',
  'POST /api/integrations/remove': 'member',
  'POST /api/integrations/webhook-secret': 'member',
};

export function authorize(actor: Actor, method: string, path: string) {
  const need = NEEDS[`${method} ${path}`] ?? (method === 'GET' ? 'member' : 'admin');
  if (need === 'local' && actor.via !== 'local') throw new AccessError(403, 'Only on the host computer itself.');
  if (need === 'admin') requireAdmin(actor);
}

export function requireAdmin(actor = currentActor(), what = 'That') {
  if (!isAdmin(actor)) throw new AccessError(403, `${what} needs an admin.`);
}

// Approvals and requests go to the person who made the agent, or an admin. The
// Agency Engineer's own (a go-live for a request) belong to whoever's agent filed the request;
// the Agency Doctor's (a rule for an agent) to whoever made that agent - forAgent.
// what: the thing being done, for the refusal ("decide this", "see its DMs").
export async function requireMakerOrAdmin(agentId: string, requestId?: number | null, actor = currentActor(), what = 'decide this', forAgent?: string | null) {
  if (isAdmin(actor)) return;
  let id = forAgent ?? agentId;
  if (id === FLEET_ENGINEER && requestId != null) id = one<{ agent_id: string }>('SELECT agent_id FROM requests WHERE id = ?', requestId)?.agent_id ?? id;
  const meta = await readMeta(id);
  if (!meta?.ownerId || meta.ownerId !== actor.id) throw new AccessError(403, `Only the person who made ${meta?.name ?? 'this agent'}, or an admin, can ${what}.`);
}

// --- Who did what ---

// Each change, with what it was about - ids and choices, never keys or what someone wrote.
const ABOUT = ['id', 'agentId', 'packId', 'state', 'decision', 'status', 'ferocity', 'spendCapUsd', 'orgCapUsd', 'on', 'allowed', 'zone'];

export function recordAction(actor: Actor, method: string, path: string, body: unknown, now = Date.now()) {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const about = Object.fromEntries(ABOUT.filter(k => b[k] !== undefined && (typeof b[k] !== 'string' || (b[k] as string).length <= 200)).map(k => [k, b[k]]));
  exec(
    'INSERT INTO person_actions (at, actor_id, actor_name, role, via, route, about) VALUES (?, ?, ?, ?, ?, ?, ?)',
    now,
    actor.id,
    actor.name,
    actor.role,
    actor.via,
    `${method} ${path}`,
    Object.keys(about).length ? JSON.stringify(about) : null,
  );
}
