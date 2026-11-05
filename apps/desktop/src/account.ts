import type { Clerk as ClerkType } from '@clerk/clerk-js';
import { HostOffline, RelayLink } from './relay';

// Who's signed in, which agency the app is in, and where its requests go
// (docs/architecture.md, "Accounts and organizations").
//
// The app works with no account: your own agency is the server on this
// computer. Signing in (our backend, through Clerk) is for organizations. An
// organization you own runs on this computer beside your own agency, reached
// at /hosted. One hosted on someone else's computer can't be reached from here
// until the relay exists (phase 4).

export const BACKEND = ((import.meta.env.VITE_EAA_BACKEND_URL as string | undefined) ?? 'http://localhost:5180').replace(/\/$/, '');
const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

export type OrgRole = 'owner' | 'admin' | 'member';
// self: self-hosted - its own accounts, reached at its own address, never through us (selfhost.ts on its host).
export type OrgView = { id: string; kind: 'personal' | 'team'; name: string; role: OrgRole; ownerId: string; host: { registered: boolean; publicKey: string | null }; self?: { address: string } };
export type User = { id: string; email: string; name: string };
export type Member = { userId: string; name: string; email: string; role: OrgRole; joinedAt: number };
// sent: emailed to them; url: the link, when it wasn't (no mail service set up yet).
export type Invite = { code: string; email: string | null; role: OrgRole; expiresAt: number; sent?: boolean; url?: string };
export type WaitingInvite = { code: string; orgId: string; org: string; invitedBy: string; role: OrgRole; expiresAt: number };
type Hosting = { orgId: string; orgName: string; issuer: string; running: boolean; self?: boolean };

// 'personal', or an organization's id.
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
  members: [] as Member[], // the current organization's
  localName: null as string | null, // this computer's own person, as its agency knows them
  localFullName: null as string | null, // the name they chose, when not signed in (their agency's profile of them)
  unreachable: null as string | null, // the organization the app is in can't be reached: why ('offline', or a message)
  // This page is the browser half of the desktop app's Google/GitHub sign-in:
  // what to show instead of the app (signInWith).
  handoff: null as null | 'done' | { error: string },
};

// --- Signing in ---

