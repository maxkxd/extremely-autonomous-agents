import { HOSTED_PORT, hosting, type Hosting } from './hosting.js';
import { fromB64, fromB64url, hostHandshake, toB64, type Bytes, type Session } from './relay-crypto.js';
import { getSecret } from './vault.js';

// This computer as its organisation's host, to members elsewhere: one outbound
// connection to our relay (the backend's /relay/host), signed in with the host
// secret. Each member's app that connects gets a channel; on it the app and this
// host set up an end-to-end encrypted session (relay-crypto.ts) - the relay only
// passes on ciphertext. Inside, each message is one of the app's requests,
// passed to the organisation's agency like any other: it carries the member's
// org access token, and the agency checks it. One without a token is refused
// here, so nothing from outside is ever taken for this computer's own person.

type Request = { id: number; method?: string; path?: string; headers?: Record<string, string>; body?: string };
type Channel = { session: Session | null; inbox: Promise<unknown>; outbox: Promise<unknown> };

const MAX_BODY = 2 * 1024 * 1024;
let sock: WebSocket | null = null;
let stopped = true;
let retry = 0;
let state: 'off' | 'connecting' | 'online' = 'off';
export const relayState = () => state;

const pemToDer = (pem: string): Bytes => fromB64(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));

export async function startRelay(h: Hosting) {
  stopped = false;
  if (sock) return;
  const secret = await getSecret<string>(`hosting:${h.orgId}:secret`);
  const key = await getSecret<{ publicKey: string; privateKey: string }>(`hosting:${h.orgId}:key`);
  // Not registered yet (the app finishes that): tried again when it is.
  if (!secret || !key) return;
  const staticPrivate = pemToDer(key.privateKey);
  const staticPublic = fromB64url(key.publicKey);
  const url = new URL('/relay/host', h.issuer);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  state = 'connecting';
  const ws = new WebSocket(url);
  sock = ws;
  const channels = new Map<number, Channel>();
  const send = (m: unknown) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

  ws.onopen = () => send({ t: 'auth', secret });
  ws.onmessage = e => {
    let m: { t?: string; c?: number; d?: string };
    try {
      m = JSON.parse(String(e.data));
    } catch {
      return;
    }
    if (m.t === 'ready') return void ((state = 'online'), (retry = 0), console.log(`[relay] ${h.orgName} is reachable by its members.`));
    if (typeof m.c !== 'number') return;
    const c = m.c;
    if (m.t === 'open') return void channels.set(c, { session: null, inbox: Promise.resolve(), outbox: Promise.resolve() });
    if (m.t === 'close') return void channels.delete(c);
    const ch = channels.get(c);
    if (m.t !== 'data' || !ch || typeof m.d !== 'string') return;
    const d = fromB64(m.d);
    // In the order they came: each opens with the next counter.
    ch.inbox = ch.inbox.then(async () => {
      if (!ch.session) {
        const { reply, session } = await hostHandshake(h.orgId, staticPrivate, staticPublic, d);
        ch.session = session;
        return void send({ t: 'data', c, d: toB64(reply) });
      }
      const req = JSON.parse(new TextDecoder().decode(await ch.session.open(d))) as Request;
      // Answered as each finishes; sealed and sent in that order.
      void answer(req).then(res => {
        ch.outbox = ch.outbox.then(async () => send({ t: 'data', c, d: toB64(await ch.session!.seal(new TextEncoder().encode(JSON.stringify(res)))) }));
      });
    }).catch(() => {
      // Not a real app, or tampered with: this channel is done.
      channels.delete(c);
      send({ t: 'close', c });
    });
  };
  ws.onclose = () => {
    sock = null;
    state = 'off';
    if (stopped || !hosting()) return;
    const wait = Math.min(60_000, 1000 * 2 ** retry++);
    setTimeout(() => !stopped && hosting() && void startRelay(hosting()!), wait);
  };
  ws.onerror = () => {}; // onclose follows
}

export function stopRelay() {
  stopped = true;
  sock?.close();
}

// One of the app's requests, to the organisation's agency on this computer.
async function answer(r: Request): Promise<{ id: number; status: number; body: string; type: string }> {
  const fail = (status: number, error: string) => ({ id: r.id, status, body: JSON.stringify({ error }), type: 'application/json' });
  if (typeof r.path !== 'string' || !/^\/api\/[\w\-/]*(\?[^#\s]*)?$/.test(r.path)) return fail(404, 'Not found.');
  const auth = r.headers?.authorization ?? '';
  if (!/^Bearer \S+$/.test(auth)) return fail(401, 'Sign in first.');
  if ((r.body?.length ?? 0) > MAX_BODY) return fail(413, 'Too much.');
  const method = r.method === 'POST' ? 'POST' : 'GET';
  try {
    const res = await fetch(`http://127.0.0.1:${HOSTED_PORT}${r.path}`, {
      method,
      headers: { authorization: auth, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? (r.body ?? '{}') : undefined,
    });
    return { id: r.id, status: res.status, body: (await res.text()).slice(0, MAX_BODY), type: res.headers.get('content-type') ?? 'application/json' };
  } catch {
    return fail(503, 'The organisation’s agency is starting.');
  }
}
