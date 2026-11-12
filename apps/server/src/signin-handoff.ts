import { signInPage } from './signin-page.js';

// Sign-ins that come back to this computer for an organization hosted elsewhere
// (oauth.ts: they come back to the app's own port on whatever computer the browser
// is on — a service at /, or ChatGPT and OpenRouter at their own paths). The host's
// agency started them, so this one can't finish them: they wait here for this
// computer's app to send them to the host through the relay.

// Held three minutes at most: an app that is waiting collects them within seconds,
// but one that was slowed in the background (or just woke) gets time to catch up
// before the page says the sign-in expired.
const held = new Map<string, { query: string; at: number; claimed: boolean; result?: { ok: boolean; message: string } }>();
const HOLD_MS = 3 * 60_000;
export function parkSignIn(q: URLSearchParams): string {
  const state = q.get('state')!;
  for (const [k, h] of held) if (Date.now() - h.at > 10 * 60_000) held.delete(k);
  held.set(state, { query: q.toString(), at: Date.now(), claimed: false });
  // The page waits for the app's answer, then says how it went.
  return signInPage({ done: false }, state);
}
export function heldSignIns() {
  const out: { state: string; query: string }[] = [];
  for (const [state, h] of held) if (!h.claimed && Date.now() - h.at < HOLD_MS) (h.claimed = true), out.push({ state, query: h.query });
  return out;
}
export function heldResult(state: string, ok: boolean, message: string) {
  const h = held.get(state);
  if (h) h.result = { ok, message: message.slice(0, 300) };
}
export function heldStatus(state: string) {
  const h = held.get(state);
  if (h?.result) return { done: true, ...h.result };
  // Nobody picked it up: no app here was waiting for it - an expired sign-in.
  if (!h || (!h.claimed && Date.now() - h.at > HOLD_MS)) return { done: true, ok: false, message: 'That sign-in has expired. Start it again from Settings.' };
  return { done: false };
}