// Clerk keeps who's signed in in a token we hold, sent as a header, not in its
// cookie: production Clerk's cookie is same-site to extremely.agency, and the
// app runs at 127.0.0.1, so the cookie would never be sent back.
const CLERK_CLIENT_KEY = 'eaa.clerkClient';
let clerk: Promise<ClerkType> | null = null;
async function loadClerk() {
  if (!CLERK_KEY) return null;
  clerk ??= (async () => {
    const { Clerk } = await import('@clerk/clerk-js');
    const c = new Clerk(CLERK_KEY);
    // Back from Google/GitHub: their sign-in reaches this token only once it's
    // swapped with the nonce Clerk lands with, on the first fetch of the client.
    let nonce = new URLSearchParams(location.search).get('rotating_token_nonce');
    c.__internal_onBeforeRequest(req => {
      req.credentials = 'omit';
      req.url?.searchParams.append('_is_native', '1');
      if (nonce && req.url?.pathname.endsWith('/client') && req.method === 'GET') {
        req.url.searchParams.append('rotating_token_nonce', nonce);
        nonce = null;
      }
      (req.headers as Headers).set('authorization', read<string>(CLERK_CLIENT_KEY, ''));
    });
    c.__internal_onAfterResponse((_req, res) => {
      const token = res?.headers.get('authorization');
      if (token) write(CLERK_CLIENT_KEY, token);
    });
    await c.load({ standardBrowser: false });
    return c;
  })().catch(e => {
    clerk = null;
    throw e;
  });
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
// mode 'up': a new account (an email that has one is refused, not signed into and renamed).
export async function devSignIn(email: string, name: string, mode: 'in' | 'up' = 'in') {
  const { token } = await backend<{ token: string }>('/dev/sign-in', { body: { email, name, mode } });
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

// The desktop app's own window (apps/electron), not a browser.
export const inDesktopApp = /\bElectron\//.test(navigator.userAgent);

// Google or GitHub: away to the provider, and back to /sso-callback. In the
// desktop app they refuse the embedded window, so the person's own browser
// opens this same address, signs in there, and hands a single-use ticket back
// through this computer's agency (apps/server/src/handoff.ts); this resolves
// once the app is signed in with it, or quietly when stopped (Cancel).
export async function signInWith(provider: 'google' | 'github', stop?: AbortSignal) {
  const c = await loadClerk();
  if (!c?.client) throw new SignInError("Can't reach sign-in right now.");
  if (!inDesktopApp) {
    await c.client.signIn.authenticateWithRedirect({ strategy: `oauth_${provider}`, redirectUrl: `${location.origin}/sso-callback`, redirectUrlComplete: `${location.origin}/` });
    return;
  }
  const { state: code } = await local<{ state: string }>('/api/auth/handoff', {});
  window.open(`${location.origin}/?handoff=${provider}&state=${encodeURIComponent(code)}`, '_blank');
  const until = Date.now() + 10 * 60_000;
  while (Date.now() < until) {
    await new Promise(r => setTimeout(r, 1500));
    if (stop?.aborted) return;
    const got = await local<{ ticket: string | null; expired: boolean }>(`/api/auth/handoff/ticket?state=${encodeURIComponent(code)}`).catch(() => null);
    if (got?.expired) break;
    if (!got?.ticket) continue;
    const signIn = await c.client.signIn.create({ strategy: 'ticket', ticket: got.ticket }).catch(err => {
      throw new SignInError(clerkMessage(err));
    });
    if (!signIn.createdSessionId) throw new SignInError('That didn’t finish signing in. Try again.');
    await c.setActive({ session: signIn.createdSessionId });
    await refreshMe();
    return;
  }
  throw new SignInError('Signing in in the browser timed out. Try again.');
}

// The browser half (opened by the desktop app with ?handoff=<provider>&state=):
// sign in as on the web, then hand the app a ticket and sign this browser back out.
// The handoff's state rides along in /sso-callback's address (comingBack): the
// tab's sessionStorage doesn't reliably survive the trip through the provider.
async function browserHandoff(comingBack: string | null) {
  const params = new URLSearchParams(location.search);
  const provider = params.get('handoff');
  let pendingCode = comingBack;
  if ((provider === 'google' || provider === 'github') && params.get('state')) {
    pendingCode = params.get('state')!;
    const c = await loadClerk();
    if (!c?.client) return void (state.handoff = { error: "Can't reach sign-in right now." });
    if (!c.session) {
      // Off to the provider; this page comes back at /sso-callback - either
      // address, as Clerk lands finished sign-ins on the "complete" one directly.
      const back = `${location.origin}/sso-callback?handoff_state=${encodeURIComponent(pendingCode)}`;
      await c.client.signIn
        .authenticateWithRedirect({ strategy: `oauth_${provider}`, redirectUrl: back, redirectUrlComplete: back })
        .catch(err => void (state.handoff = { error: clerkMessage(err) }));
      return;
    }
  }
  if (!pendingCode) return;
  try {
    const c = await loadClerk();
    if (!c?.session) throw new SignInError('Signing in didn’t finish. Try again from the app.');
    const { ticket } = await backend<{ ticket: string }>('/me/sign-in-ticket', { method: 'POST' });
    await local('/api/auth/handoff/ticket', { state: pendingCode, ticket });
    // Signing out leaves the page (to / by default, the whole app): to the end of this one instead.
    await c.signOut({ redirectUrl: `${location.origin}/?handoff=done` }).catch(() => {});
    state.handoff = 'done';
  } catch (e) {
    state.handoff = { error: (e as Error).message };
  }
}

// Organizations' snapshots (offline copies) in this browser: one, or all.
function forgetSnapshots(orgId?: string) {
  try {
    for (const k of Object.keys(localStorage)) if (orgId ? k === `eaa.snapshot@${orgId}` : k.startsWith('eaa.snapshot@')) localStorage.removeItem(k);
  } catch {
    // Storage unavailable: nothing kept.
  }
}

export async function signOut() {
  write(SESSION_KEY, null);
  write(ME_KEY, null);
  // What organizations showed stays with the person, not the browser.
  forgetSnapshots();
  if (state.signIn === 'clerk') await (await loadClerk().catch(() => null))?.signOut();
  switchAgency('personal');
}

// --- You and your organizations ---

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

// Every organization you're in: ours (signed in with us), the one this computer
// self-hosts, and self-hosted ones you've joined elsewhere.
// --- Your name ---
//
// The one you go by everywhere: signed in, the one on your account with us
// (your organizations see it); signed out, only a name you gave yourself here -
// not whoever last signed in on this computer ("Sam Rivera · Not signed in").
const accountEmail = () => state.me?.user.email ?? null;
export const myName = () => state.me?.user.name || state.localFullName || 'You';
const nameListeners = new Set<() => void>();
export const onMyName = (l: () => void) => (nameListeners.add(l), () => void nameListeners.delete(l));
export async function setMyName(name: string) {
  state.localFullName = name.trim() || null;
  if (state.me) {
    const r = await backend<{ user: User }>('/me', { method: 'PATCH', body: { name } });
    state.me = { ...state.me, user: r.user };
    write(ME_KEY, state.me);
  }
  nameListeners.forEach(l => l());
}
// Self-hosted organizations you've joined, and the account you have in each.
export const selfAccounts = () => selfOrgs().map(s => ({ id: s.id, org: s.name, email: s.you.email, address: s.address }));
export function signOutOfSelf(orgId: string) {
  const s = selfOrgs().find(x => x.id === orgId);
  if (s) void fetch(`${s.address}/hosted/auth/sign-out`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: s.session }) }).catch(() => {});
  saveSelfOrgs(selfOrgs().filter(x => x.id !== orgId));
  forgetSnapshots(orgId);
  if (state.agency === orgId) switchAgency('personal');
}

