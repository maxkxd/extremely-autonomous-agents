// Sign-ins that come back to this computer for an organization hosted elsewhere
// (oauth.ts: they come back to the app's own port on whatever computer the browser
// is on — a service at /, or ChatGPT and OpenRouter at their own paths). The host's
// agency started them, so this one can't finish them: they wait here for this
// computer's app to send them to the host through the relay.

// Held a minute at most: an app that is waiting collects them within seconds.
const held = new Map<string, { query: string; at: number; claimed: boolean; result?: { ok: boolean; message: string } }>();
const HOLD_MS = 60_000;
export function parkSignIn(q: URLSearchParams): string {
  const state = q.get('state')!;
  for (const [k, h] of held) if (Date.now() - h.at > 10 * 60_000) held.delete(k);
  held.set(state, { query: q.toString(), at: Date.now(), claimed: false });
  // The page waits for the app's answer, then says how it went.
  return `<!doctype html><meta charset="utf-8"><title>Signing in</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#141414;color:#e6e6e6;font-family:'IBM Plex Sans','Segoe UI',system-ui,sans-serif;text-align:center">
<div><h1 id="h" style="font-size:22px;margin:0 0 8px">Signing in</h1><p id="p" style="color:#8a8a8a;margin:0">Finishing in the app...</p></div>
<script>
const state = ${JSON.stringify(state)};
const tick = async () => {
  const r = await fetch('/api/oauth/held/status?state=' + encodeURIComponent(state)).then(r => r.json()).catch(() => null);
  if (r && r.done) {
    document.getElementById('h').textContent = r.ok ? 'Connected' : 'Not connected';
    document.getElementById('p').textContent = r.message;
    if (r.ok) setTimeout(() => window.close(), 1200);
    return;
  }
  setTimeout(tick, 1000);
};
tick();
</script></body>`;
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

