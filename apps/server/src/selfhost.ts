import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { exportJWK, generateKeyPair, importJWK, jwtVerify, SignJWT, type CryptoKey, type JWK } from 'jose';
import type { Actor, Role } from './access.js';
import { all, getSetting, one, run as exec, setSetting } from './runner/db.js';

// A self-hosted organisation (docs/architecture.md, "Accounts and organisations"):
// this host is its own authority and never talks to us. It keeps the
// organisation's accounts (email and password), invites and sign-in sessions,
// and signs the same org access tokens our backend would - with its own key,
// trusted by nothing but itself. Members' apps reach it at its own address.
//
// A token is checked against the account every time (role from here, not the
// token), so removing someone or changing their role takes effect at once.

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
export const SELF_HOSTED = process.env.EAA_SELF_HOSTED === '1';
export const SELF_ISSUER = 'self';
const TOKEN_MINUTES = 15;
const SESSION_DAYS = 30;
const INVITE_DAYS = 14;

export class SelfError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new SelfError(status, message);
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const now = () => Date.now();

type Account = { id: string; email: string; name: string; role: Role; pw: string; created_at: number };

// --- The signing key: made once, kept in this agency's own store ---

let signer: Promise<{ priv: CryptoKey; pub: CryptoKey; kid: string }> | null = null;
function key() {
  signer ??= (async () => {
    let jwk = getSetting<{ priv: JWK; pub: JWK } | null>('self_signing_key', null);
    if (!jwk) {
      const pair = await generateKeyPair('EdDSA', { extractable: true });
      jwk = { priv: await exportJWK(pair.privateKey), pub: await exportJWK(pair.publicKey) };
      setSetting('self_signing_key', jwk);
    }
    return { priv: (await importJWK(jwk.priv, 'EdDSA')) as CryptoKey, pub: (await importJWK(jwk.pub, 'EdDSA')) as CryptoKey, kid: hash(jwk.pub.x ?? '').slice(0, 16) };
  })();
  return signer;
}

const orgId = () => process.env.EAA_HOSTED_ORG ?? '';
const orgName = () => getSetting<string>('self_org_name', 'Organisation');

async function orgToken(a: Account) {
  const k = await key();
  const expiresAt = now() + TOKEN_MINUTES * 60_000;
  const token = await new SignJWT({ org: orgId(), role: a.role, name: a.name, kind: 'team' })
    .setProtectedHeader({ alg: 'EdDSA', kid: k.kid })
    .setSubject(a.id)
    .setIssuer(SELF_ISSUER)
    .setAudience('eaa-host')
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt / 1000))
    .sign(k.priv);
  return { token, expiresAt };
}

// A token this host signed, for an account that's still here: who, as they are now.
export async function checkSelfToken(token: string): Promise<Actor | null> {
  try {
    const { payload } = await jwtVerify(token, (await key()).pub, { issuer: SELF_ISSUER, audience: 'eaa-host', algorithms: ['EdDSA'] });
    if (payload.org !== orgId() || typeof payload.sub !== 'string') return null;
    const a = one<Account>('SELECT * FROM self_accounts WHERE id = ?', payload.sub);
    return a ? { id: a.id, name: a.name, role: a.role, via: 'token' } : null;
  } catch {
    return null;
  }
}

// Whether someone's still in it, and as what (their agency MCP address, agency-mcp.ts).
export const selfMember = (id: string) => {
  const a = one<Account>('SELECT * FROM self_accounts WHERE id = ?', id);
  return a ? { role: a.role, name: a.name } : null;
};

// --- Passwords ---