export const teamOrgs = (): OrgView[] => {
  const hostingSelf: OrgView[] = state.hosting?.self
    ? [{ id: state.hosting.orgId, kind: 'team', name: state.hosting.orgName, role: 'owner', ownerId: 'local', host: { registered: true, publicKey: null }, self: { address: '' } }]
    : [];
  // Testing on one computer (eaa.viaRelay): as a member at its address, not as its host.
  const joined = selfOrgs()
    .filter(s => viaRelay() || !hostingSelf.some(h => h.id === s.id))
    .map((s): OrgView => ({ id: s.id, kind: 'team', name: s.name, role: s.role, ownerId: '', host: { registered: true, publicKey: null }, self: { address: s.address } }));
  return [...(state.me?.orgs ?? []).filter(o => o.kind === 'team'), ...hostingSelf.filter(h => !joined.some(j => j.id === h.id)), ...joined];
};

// --- Self-hosted organizations you've joined (their own accounts; never us) ---

type SelfOrg = { id: string; name: string; address: string; session: string; role: OrgRole; you: { id: string; email: string; name: string } };
const SELF_KEY = 'eaa.selfOrgs';
const selfOrgs = () => read<SelfOrg[]>(SELF_KEY, []);
const saveSelfOrgs = (l: SelfOrg[]) => write(SELF_KEY, l);
const selfTokens = new Map<string, { token: string; expiresAt: number }>();

