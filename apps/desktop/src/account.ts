import type { Clerk as ClerkType } from '@clerk/clerk-js';
import { HostOffline, RelayLink } from './relay';

// Who's signed in, which agency the app is in, and where its requests go
// (docs/architecture.md, "Accounts and organisations").
//
// The app works with no account: your own agency is the server on this
// computer. Signing in (our backend, through Clerk) is for organisations. An
// organisation you own runs on this computer beside your own agency, reached
// at /hosted. One hosted on someone else's computer can't be reached from here
// until the relay exists (phase 4).

export const BACKEND = ((import.meta.env.VITE_EAA_BACKEND_URL as string | undefined) ?? 'http://localhost:5180').replace(/\/$/, '');
const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

export type OrgRole = 'owner' | 'admin' | 'member';
export type OrgView = { id: string; kind: 'personal' | 'team'; name: string; role: OrgRole; ownerId: string; host: { registered: boolean; publicKey: string | null } };
export type User = { id: string; email: string; name: string };
export type Member = { userId: string; name: string; email: string; role: OrgRole; joinedAt: number };
export type Invite = { code: string; email: string | null; role: OrgRole; expiresAt: number };
type Hosting = { orgId: string; orgName: string; issuer: string; running: boolean };

// 'personal', or an organisation's id.
const AGENCY_KEY = 'eaa.agency';
const SESSION_KEY = 'eaa.devSession'; // the development sign-in's token
const ME_KEY = 'eaa.me'; // the last answer from the backend, for starting without it

const read = <T>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
};
const write = (key: string, value: unknown) => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: it lasts until the app reloads.
  }
};

export const state = {
  signIn: null as 'clerk' | 'dev' | null, // null: sign-in can't be reached
  issuer: BACKEND,
  me: null as { user: User; orgs: OrgView[] } | null,
  hosting: null as Hosting | null,
  agency: 'personal' as string,
  members: [] as Member[], // the current organisation's
  localName: null as string | null, // this computer's own person, as its agency knows them
  unreachable: null as string | null, // the organisation the app is in can't be reached: why ('offline', or a message)
};

// --- Signing in ---

let clerk: ClerkType | null = null;
async function loadClerk() {
  if (!CLERK_KEY) return null;
  if (!clerk) {
    const { Clerk } = await import('@clerk/clerk-js');
    clerk = new Clerk(CLERK_KEY);
    await clerk.load();
  }
  return clerk;
}

async function sessionToken(): Promise<string | null> {
  if (state.signIn === 'dev') return read<string | null>(SESSION_KEY, null);
  const c = await loadClerk().catch(() => null);
  return (await c?.session?.getToken()) ?? null;
}

export class SignInError extends Error {}

