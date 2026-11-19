import { randomBytes, randomInt } from 'node:crypto';
import { deleteSecret, getSecret, setSecret } from '../vault.js';
import { all, one, run as exec } from './db.js';
import { hasPassword, signInOf, signInWords, type SignIn } from './signin.js';

// The agents' password store: accounts agents sign up for (and ones a person adds),
// for the signed-in browser. The password is sealed in the vault; agents never see
// it - signed_in_browser.type_password types it straight into the page. Owners and
// admins can see them in Settings > Connectors > Signed-in browser > Passwords.
//
// Keyed by browser: profile is the number of a paired browser (browser-link.ts; each
// is one Chrome or Edge profile - the numbers carried over from the agents' own
// browser profiles before, which are agents' profiles again: agent-profiles.ts). A browser holds up to ACCOUNTS_PER_SITE accounts on one
// site (Google's own limit per browser): the next goes in another browser.

export const ACCOUNTS_PER_SITE = 10;

// confirmed_at: when the account was seen to work (an agent finished the sign-up or
// signed in with it, or a person added it). Until then it may not exist at all: an
// agent saves the password before the sign-up, and a site can refuse the sign-up
// after (Proton blocked one from the cloud's network and the inbox was never made).
//
// account_id: the account a sign-up's password is for (accounts.ts). Until that account
// is seen working the password is hidden from every list here - it isn't an account
// yet, and may never be: the store only shows accounts that exist.
//
// method/provider: how the account signs in (signin.ts). Only a password account has
// a password in the vault; the others are here as "signs in with X" so a run knows
// how to get back in.
export type PasswordRow = { id: string; site: string; username: string; profile: number; agent_id: string | null; note: string | null; created_at: number; confirmed_at: number | null; account_id: string | null; method: string | null; provider: string | null };
const SHOWN = '(account_id IS NULL OR confirmed_at IS NOT NULL)';

// "https://www.LinkedIn.com/login" -> "linkedin.com"; "YouTube" -> "youtube.com" is
// left to the agent: a bare word stays a word.
export function siteOf(raw: string): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) throw new Error('Which site? e.g. linkedin.com');
  let host = s;
  try {
    host = new URL(/^[a-z]+:\/\//.test(s) ? s : `https://${s}`).hostname;
  } catch {
    // not an address: kept as written
  }
  return host.replace(/^www\./, '');
}

// Strong, and typeable on sites that are fussy about symbols.
export function makePassword(length = 20): string {
  const sets = ['abcdefghijkmnopqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789', '!@#$%*?'];
  const every = sets.join('');
  const chars = sets.map(set => set[randomInt(set.length)]);
  while (chars.length < length) chars.push(every[randomInt(every.length)]);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

// How many accounts on this site a browser holds (not counting one account's own, being remade).
export const accountsIn = (site: string, profile: number, except?: string | null) =>
  one<{ n: number }>('SELECT COUNT(*) AS n FROM passwords WHERE site = ? AND profile = ? AND (account_id IS NULL OR account_id IS NOT ?)', site, profile, except ?? null)?.n ?? 0;

// The browser a new account on this site goes in: the first with room, or (isNew) one more.
export function profileFor(site: string, profiles: number[]): { profile: number; isNew: boolean } {
  for (const p of profiles) if (accountsIn(site, p) < ACCOUNTS_PER_SITE) return { profile: p, isNew: false };
  return { profile: Math.max(0, ...profiles) + 1, isNew: true };
}

// An agents' profile folder that had to take a new number (a person's browser paired
// as its old one first): its accounts go with it. Only those made before that browser
// was paired; the later ones are the person's browser's.
export function moveProfilePasswords(from: number, to: number, before: number): number {
  return Number(exec('UPDATE passwords SET profile = ? WHERE profile = ? AND created_at < ?', to, from, before).changes);
}

// signIn: an account with no password (an emailed code, Google, a company's sign-in):
// saved without one, and nothing goes in the vault.
export async function savePassword(p: { site: string; username: string; password?: string | null; signIn?: SignIn; profile: number; agentId: string | null; note?: string | null; confirmed?: boolean; accountId?: string | null }) {
  const id = randomBytes(6).toString('hex');
  const how = p.signIn ?? { method: 'password', provider: null };
  if (how.method === 'password') {
    if (!p.password) throw new Error('A password account needs its password.');
    await setSecret(`pw:${id}`, p.password);
  }
  exec(
    'INSERT INTO passwords (id, site, username, profile, agent_id, note, created_at, confirmed_at, account_id, method, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    siteOf(p.site),
    p.username.trim(),
    p.profile,
    p.agentId,
    p.note?.trim() || null,
    Date.now(),
    p.confirmed ? Date.now() : null,
    p.accountId ?? null,
    how.method === 'password' ? null : how.method,
    how.provider,
  );
  return id;
}

// The account was seen to work: the sign-up finished, or it signed in.
export function confirmPassword(id: string) {
  const row = passwordRow(id);
  if (!row) throw new Error(`No password #${id}. signed_in_browser.passwords lists them.`);
  exec('UPDATE passwords SET confirmed_at = ? WHERE id = ?', Date.now(), row.id);
  return row;
}

export const listPasswords = (site?: string | null) =>
  site
    ? all<PasswordRow>(`SELECT * FROM passwords WHERE site = ? AND ${SHOWN} ORDER BY profile, created_at`, siteOf(site))
    : all<PasswordRow>(`SELECT * FROM passwords WHERE ${SHOWN} ORDER BY site, profile, created_at`);

export const passwordRow = (id: string) => one<PasswordRow>('SELECT * FROM passwords WHERE id = ?', String(id ?? '').replace(/^#/, ''));

// What the account signs in with, for one that has no password to type or show.
export const noPasswordWords = (row: PasswordRow) => `#${row.id} (${row.username} at ${row.site}) has no password: it signs in with ${signInWords(signInOf(row))}.`;

export async function readPassword(id: string): Promise<string> {
  const row = passwordRow(id);
  if (row && !hasPassword(row)) throw new Error(`${noPasswordWords(row)} Don't type a password for it.`);
  const pw = row ? await getSecret<string>(`pw:${row.id}`) : null;
  if (!row || !pw) throw new Error(`No password #${id}. signed_in_browser.passwords lists them.`);
  return pw;
}

export async function deletePassword(id: string) {
  const row = passwordRow(id);
  if (!row) return false;
  exec('DELETE FROM passwords WHERE id = ?', row.id);
  await deleteSecret(`pw:${row.id}`);
  return true;
}
