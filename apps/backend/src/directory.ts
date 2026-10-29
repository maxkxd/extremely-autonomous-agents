import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Db } from './db.js';

// The directory and its rules (docs/architecture.md, "Accounts and organisations"):
//   - everyone has one personal agency, for good, made when they first sign in,
//     and never shared;
//   - they can own (host) at most one organisation, and join any number;
//   - roles: owner (one, the host), admin (runs the members), member.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const fail = (status: number, message: string): never => {
  throw new ApiError(status, message);
};

export type Role = 'owner' | 'admin' | 'member';
export type Profile = { id: string; email: string; name: string };
export type OrgView = { id: string; kind: 'personal' | 'team'; name: string; role: Role; ownerId: string; host: { registered: boolean; publicKey: string | null } };

const INVITE_DAYS = 14;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

// Someone signing in: their record kept current, and their personal agency made the first time.
export async function ensureUser(db: Db, p: Profile, now = Date.now()) {
  await db.query(
    `INSERT INTO users (id, email, name, created_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name`,
    [p.id, p.email, p.name, now],
  );
  const personal = await db.query("SELECT id FROM orgs WHERE owner_id = $1 AND kind = 'personal'", [p.id]);
  if (!personal.rows.length) {
    const id = randomUUID();
    await db.query("INSERT INTO orgs (id, kind, name, owner_id, created_at) VALUES ($1, 'personal', $2, $3, $4) ON CONFLICT DO NOTHING", [
      id,
      p.name ? `${p.name}'s agency` : 'My agency',
      p.id,
      now,
    ]);
    // Made by another request at the same moment: the unique index kept it to one.
    const kept = await db.query<{ id: string }>("SELECT id FROM orgs WHERE owner_id = $1 AND kind = 'personal'", [p.id]);
    await db.query("INSERT INTO members (org_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3) ON CONFLICT DO NOTHING", [kept.rows[0].id, p.id, now]);
  }
}

// The name someone goes by: the one they chose, or the sign-in provider's.
export async function displayName(db: Db, userId: string) {
  const r = await db.query<{ name: string }>('SELECT COALESCE(display_name, name) AS name FROM users WHERE id = $1', [userId]);
  return r.rows[0]?.name ?? '';
}
export async function setDisplayName(db: Db, userId: string, name: unknown) {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (n.length > 80) fail(400, 'A name, up to 80 characters.');
  await db.query('UPDATE users SET display_name = $1 WHERE id = $2', [n || null, userId]);
}

export async function myOrgs(db: Db, userId: string): Promise<OrgView[]> {
  const rows = await db.query<{ id: string; kind: 'personal' | 'team'; name: string; role: Role; owner_id: string; public_key: string | null }>(
    `SELECT o.id, o.kind, o.name, m.role, o.owner_id, h.public_key
     FROM members m JOIN orgs o ON o.id = m.org_id LEFT JOIN hosts h ON h.org_id = o.id
     WHERE m.user_id = $1 ORDER BY o.kind = 'personal' DESC, o.created_at`,
    [userId],
  );
  return rows.rows.map(r => ({ id: r.id, kind: r.kind, name: r.name, role: r.role, ownerId: r.owner_id, host: { registered: !!r.public_key, publicKey: r.public_key } }));
}

// The role someone has in an organisation, or a 404 - an organisation you're not in doesn't exist for you.
export async function roleIn(db: Db, orgId: string, userId: string): Promise<{ role: Role; kind: 'personal' | 'team'; name: string }> {
  const r = await db.query<{ role: Role; kind: 'personal' | 'team'; name: string }>(
    'SELECT m.role, o.kind, o.name FROM members m JOIN orgs o ON o.id = m.org_id WHERE m.org_id = $1 AND m.user_id = $2',
    [orgId, userId],
  );
  return r.rows[0] ?? fail(404, 'No such organisation.');
}

const cleanName = (name: unknown) => {
  const n = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
  if (!n || n.length > 80) fail(400, 'A name, up to 80 characters.');
  return n;
};

export async function createOrg(db: Db, userId: string, name: unknown, now = Date.now()) {
  const n = cleanName(name);
  const owned = await db.query("SELECT id FROM orgs WHERE owner_id = $1 AND kind = 'team'", [userId]);
  if (owned.rows.length) fail(409, 'You already host an organisation. You can own one, and join as many as you like.');
  const id = randomUUID();
  try {
    await db.query("INSERT INTO orgs (id, kind, name, owner_id, created_at) VALUES ($1, 'team', $2, $3, $4)", [id, n, userId, now]);
  } catch {
    fail(409, 'You already host an organisation.');
  }
  await db.query("INSERT INTO members (org_id, user_id, role, joined_at) VALUES ($1, $2, 'owner', $3)", [id, userId, now]);
  return { id, name: n };
}

export async function renameOrg(db: Db, orgId: string, userId: string, name: unknown) {
  const me = await roleIn(db, orgId, userId);
  if (me.role === 'member') fail(403, 'Only its owner or an admin can rename it.');
  await db.query('UPDATE orgs SET name = $1 WHERE id = $2', [cleanName(name), orgId]);
}

