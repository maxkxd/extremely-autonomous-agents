import { randomBytes } from 'node:crypto';

// Signing in with Google or GitHub from the desktop app (docs/packaging.md):
// they refuse embedded windows, so the app opens the person's own browser on
// this agency's address, the sign-in happens there, and a single-use Clerk
// ticket comes back through here to the app. The app starts a handoff and gets
// a code only it knows; the browser page hands the ticket in with that code;
// the app collects it once. Ten minutes, one at a time, this computer only.

const TTL_MS = 10 * 60_000;
let pending: { state: string; until: number; ticket: string | null } | null = null;

export function startHandoff(now = Date.now()) {
  pending = { state: randomBytes(24).toString('base64url'), until: now + TTL_MS, ticket: null };
  return { state: pending.state };
}

const live = (state: unknown, now: number) => !!pending && typeof state === 'string' && state === pending.state && now < pending.until;

// From the browser page, once it's signed in.
export function handInTicket(state: unknown, ticket: unknown, now = Date.now()) {
  if (!live(state, now)) throw new Error('That sign-in has expired. Start again from the app.');
  if (typeof ticket !== 'string' || !ticket || ticket.length > 4096) throw new Error('No ticket.');
  pending!.ticket = ticket;
  return { ok: true };
}

// From the app: the ticket once it's there, then never again.
export function collectTicket(state: unknown, now = Date.now()) {
  if (!live(state, now)) return { ticket: null, expired: true };
  const ticket = pending!.ticket;
  if (ticket) pending = null;
  return { ticket, expired: false };
}