async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${(await scrypt(pw, salt, 32)).toString('base64')}`;
}
async function passwordMatches(pw: string, stored: string) {
  const [, salt, want] = stored.split('$');
  const got = await scrypt(pw, Buffer.from(salt, 'base64'), 32);
  return timingSafeEqual(got, Buffer.from(want, 'base64'));
}
const cleanEmail = (e: unknown) => {
  const v = typeof e === 'string' ? e.trim().toLowerCase() : '';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) fail(400, "That isn't an email address.");
  return v;
};
const cleanName = (n: unknown, email: string) => (typeof n === 'string' && n.trim() ? n.trim().slice(0, 80) : email.split('@')[0]);
const cleanPassword = (p: unknown) => {
  if (typeof p !== 'string' || p.length < 10) fail(400, 'A password of at least 10 characters.');
  return p as string;
};

// Sign-in attempts: a few wrong ones, then a pause (per email).
const misses = new Map<string, { n: number; until: number }>();
function guard(email: string) {
  const m = misses.get(email);
  if (m && m.until > now()) fail(429, 'Too many tries. Wait a minute and try again.');
}
function missed(email: string) {
  const m = misses.get(email) ?? { n: 0, until: 0 };
  m.n++;
  if (m.n >= 5) (m.until = now() + 60_000), (m.n = 0);
  misses.set(email, m);
}

async function newSession(accountId: string) {
  const session = randomBytes(32).toString('base64url');
  exec('INSERT INTO self_sessions (hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)', hash(session), accountId, now(), now() + SESSION_DAYS * 86_400_000);
  return session;
}

// --- Public: setting up, signing in, joining (no token yet) ---

// The owner's account, made when this computer starts self-hosting (once).
export async function setup(b: Record<string, unknown>) {
  if (one('SELECT 1 FROM self_accounts LIMIT 1')) fail(409, 'It already has an owner.');
  const email = cleanEmail(b.email);
  const id = `acct_${randomBytes(9).toString('base64url')}`;
  exec('INSERT INTO self_accounts (id, email, name, role, pw, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, email, cleanName(b.name, email), 'owner', await hashPassword(cleanPassword(b.password)), now());
  if (typeof b.orgName === 'string' && b.orgName.trim()) setSetting('self_org_name', b.orgName.trim().slice(0, 80));
  return { ok: true };
}

export async function signIn(b: Record<string, unknown>) {
  const email = cleanEmail(b.email);
  guard(email);
  const a = one<Account>('SELECT * FROM self_accounts WHERE email = ?', email);
  if (!a || typeof b.password !== 'string' || !(await passwordMatches(b.password, a.pw))) {
    missed(email);
    fail(401, 'That email and password don’t match.');
  }
  return { session: await newSession(a!.id), ...about(a!) };
}

const about = (a: Account) => ({ org: { id: orgId(), name: orgName() }, you: { id: a.id, email: a.email, name: a.name, role: a.role } });

function openInvite(code: unknown) {
  const i = one<{ code: string; email: string | null; role: Role; expires_at: number; used_by: string | null }>('SELECT * FROM self_invites WHERE code = ?', String(code ?? ''));
  if (!i) return fail(404, 'That invite doesn’t exist, or was revoked.');
  if (i.used_by) fail(410, 'That invite has been used.');
  if (i.expires_at <= now()) fail(410, 'That invite has expired. Ask for a new one.');
  return i;
}
export const previewInvite = (code: unknown) => {
  const i = openInvite(code);
  return { org: orgName(), role: i.role, forEmail: i.email };
};

// Joining with an invite: a new account (or signing in to one with that email).
export async function acceptInvite(b: Record<string, unknown>) {
  const i = openInvite(b.code);
  const email = cleanEmail(b.email);
  if (i.email && i.email !== email) fail(403, `This invite is for ${i.email}.`);
  let a = one<Account>('SELECT * FROM self_accounts WHERE email = ?', email);
  if (a) {
    if (typeof b.password !== 'string' || !(await passwordMatches(b.password, a.pw))) fail(401, 'There’s already an account with that email: use its password.');
  } else {
    const id = `acct_${randomBytes(9).toString('base64url')}`;
    exec('INSERT INTO self_accounts (id, email, name, role, pw, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, email, cleanName(b.name, email), i.role, await hashPassword(cleanPassword(b.password)), now());
    a = one<Account>('SELECT * FROM self_accounts WHERE id = ?', id)!;
  }
  exec('UPDATE self_invites SET used_by = ?, used_at = ? WHERE code = ?', a.id, now(), i.code);
  return { session: await newSession(a.id), ...about(a) };
}

// A session (kept by the member's app) for a fresh org token.
export async function tokenFor(b: Record<string, unknown>) {
  const s = one<{ account_id: string; expires_at: number }>('SELECT account_id, expires_at FROM self_sessions WHERE hash = ?', hash(String(b.session ?? '')));
  const a = s && s.expires_at > now() ? one<Account>('SELECT * FROM self_accounts WHERE id = ?', s.account_id) : null;
  if (!a) return fail(401, 'Sign in again.');
  return { ...(await orgToken(a)), ...about(a) };
}

export function signOut(b: Record<string, unknown>) {
  exec('DELETE FROM self_sessions WHERE hash = ?', hash(String(b.session ?? '')));
  return { ok: true };
}

// --- People (signed in: through access.ts like any route; managing needs an admin) ---

export const members = () =>
  all<Account>("SELECT * FROM self_accounts ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, created_at").map(a => ({
    userId: a.id,
    name: a.name,
    email: a.email,
    role: a.role,
    joinedAt: a.created_at,
  }));

const accountOf = (actor: Actor) => (actor.via === 'local' ? one<Account>("SELECT * FROM self_accounts WHERE role = 'owner'") : one<Account>('SELECT * FROM self_accounts WHERE id = ?', actor.id));

export function setRole(actor: Actor, target: string, role: unknown) {
  if (role !== 'admin' && role !== 'member') fail(400, 'The role is admin or member.');
  if (actor.role !== 'owner') fail(403, 'Only the owner changes roles.');
  const t = one<Account>('SELECT * FROM self_accounts WHERE id = ?', target) ?? fail(404, 'Not a member.');
  if (t.role === 'owner') fail(400, "The owner's role doesn't change.");
  exec('UPDATE self_accounts SET role = ? WHERE id = ?', role as string, target);
}

// Gone at once: their sessions end and their tokens stop working (checked per request).
export function removeMember(actor: Actor, target: string) {
  const t = one<Account>('SELECT * FROM self_accounts WHERE id = ?', target) ?? fail(404, 'Not a member.');
  if (t.role === 'owner') fail(400, 'The owner can’t be removed.');
  if (actor.role === 'member' || (actor.role === 'admin' && t.role !== 'member')) fail(403, 'Only the owner, or an admin for members, can remove someone.');
  exec('DELETE FROM self_sessions WHERE account_id = ?', target);
  exec('DELETE FROM self_accounts WHERE id = ?', target);
}

export function leave(actor: Actor) {
  const a = accountOf(actor);
  if (!a || a.role === 'owner') fail(400, 'The owner can’t leave.');
  removeMember({ ...actor, role: 'owner' }, a!.id);
}

export function createInvite(actor: Actor, b: Record<string, unknown>) {
  if (actor.role === 'member') fail(403, 'Only the owner or an admin can invite people.');
  const role = b.role === 'admin' ? 'admin' : 'member';
  if (role === 'admin' && actor.role !== 'owner') fail(403, 'Only the owner can invite admins.');
  const email = typeof b.email === 'string' && b.email.trim() ? cleanEmail(b.email) : null;
  const code = randomBytes(12).toString('base64url');
  const expiresAt = now() + INVITE_DAYS * 86_400_000;
  exec('INSERT INTO self_invites (code, email, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', code, email, role, actor.id, now(), expiresAt);
  return { code, email, role, expiresAt };
}
export const pendingInvites = () =>
  all<{ code: string; email: string | null; role: Role; expires_at: number }>('SELECT code, email, role, expires_at FROM self_invites WHERE used_by IS NULL AND expires_at > ? ORDER BY created_at', now()).map(i => ({
    code: i.code,
    email: i.email,
    role: i.role,
    expiresAt: i.expires_at,
  }));
export function revokeInvite(actor: Actor, code: unknown) {
  if (actor.role === 'member') fail(403, 'Only the owner or an admin can revoke invites.');
  exec('DELETE FROM self_invites WHERE code = ? AND used_by IS NULL', String(code ?? ''));
}

// The address members reach it at (the owner sets it: their tunnel or proxy).
export const address = () => getSetting<string | null>('self_address', null);
export function setAddress(v: unknown) {
  const a = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : '';
  if (a && !/^https?:\/\/[^\s/]+$/.test(a)) fail(400, 'An address like https://agency.example.com');
  setSetting('self_address', a || null);
  return { address: address() };
}