export async function deleteOrg(db: Db, orgId: string, userId: string) {
  const me = await roleIn(db, orgId, userId);
  if (me.kind === 'personal') fail(400, 'Your personal agency is yours for good.');
  if (me.role !== 'owner') fail(403, 'Only its owner can delete it.');
  await db.query('DELETE FROM orgs WHERE id = $1', [orgId]);
}

export async function members(db: Db, orgId: string, userId: string) {
  await roleIn(db, orgId, userId);
  const r = await db.query<{ user_id: string; name: string; email: string; role: Role; joined_at: number }>(
    `SELECT m.user_id, COALESCE(u.display_name, u.name) AS name, u.email, m.role, m.joined_at FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.org_id = $1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, m.joined_at`,
    [orgId],
  );
  return r.rows.map(m => ({ userId: m.user_id, name: m.name, email: m.email, role: m.role, joinedAt: Number(m.joined_at) }));
}

// Owner: anyone's role (but there's only ever one owner). Admin: members only, and only to member.
export async function setRole(db: Db, orgId: string, userId: string, target: string, role: unknown) {
  const me = await roleIn(db, orgId, userId);
  if (role !== 'admin' && role !== 'member') fail(400, 'The role is admin or member.');
  if (me.role !== 'owner') fail(403, 'Only the owner changes roles.');
  const them = await roleIn(db, orgId, target).catch(() => fail(404, 'Not a member.'));
  if (them.role === 'owner') fail(400, "The owner's role doesn't change.");
  await db.query('UPDATE members SET role = $1 WHERE org_id = $2 AND user_id = $3', [role, orgId, target]);
}

export async function removeMember(db: Db, orgId: string, userId: string, target: string) {
  const me = await roleIn(db, orgId, userId);
  const them = await roleIn(db, orgId, target).catch(() => fail(404, 'Not a member.'));
  if (them.role === 'owner') fail(400, 'The owner can’t be removed; they can delete the organisation.');
  if (me.role === 'member' || (me.role === 'admin' && them.role !== 'member')) fail(403, 'Only the owner, or an admin for members, can remove someone.');
  await db.query('DELETE FROM members WHERE org_id = $1 AND user_id = $2', [orgId, target]);
}

export async function leave(db: Db, orgId: string, userId: string) {
  const me = await roleIn(db, orgId, userId);
  if (me.kind === 'personal') fail(400, 'Your personal agency is yours for good.');
  if (me.role === 'owner') fail(400, 'The owner can’t leave; they can delete the organisation.');
  await db.query('DELETE FROM members WHERE org_id = $1 AND user_id = $2', [orgId, userId]);
}

// --- Invites: a code (a link), optionally for one email address ---

export async function createInvite(db: Db, orgId: string, userId: string, opts: { email?: unknown; role?: unknown }, now = Date.now()) {
  const me = await roleIn(db, orgId, userId);
  if (me.kind === 'personal') fail(400, 'A personal agency can’t be shared. Create an organisation to work with others.');
  if (me.role === 'member') fail(403, 'Only the owner or an admin can invite people.');
  const role = opts.role === 'admin' ? 'admin' : 'member';
  if (role === 'admin' && me.role !== 'owner') fail(403, 'Only the owner can invite admins.');
  const email = typeof opts.email === 'string' && opts.email.trim() ? opts.email.trim().toLowerCase() : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, "That isn't an email address.");
  // Inviting the same person again: a fresh invite replaces the one still waiting.
  if (email) await db.query('DELETE FROM invites WHERE org_id = $1 AND email = $2 AND used_by IS NULL', [orgId, email]);
  const code = randomBytes(12).toString('base64url');
  const expiresAt = now + INVITE_DAYS * 86_400_000;
  await db.query('INSERT INTO invites (code, org_id, email, role, created_by, created_at, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7)', [
    code,
    orgId,
    email,
    role,
    userId,
    now,
    expiresAt,
  ]);
  return { code, email, role, expiresAt };
}

export async function pendingInvites(db: Db, orgId: string, userId: string, now = Date.now()) {
  const me = await roleIn(db, orgId, userId);
  if (me.role === 'member') fail(403, 'Only the owner or an admin can see invites.');
  const r = await db.query<{ code: string; email: string | null; role: Role; expires_at: number }>(
    'SELECT code, email, role, expires_at FROM invites WHERE org_id = $1 AND used_by IS NULL AND expires_at > $2 ORDER BY created_at',
    [orgId, now],
  );
  return r.rows.map(i => ({ code: i.code, email: i.email, role: i.role, expiresAt: Number(i.expires_at) }));
}

export async function revokeInvite(db: Db, code: string, userId: string) {
  const inv = (await db.query<{ org_id: string }>('SELECT org_id FROM invites WHERE code = $1 AND used_by IS NULL', [code])).rows[0] ?? fail(404, 'No such invite.');
  const me = await roleIn(db, inv.org_id, userId);
  if (me.role === 'member') fail(403, 'Only the owner or an admin can revoke invites.');
  await db.query('DELETE FROM invites WHERE code = $1', [code]);
}