// Its session, for a fresh org token from its host (and your role there, as it is now).
async function selfToken(o: OrgView) {
  const s = selfOrgs().find(x => x.id === o.id);
  if (!s) throw new Error(`Sign in to ${o.name} again.`);
  const had = selfTokens.get(o.id);
  if (had && had.expiresAt - Date.now() > 60_000) return had.token;
  let res: Response;
  try {
    res = await fetch(`${s.address}/hosted/auth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: s.session }) });
  } catch {
    throw new HostOffline(`${s.name}'s host can't be reached.`);
  }
  const data = (await res.json().catch(() => ({}))) as { token?: string; expiresAt?: number; error?: string; you?: { role: OrgRole } };
  if (res.status === 401) throw new Error(data.error ?? `Sign in to ${s.name} again.`);
  if (!res.ok || !data.token) throw new HostOffline(data.error ?? `${s.name}'s host isn't answering.`);
  selfTokens.set(o.id, { token: data.token, expiresAt: data.expiresAt ?? Date.now() + 60_000 });
  if (data.you && data.you.role !== s.role) saveSelfOrgs(selfOrgs().map(x => (x.id === s.id ? { ...x, role: data.you!.role } : x)));
  return data.token;
}

const cleanAddress = (a: string) => {
  const v = a.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/.test(v)) throw new Error('Its address, like https://agency.example.com');
  return v;
};
async function hostAuth<T>(address: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${cleanAddress(address)}/hosted/auth/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error("Can't reach that address.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "That address didn't answer like an organization's host.");
  return data as T;
}
type Joined = { session: string; org: { id: string; name: string }; you: SelfOrg['you'] & { role: OrgRole } };
const keepJoined = (address: string, r: Joined) => {
  saveSelfOrgs([...selfOrgs().filter(x => x.id !== r.org.id), { id: r.org.id, name: r.org.name, address: cleanAddress(address), session: r.session, role: r.you.role, you: r.you }]);
  return r.org;
};
// Your account's id in a self-hosted organization (the owner here: its owner's).
export const selfMe = (o: OrgView) => {
  const s = selfOrgs().find(x => x.id === o.id);
  if (s) return s.you.id;
  return o.role === 'owner' && hostedHere(o) ? (state.members.find(m => m.role === 'owner')?.userId ?? null) : null;
};
export const previewSelfInvite = (address: string, code: string) =>
  hostAuth<{ org: string; role: OrgRole; forEmail: string | null }>(address, `invite?code=${encodeURIComponent(code.trim())}`);
export const joinSelf = async (address: string, b: { code: string; email: string; name: string; password: string }) =>
  keepJoined(address, await hostAuth<Joined>(address, 'accept', { ...b, code: b.code.trim() }));
export const signInSelf = async (address: string, email: string, password: string) => keepJoined(address, await hostAuth<Joined>(address, 'sign-in', { email, password }));

// Self-host one on this computer: its own accounts, starting with yours as owner.
export const selfHost = (orgName: string, owner: { email: string; name: string; password: string }) =>
  local<{ orgId: string; orgName: string }>('/api/hosting/self', { orgName, owner });
export const currentOrg = () => teamOrgs().find(o => o.id === state.agency) ?? null;
// The organization runs here: this computer hosts it.
export const hostedHere = (o: OrgView | null) => !!o && state.hosting?.orgId === o.id;
// The owner or an admin, or your own agency: everything. A member: what the
// host lets members do (apps/server/src/access.ts); the app shows them nothing else.
export const isAdmin = () => currentOrg()?.role !== 'member';
// Your account in the organization the app is in (with us, or its own when self-hosted).
export const myAccountId = () => {
  const o = currentOrg();
  return o?.self ? selfMe(o) : (state.me?.user.id ?? null);
};
export const ownOrg = () => teamOrgs().find(o => o.role === 'owner') ?? null;

// Startup, before the app draws: everything above, from wherever it can be had.
export async function initAccount() {
  const comingBack = location.pathname === '/sso-callback' ? new URLSearchParams(location.search).get('handoff_state') : null;
  if (location.pathname === '/sso-callback') {
    const c = await loadClerk().catch(() => null);
    await c?.handleRedirectCallback({ signInUrl: '/', signUpUrl: '/' }, async to => history.replaceState(null, '', to)).catch(() => {});
    history.replaceState(null, '', '/');
  }
  // The browser half of the desktop app's sign-in: nothing else on this page.
  if (!inDesktopApp) {
    await browserHandoff(comingBack);
    if (state.handoff || comingBack || new URLSearchParams(location.search).has('handoff')) return;
  }
  state.agency = read(AGENCY_KEY, 'personal');
  state.me = read(ME_KEY, null);
  const [config, hosting, access] = await Promise.all([
    backend<{ signIn: 'clerk' | 'dev'; issuer: string }>('/config').catch(() => null),
    local<{ hosting: Hosting | null }>('/api/hosting').catch(() => ({ hosting: null })),
    local<{ you: { name: string } }>('/api/access').catch(() => null),
  ]);
  state.localName = access && access.you.name !== 'The host' ? access.you.name : null;
  const person = state.localName
    ? ((await local<{ person: ({ full_name?: string; email?: string } & Record<string, unknown>) | null }>(`/api/person?name=${encodeURIComponent(state.localName)}`).catch(() => null))?.person ?? null)
    : null;
  state.localFullName = person?.full_name?.trim() || null;
  state.signIn = config?.signIn ?? null;
  state.issuer = config?.issuer ?? BACKEND;
  state.hosting = hosting.hosting;
  if (state.signIn) await refreshMe().catch(() => {});
  // Signed in: the email you sign in with is the one your agents reach you at.
  const email = accountEmail();
  if (person && email && person.email !== email) void local('/api/person', { profile: { ...person, email } }).catch(() => {});
  // Hosted here but never registered (starting it was cut short): finish now.
  const unregistered = ownOrg();
  if (unregistered && state.hosting?.orgId === unregistered.id && !unregistered.host.registered) void hostHere(unregistered).then(refreshMe).catch(() => {});
  if (state.agency !== 'personal' && !currentOrg()) state.agency = 'personal';
  const org = currentOrg();
  // Hosted elsewhere: reached through the relay (or its own address), if its host is online.
  if (org) state.unreachable = await reachable();
  if (org && !state.unreachable) state.members = await members(org.id).catch(() => []);
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
// One fetch at a time per organization: a page load's twenty requests each fetched their own.
const fetching = new Map<string, Promise<string>>();
async function orgToken(orgId: string) {
  const had = tokens.get(orgId);
  if (had && had.expiresAt - Date.now() > 60_000) return had.token;
  let pending = fetching.get(orgId);
  if (!pending) {
    pending = backend<{ token: string; expiresAt: number }>(`/orgs/${orgId}/token`, { method: 'POST' })
      .then(t => (tokens.set(orgId, t), t.token))
      .finally(() => fetching.delete(orgId));
    fetching.set(orgId, pending);
  }
  return pending;
}

// Testing the relay on one computer: go through it even to the organization this
// computer hosts (localStorage eaa.viaRelay = "1").
const viaRelay = () => read<string | null>('eaa.viaRelay', null) === '1';
export const reachedHere = (o: OrgView | null) => hostedHere(o) && !viaRelay();

// Organizations hosted elsewhere: one encrypted link each, through our relay (relay.ts).
const links = new Map<string, RelayLink>();
const linkTo = (o: OrgView) => {
  if (!o.host.publicKey) throw new HostOffline(`${o.name} isn't hosted anywhere yet.`);
  let l = links.get(o.id);
  if (!l) links.set(o.id, (l = new RelayLink(BACKEND, o.id, o.host.publicKey, sessionToken)));
  return l;
};

// A request for "/api/..." to the agency the app is in: your own as is; the
// organization this computer hosts through /hosted, as its owner (this computer)
// or, for anyone else signed in here, with their org access token; one hosted
// elsewhere through the relay, with your org access token inside it.
// An organization hosted elsewhere: a sign-in to a service (Gmail, Notion...) comes back
// to this computer's app (oauth.ts), which holds it; this app sends it to the host
// through the relay and tells the waiting page how it went. Started with each sign-in,
// for as long as the sign-in can last. (Hosted here: the server hands it over itself.)
let handingOff: number | null = null;
export function handOffSignIns(minutes = 35) {
  const org = currentOrg();
  if (!org || reachedHere(org)) return;
  if (handingOff) window.clearInterval(handingOff);
  const until = Date.now() + minutes * 60_000;
  handingOff = window.setInterval(async () => {
    if (Date.now() > until) {
      window.clearInterval(handingOff!);
      handingOff = null;
      return;
    }
    const waiting = await local<{ state: string; query: string }[]>('/api/oauth/held').catch(() => []);
    for (const h of waiting) {
      const r = (await agencyFetch(`/api/oauth/finish?${h.query}`)
        .then(res => res.json())
        .catch(e => ({ ok: false, message: (e as Error).message }))) as { ok?: boolean; message?: string };
      await local('/api/oauth/held/result', { state: h.state, ok: !!r.ok, message: String(r.message ?? '') }).catch(() => {});
    }
  }, 1500);
}

export async function agencyFetch(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  const org = currentOrg();
  if (!org) return fetch(path, init);
  if (reachedHere(org)) {
    const auth: Record<string, string> = org.role === 'owner' ? {} : { authorization: `Bearer ${org.self ? await selfToken(org) : await orgToken(org.id)}` };
    return fetch(`/hosted${path}`, { ...init, headers: { ...init.headers, ...auth } });
  }
  // Offline: what was last seen, trying the host again every so often.
  if (offline.since && Date.now() - offline.tried < RETRY_OFFLINE) return fromSnapshot(path, init.method);
  offline.tried = Date.now();
  try {
    const res = await remote(org, path, init);
    setOffline(null);
    if ((init.method ?? 'GET') === 'GET' && res.ok) remember(path, await res.clone().text(), res.headers.get('content-type') ?? 'application/json');
    return res;
  } catch (e) {
    if (!(e instanceof HostOffline)) throw e;
    setOffline(offline.since ?? snapshotAt() ?? Date.now());
    return fromSnapshot(path, init.method);
  }
}

// An organization hosted elsewhere: through our relay, or a self-hosted one at its own address.
async function remote(org: OrgView, path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) {
  if (!org.self) return linkTo(org).request(path, { ...init, headers: { ...init.headers, authorization: `Bearer ${await orgToken(org.id)}` } });
  const address = selfOrgs().find(x => x.id === org.id)?.address ?? '';
  const authorization = `Bearer ${await selfToken(org)}`;
  try {
    return await fetch(`${address}/hosted${path}`, { ...init, headers: { ...init.headers, authorization } });
  } catch {
    throw new HostOffline(`${org.name}'s host can't be reached.`);
  }
}

// --- When the host is offline (docs/architecture.md) ---
//
// An organization hosted elsewhere: the app keeps the last answer to each of its
// reads, in this browser. While the host can't be reached the app shows those,
// greyed out ("Host offline since ..."), changes are refused, and it tries the
// host again every few seconds; when it's back, everything's live again.

const RETRY_OFFLINE = 10_000;
type Snap = { at: number; reads: Record<string, { body: string; type: string }> };
let snap: Snap | null = null;
const snapKey = () => `eaa.snapshot@${state.agency}`;
const loadSnap = () => (snap ??= read<Snap | null>(snapKey(), null) ?? { at: 0, reads: {} });
const snapshotAt = () => loadSnap().at || null;
export const hasSnapshot = () => Object.keys(loadSnap().reads).length > 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function remember(path: string, body: string, type: string) {
  const s = loadSnap();
  s.at = Date.now();
  if (s.reads[path]?.body === body) return;
  s.reads[path] = { body, type };
  // Written a moment later, once, however many reads land together.
  saveTimer ??= setTimeout(() => {
    saveTimer = null;
    write(snapKey(), s);
  }, 1000);
}
function fromSnapshot(path: string, method = 'GET'): Response {
  const had = method === 'GET' ? loadSnap().reads[path] : undefined;
  if (had) return new Response(had.body, { status: 200, headers: { 'content-type': had.type, 'x-eaa-snapshot': '1' } });
  const error = method === 'GET' ? "The host is offline, and this wasn't seen before it went." : "The host is offline. This can be done once it's back.";
  return new Response(JSON.stringify({ error }), { status: 503, headers: { 'content-type': 'application/json' } });
}

export const offline = { since: null as number | null, tried: 0 };
const offlineListeners = new Set<() => void>();
function setOffline(since: number | null) {
  if (offline.since === since) return;
  offline.since = since;
  offlineListeners.forEach(l => l());
}
export const onOffline = (l: () => void) => (offlineListeners.add(l), () => void offlineListeners.delete(l));

// Whether the organization the app is in can be reached now (startup): here, or
// its host through the relay. null: it can; otherwise why not.
export async function reachable(): Promise<string | null> {
  const org = currentOrg();
  if (!org || reachedHere(org)) return null;
  try {
    if (org.self) await selfToken(org);
    else await linkTo(org).open();
    return null;
  } catch (e) {
    if (!(e instanceof HostOffline)) return (e as Error).message;
    // Seen before: open it as it was then, greyed out, until the host is back.
    if (!hasSnapshot()) return 'offline';
    setOffline(snapshotAt() ?? Date.now());
    return null;
  }
}

// --- Organizations ---

// Make one, hosted on this computer: the directory entry, the agency beside
// yours, its key registered so members' apps can reach it.
export async function createOrganisation(name: string, onStep?: (s: string) => void) {
  onStep?.('Creating it');
  const org = await backend<{ id: string; name: string }>('/orgs', { body: { name } });
  onStep?.('Starting its agency on this computer');
  await hostHere(org);
  // The profile the chat just made (saved in your own agency) belongs to the organization's.
  const { profile } = await local<{ profile: unknown }>(`/api/org?name=${encodeURIComponent(org.name)}`).catch(() => ({ profile: null }));
  if (profile) await local('/hosted/api/org', { org: org.name, profile }).catch(() => {});
  await refreshMe();
  return org;
}

// Your organization's agency, started on this computer and registered as its host.
// Also for one whose creation stopped part-way.
export async function hostHere(org: { id: string; name: string }) {
  const { publicKey } = await local<{ publicKey: string }>('/api/hosting/start', { orgId: org.id, orgName: org.name, issuer: state.issuer });
  const { hostSecret } = await backend<{ hostSecret: string }>(`/orgs/${org.id}/host`, { body: { publicKey } });
  await local('/api/hosting/secret', { orgId: org.id, hostSecret });
  // Waits for it to be up, riding out a moment where this computer's agency
  // isn't answering (it restarting) instead of failing the whole creation.
  for (let i = 0; i < 60; i++) {
    const h = await local<{ hosting: Hosting | null }>('/api/hosting').then(r => r.hosting, () => null);
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

// A self-hosted organization's people are on its host (/api/self/...), through the agency the app is in.
const isSelf = (orgId: string) => !!teamOrgs().find(o => o.id === orgId)?.self;
async function viaHost<T>(path: string, body?: unknown): Promise<T> {
  const res = await agencyFetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? 'Something went wrong.');
  return data as T;
}
export const members = (orgId: string) => (isSelf(orgId) ? viaHost<Member[]>('/api/self/members') : backend<Member[]>(`/orgs/${orgId}/members`));
export const setRole = (orgId: string, userId: string, role: 'admin' | 'member') =>
  isSelf(orgId) ? viaHost('/api/self/role', { userId, role }) : backend(`/orgs/${orgId}/members/${encodeURIComponent(userId)}`, { method: 'PATCH', body: { role } });
export const removeMember = (orgId: string, userId: string) =>
  isSelf(orgId) ? viaHost('/api/self/remove', { userId }) : backend(`/orgs/${orgId}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
export const invites = (orgId: string) => (isSelf(orgId) ? viaHost<Invite[]>('/api/self/invites') : backend<Invite[]>(`/orgs/${orgId}/invites`));
export const createInvite = (orgId: string, email: string, role: 'admin' | 'member') =>
  isSelf(orgId) ? viaHost<Invite>('/api/self/invites', { email, role }) : backend<Invite>(`/orgs/${orgId}/invites`, { body: { email, role } });
// Invites waiting for you (by your email), and turning one down.
export const myInvites = () => (state.me ? backend<WaitingInvite[]>('/me/invites') : Promise.resolve([]));
export const declineInvite = (code: string) => backend(`/invites/${encodeURIComponent(code)}/decline`, { method: 'POST' });

// How many invites are waiting for you: a dot on your profile, on Settings in its
// menu and on Organization in Settings (decided 2026-11-02) - only Settings >
// Organization showed one, so a teammate signed in and never saw it. Checked while
// signed in, every 30 seconds and whenever one is answered.
let waitingCount = 0;
const waitingListeners = new Set<() => void>();
export const waitingInvites = () => waitingCount;
export const onWaitingInvites = (l: () => void) => (waitingListeners.add(l), () => void waitingListeners.delete(l));
export async function checkWaitingInvites() {
  const n = state.me ? ((await myInvites().catch(() => null))?.length ?? waitingCount) : 0;
  if (n === waitingCount) return;
  waitingCount = n;
  waitingListeners.forEach(l => l());
}
setInterval(() => void checkWaitingInvites(), 30_000);
export const revokeInvite = (code: string) =>
  isSelf(state.agency) ? viaHost('/api/self/invites/revoke', { code }) : backend(`/invites/${encodeURIComponent(code)}`, { method: 'DELETE' });
// The address a self-hosted organization's members reach it at (its owner sets it).
export const selfAddress = () => viaHost<{ address: string | null }>('/api/self/address').then(r => r.address);
export const setSelfAddress = (address: string) => viaHost<{ address: string | null }>('/api/self/address', { address }).then(r => r.address);
export async function leaveOrganisation(orgId: string) {
  if (isSelf(orgId)) {
    await viaHost('/api/self/leave', {});
    saveSelfOrgs(selfOrgs().filter(x => x.id !== orgId));
  } else await backend(`/orgs/${orgId}/leave`, { method: 'POST' });
  forgetSnapshots(orgId);
  await refreshMe();
}
// Gone for everyone, and nothing of it stays on this computer: its agency and
// folder here, and what this app kept for it (offline copy, layout, drafts).
export async function deleteOrganisation(orgId: string) {
  if (!isSelf(orgId)) await backend(`/orgs/${orgId}`, { method: 'DELETE' });
  await local('/api/hosting/delete', { orgId });
  if (isSelf(orgId)) saveSelfOrgs(selfOrgs().filter(x => x.id !== orgId));
  try {
    for (const k of Object.keys(localStorage)) if (k.endsWith(`@${orgId}`)) localStorage.removeItem(k);
  } catch {
    // Storage unavailable: nothing kept.
  }
  await refreshMe();
}

// --- Your AI assistant, for an organization hosted elsewhere (runner/remote-mcp.ts) ---
//
// Claude Desktop or Cursor talks to an address on your own agency here; its
// messages wait there until this app carries them to the organization's host -
// the relay, end to end encrypted, with your org token, like everything else the
// app sends - and brings the answers back. So it works while the app is open.

// Your address for an organization (the same one each time).
export const remoteAssistantUrl = (orgId: string) => local<{ url: string }>('/api/assistant/remote', { orgId });
// Connecting your AI assistant to that address: on your own agency, this computer.
export const connectAssistantTo = (app: string, url: string, org: string) =>
  local<{ opened: string; assistant: string; restart: boolean }>('/api/settings/assistant/connect', { app, url, org });

// To any organization you're in, not just the one open (the AI assistant can be on any).
async function fetchInOrg(org: OrgView, path: string, init: { method?: string; headers?: Record<string, string>; body?: string }) {
  if (reachedHere(org)) {
    const auth: Record<string, string> = org.role === 'owner' ? {} : { authorization: `Bearer ${org.self ? await selfToken(org) : await orgToken(org.id)}` };
    return fetch(`/hosted${path}`, { ...init, headers: { ...init.headers, ...auth } });
  }
  return remote(org, path, init);
}

type Carried = { id: number; orgId: string; msg: unknown };
async function carry(c: Carried) {
  const org = teamOrgs().find(o => o.id === c.orgId);
  try {
    if (!org) throw new Error("You're not in that organization any more.");
    const res = await fetchInOrg(org, '/api/agency-mcp/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msg: c.msg }) });
    const reply = await res.json().catch(() => ({ error: `${org.name}'s host didn't answer.` }));
    if (!res.ok) throw new Error(reply.error ?? `${org.name}'s host didn't answer.`);
    await local('/api/assistant/answer', { id: c.id, reply });
  } catch (e) {
    const why = e instanceof HostOffline ? `${org?.name ?? 'The organization'}'s host is offline, so your AI assistant can't reach it right now.` : (e as Error).message;
    await local('/api/assistant/answer', { id: c.id, error: why }).catch(() => {});
  }
}

// Started once, when you're in an organization hosted on another computer.
let carrying = false;
export function carryAssistantMessages() {
  if (carrying || !state.me || !teamOrgs().some(o => !reachedHere(o))) return;
  carrying = true;
  void (async () => {
    for (;;) {
      try {
        const { calls } = await local<{ calls: Carried[] }>('/api/assistant/pending?wait=25000');
        for (const c of calls) void carry(c);
      } catch {
        await new Promise(r => setTimeout(r, 5000)); // its own agency restarting: try again shortly
      }
    }
  })();
}