async function backend<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await sessionToken();
  let res: Response;
  try {
    res = await fetch(BACKEND + path, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new SignInError("Can't reach sign-in right now.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new SignInError(data.error ?? 'Something went wrong.');
  return data as T;
}

// Development: sign in by email alone (the backend only allows it without Clerk).
export async function devSignIn(email: string, name: string) {
  const { token } = await backend<{ token: string }>('/dev/sign-in', { body: { email, name } });
  write(SESSION_KEY, token);
  await refreshMe();
}

// Clerk: a code by email. Returns the step to finish it with the code.
export async function emailCode(email: string): Promise<(code: string) => Promise<void>> {
  const c = await loadClerk();
  if (!c?.client) throw new SignInError("Can't reach sign-in right now.");
  const client = c.client;
  const done = async (sessionId: string | null) => {
    if (!sessionId) throw new SignInError('That didn’t finish signing in. Try again.');
    await c.setActive({ session: sessionId });
    await refreshMe();
  };
  try {
    const signIn = await client.signIn.create({ identifier: email });
    const factor = signIn.supportedFirstFactors?.find(f => f.strategy === 'email_code') as { emailAddressId: string } | undefined;
    if (!factor) throw new SignInError('This account signs in another way.');
    await signIn.prepareFirstFactor({ strategy: 'email_code', emailAddressId: factor.emailAddressId });
    return async code => done((await signIn.attemptFirstFactor({ strategy: 'email_code', code })).createdSessionId);
  } catch (e) {
    if (e instanceof SignInError) throw e;
    // No account with that email yet: the same code makes one.
    const signUp = await client.signUp.create({ emailAddress: email }).catch(err => {
      throw new SignInError(clerkMessage(err));
    });
    await signUp.prepareEmailAddressVerification({ strategy: 'email_code' });
    return async code => done((await signUp.attemptEmailAddressVerification({ code }).catch(err => {
      throw new SignInError(clerkMessage(err));
    })).createdSessionId);
  }
}
const clerkMessage = (e: unknown) => (e as { errors?: { message?: string }[] }).errors?.[0]?.message ?? 'That didn’t work. Try again.';

// Google or GitHub: away to the provider, and back to /sso-callback.
export async function signInWith(provider: 'google' | 'github') {
  const c = await loadClerk();
  if (!c?.client) throw new SignInError("Can't reach sign-in right now.");
  await c.client.signIn.authenticateWithRedirect({ strategy: `oauth_${provider}`, redirectUrl: `${location.origin}/sso-callback`, redirectUrlComplete: `${location.origin}/` });
}

export async function signOut() {
  write(SESSION_KEY, null);
  write(ME_KEY, null);
  if (state.signIn === 'clerk') await (await loadClerk().catch(() => null))?.signOut();
  switchAgency('personal');
}

// --- You and your organisations ---

export async function refreshMe() {
  const token = await sessionToken();
  state.me = token ? await backend<{ user: User; orgs: OrgView[] }>('/me').catch(e => (e instanceof SignInError && /Sign in/.test(e.message) ? null : state.me)) : null;
  write(ME_KEY, state.me);
  return state.me;
}

const local = async <T>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
  return data as T;
};

export const teamOrgs = () => (state.me?.orgs ?? []).filter(o => o.kind === 'team');
export const currentOrg = () => teamOrgs().find(o => o.id === state.agency) ?? null;
// The organisation runs here: this computer hosts it.
export const hostedHere = (o: OrgView | null) => !!o && state.hosting?.orgId === o.id;
// The owner or an admin, or your own agency: everything. A member: what the
// host lets members do (apps/server/src/access.ts); the app shows them nothing else.
export const isAdmin = () => currentOrg()?.role !== 'member';
export const ownOrg = () => teamOrgs().find(o => o.role === 'owner') ?? null;

// Startup, before the app draws: everything above, from wherever it can be had.
export async function initAccount() {
  if (location.pathname === '/sso-callback') {
    const c = await loadClerk().catch(() => null);
    await c?.handleRedirectCallback({ signInUrl: '/', signUpUrl: '/' }, async to => history.replaceState(null, '', to)).catch(() => {});
    history.replaceState(null, '', '/');
  }
  state.agency = read(AGENCY_KEY, 'personal');
  state.me = read(ME_KEY, null);
  const [config, hosting, access] = await Promise.all([
    backend<{ signIn: 'clerk' | 'dev'; issuer: string }>('/config').catch(() => null),
    local<{ hosting: Hosting | null }>('/api/hosting').catch(() => ({ hosting: null })),
    local<{ you: { name: string } }>('/api/access').catch(() => null),
  ]);
  state.localName = access && access.you.name !== 'The host' ? access.you.name : null;
  state.signIn = config?.signIn ?? null;
  state.issuer = config?.issuer ?? BACKEND;
  state.hosting = hosting.hosting;
  if (state.signIn) await refreshMe().catch(() => {});
  // Hosted here but never registered (starting it was cut short): finish now.
  const unregistered = ownOrg();
  if (unregistered && state.hosting?.orgId === unregistered.id && !unregistered.host.registered) void hostHere(unregistered).then(refreshMe).catch(() => {});
  if (state.agency !== 'personal' && !currentOrg()) state.agency = 'personal';
  const org = currentOrg();
  if (org) state.members = await backend<Member[]>(`/orgs/${org.id}/members`).catch(() => []);
  // Hosted elsewhere: reached through the relay, if its host is online.
  if (org) state.unreachable = await reachable();
}

// Moving between agencies starts the app afresh in the other one.
export function switchAgency(id: string) {
  write(AGENCY_KEY, id);
  location.reload();
}

// Each agency keeps its own things in this browser (its card order, its agents' details).
export const scoped = (key: string) => (state.agency === 'personal' ? key : `${key}@${state.agency}`);

// --- Requests to the agency the app is in ---

// Org access tokens (15 minutes), fetched as needed.
const tokens = new Map<string, { token: string; expiresAt: number }>();
async function orgToken(orgId: string) {
  const had = tokens.get(orgId);
  if (had && had.expiresAt - Date.now() > 60_000) return had.token;
  const t = await backend<{ token: string; expiresAt: number }>(`/orgs/${orgId}/token`, { method: 'POST' });
  tokens.set(orgId, t);
  return t.token;
}

// Testing the relay on one computer: go through it even to the organisation this
// computer hosts (localStorage eaa.viaRelay = "1").
const viaRelay = () => read<string | null>('eaa.viaRelay', null) === '1';
export const reachedHere = (o: OrgView | null) => hostedHere(o) && !viaRelay();

// Organisations hosted elsewhere: one encrypted link each, through our relay (relay.ts).
const links = new Map<string, RelayLink>();
const linkTo = (o: OrgView) => {
  if (!o.host.publicKey) throw new HostOffline(`${o.name} isn't hosted anywhere yet.`);
  let l = links.get(o.id);
  if (!l) links.set(o.id, (l = new RelayLink(BACKEND, o.id, o.host.publicKey, sessionToken)));
  return l;
};

// A request for "/api/..." to the agency the app is in: your own as is; the
// organisation this computer hosts through /hosted, as its owner (this computer)
// or, for anyone else signed in here, with their org access token; one hosted
// elsewhere through the relay, with your org access token inside it.
export async function agencyFetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const org = currentOrg();
  if (!org) return fetch(path, init);
  if (reachedHere(org)) {
    const auth: Record<string, string> = org.role === 'owner' ? {} : { authorization: `Bearer ${await orgToken(org.id)}` };
    return fetch(`/hosted${path}`, { ...init, headers: { ...init.headers, ...auth } });
  }
  return linkTo(org).request(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${await orgToken(org.id)}` } });
}

// Whether the organisation the app is in can be reached now (startup): here, or
// its host through the relay. null: it can; otherwise why not.
export async function reachable(): Promise<string | null> {
  const org = currentOrg();
  if (!org || reachedHere(org)) return null;
  try {
    await linkTo(org).open();
    return null;
  } catch (e) {
    return e instanceof HostOffline ? 'offline' : (e as Error).message;
  }
}

// --- Organisations ---

// Make one, hosted on this computer: the directory entry, the agency beside
// yours, its key registered so members' apps can reach it.
export async function createOrganisation(name: string, onStep?: (s: string) => void) {
  onStep?.('Creating it');
  const org = await backend<{ id: string; name: string }>('/orgs', { body: { name } });
  onStep?.('Starting its agency on this computer');
  await hostHere(org);
  // The profile the chat just made (saved in your own agency) belongs to the organisation's.
  const { profile } = await local<{ profile: unknown }>(`/api/org?name=${encodeURIComponent(org.name)}`);
  if (profile) await local('/hosted/api/org', { org: org.name, profile }).catch(() => {});
  await refreshMe();
  return org;
}

// Your organisation's agency, started on this computer and registered as its host.
// Also for one whose creation stopped part-way.
export async function hostHere(org: { id: string; name: string }) {
  const { publicKey } = await local<{ publicKey: string }>('/api/hosting/start', { orgId: org.id, orgName: org.name, issuer: state.issuer });
  const { hostSecret } = await backend<{ hostSecret: string }>(`/orgs/${org.id}/host`, { body: { publicKey } });
  await local('/api/hosting/secret', { orgId: org.id, hostSecret });
  for (let i = 0; i < 60; i++) {
    const h = (await local<{ hosting: Hosting | null }>('/api/hosting')).hosting;
    if (h?.running) break;
    await new Promise(r => setTimeout(r, 500));
  }
}

export const previewInvite =(code: string) => backend<{ org: string; invitedBy: string; role: OrgRole; forEmail: string | null }>(`/invites/${encodeURIComponent(code)}`);
export async function joinWithCode(code: string) {
  const r = await backend<{ orgId: string; name: string }>(`/invites/${encodeURIComponent(code)}/accept`, { method: 'POST' });
  await refreshMe();
  return r;
}

export const members = (orgId: string) => backend<Member[]>(`/orgs/${orgId}/members`);
export const setRole = (orgId: string, userId: string, role: 'admin' | 'member') => backend(`/orgs/${orgId}/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { role } });
export const removeMember = (orgId: string, userId: string) => backend(`/orgs/${orgId}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
export const invites = (orgId: string) => backend<Invite[]>(`/orgs/${orgId}/invites`);
export const createInvite = (orgId: string, email: string, role: 'admin' | 'member') => backend<Invite>(`/orgs/${orgId}/invites`, { body: { email, role } });
export const revokeInvite = (code: string) => backend(`/invites/${encodeURIComponent(code)}`, { method: 'DELETE' });
export async function leaveOrganisation(orgId: string) {
  await backend(`/orgs/${orgId}/leave`, { method: 'POST' });
  await refreshMe();
}
// Its agency here stops; its folder is kept.
export async function deleteOrganisation(orgId: string) {
  await backend(`/orgs/${orgId}`, { method: 'DELETE' });
  if (state.hosting?.orgId === orgId) await local('/api/hosting/stop', {});
  await refreshMe();
}