async function openInvite(db: Db, code: string, now: number) {
  const inv =
    (
      await db.query<{ org_id: string; email: string | null; role: Role; expires_at: number; used_by: string | null; org_name: string; inviter: string }>(
        `SELECT i.org_id, i.email, i.role, i.expires_at, i.used_by, o.name AS org_name, COALESCE(u.display_name, u.name) AS inviter
         FROM invites i JOIN orgs o ON o.id = i.org_id JOIN users u ON u.id = i.created_by WHERE i.code = $1`,
        [code],
      )
    ).rows[0] ?? fail(404, 'That invite doesn’t exist, or was revoked.');
  if (inv.used_by) fail(410, 'That invite has been used.');
  if (Number(inv.expires_at) <= now) fail(410, 'That invite has expired. Ask for a new one.');
  return inv;
}

export async function previewInvite(db: Db, code: string, now = Date.now()) {
  const inv = await openInvite(db, code, now);
  return { org: inv.org_name, invitedBy: inv.inviter, role: inv.role, forEmail: inv.email };
}

// Invites waiting for someone, by their email: shown in their app, no link needed.
export async function invitesFor(db: Db, user: Profile, now = Date.now()) {
  const r = await db.query<{ code: string; org_id: string; org_name: string; inviter: string; role: Role; expires_at: number }>(
    `SELECT i.code, i.org_id, o.name AS org_name, COALESCE(u.display_name, u.name) AS inviter, i.role, i.expires_at
     FROM invites i JOIN orgs o ON o.id = i.org_id JOIN users u ON u.id = i.created_by
     WHERE i.email = $1 AND i.used_by IS NULL AND i.expires_at > $2
       AND NOT EXISTS (SELECT 1 FROM members m WHERE m.org_id = i.org_id AND m.user_id = $3)
     ORDER BY i.created_at DESC`,
    [user.email.toLowerCase(), now, user.id],
  );
  return r.rows.map(i => ({ code: i.code, orgId: i.org_id, org: i.org_name, invitedBy: i.inviter, role: i.role, expiresAt: Number(i.expires_at) }));
}

// Turning one down: it's gone (only for the person it's for).
export async function declineInvite(db: Db, code: string, user: Profile) {
  const r = await db.query('DELETE FROM invites WHERE code = $1 AND email = $2 AND used_by IS NULL', [code, user.email.toLowerCase()]);
  if (!(r as { rowCount?: number; affectedRows?: number }).rowCount && !(r as { affectedRows?: number }).affectedRows) fail(404, 'No such invite for you.');
}

export async function acceptInvite(db: Db, code: string, user: Profile, now = Date.now()) {
  const inv = await openInvite(db, code, now);
  if (inv.email && inv.email !== user.email.toLowerCase()) fail(403, `This invite is for ${inv.email}.`);
  const already = await db.query('SELECT 1 FROM members WHERE org_id = $1 AND user_id = $2', [inv.org_id, user.id]);
  if (!already.rows.length) await db.query('INSERT INTO members (org_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)', [inv.org_id, user.id, inv.role, now]);
  await db.query('UPDATE invites SET used_by = $1, used_at = $2 WHERE code = $3', [user.id, now, code]);
  return { orgId: inv.org_id, name: inv.org_name };
}

// --- Hosts ---

// The owner registers the machine that hosts it: its public key (for end-to-end
// encrypted sessions through the relay) and a secret it signs in to the relay
// with, shown once. Registering again (a new machine) replaces both.
export async function registerHost(db: Db, orgId: string, userId: string, publicKey: unknown, now = Date.now()) {
  const me = await roleIn(db, orgId, userId);
  if (me.role !== 'owner') fail(403, 'Only the owner’s machine hosts it.');
  if (typeof publicKey !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(publicKey)) fail(400, 'publicKey: the host’s public key, base64url.');
  const secret = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO hosts (org_id, public_key, secret_hash, registered_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (org_id) DO UPDATE SET public_key = EXCLUDED.public_key, secret_hash = EXCLUDED.secret_hash, registered_at = EXCLUDED.registered_at, last_seen = NULL`,
    [orgId, publicKey, hash(secret), now],
  );
  return { hostSecret: secret };
}

export async function hostOf(db: Db, orgId: string, userId: string) {
  await roleIn(db, orgId, userId);
  const h = (await db.query<{ public_key: string; registered_at: number; last_seen: number | null }>('SELECT public_key, registered_at, last_seen FROM hosts WHERE org_id = $1', [orgId])).rows[0];
  return h ? { publicKey: h.public_key, registeredAt: Number(h.registered_at), lastSeen: h.last_seen == null ? null : Number(h.last_seen) } : null;
}

// The host signing in (the relay, phase 4): which organisation a secret is for.
export async function hostBySecret(db: Db, secret: string) {
  const r = await db.query<{ org_id: string }>('SELECT org_id FROM hosts WHERE secret_hash = $1', [hash(secret)]);
  return r.rows[0]?.org_id ?? null;
}
