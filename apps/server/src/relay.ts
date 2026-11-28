import { HOSTED_PORT, type Hosting } from './hosting.js';
import { fromB64, fromB64url, hostHandshake, toB64, type Bytes, type Session } from './relay-crypto.js';
import { getSecret } from './vault.js';

// This computer as its organization's host, to members elsewhere: one outbound
// connection to our relay (the backend's /relay/host), signed in with the host
// secret. Each member's app that connects gets a channel; on it the app and this
// host set up an end-to-end encrypted session (relay-crypto.ts) - the relay only
// passes on ciphertext. Inside, each message is one of the app's requests,
// passed to the organization's agency like any other: it carries the member's
// org access token, and the agency checks it. One without a token is refused
// here, so nothing from outside is ever taken for this computer's own person.

type Request = { id: number; method?: string; path?: string; headers?: Record<string, string>; body?: string };
type Channel = { session: Session | null; inbox: Promise<unknown>; outbox: Promise<unknown> };

const MAX_BODY = 2 * 1024 * 1024;
// A connection that held this long counts as a good one: the pause before the next try starts over.
const STABLE_MS = 30_000;
// One host per organization: the relay closes a host's connection with this when a newer one signs in as that host.
const REPLACED = 4000;
// How long a replaced host waits before it takes the place back: a minute, doubling to a
// quarter of an hour while it keeps being replaced.
const REPLACED_MAX_MS = 15 * 60_000;
export const replacedPause = (times: number) => Math.min(REPLACED_MAX_MS, 60_000 * 2 ** (times - 1));
// The organization's agency: beside us on HOSTED_PORT, or (in the cloud, cloud.ts) this very process.
// (A function: hosting.ts imports this file, so its values aren't there yet at load.)
const agencyPort = () => (process.env.EAA_HOSTED_ORG ? Number(process.env.PORT ?? HOSTED_PORT) : HOSTED_PORT);
let sock: WebSocket | null = null;
let stopped = true;
let retry = 0;
let state: 'off' | 'connecting' | 'online' = 'off';
// When the current connection became ready (0: it isn't).
let onlineAt = 0;
// Connections in a row that dropped before STABLE_MS: logged once, not every time.
let drops = 0;
// Tries in a row that never got connected: logged once, not every time.
let failing = false;
// Times running that another host has replaced this one.
let replaced = 0;
// The next try, while one is waiting.
let next: ReturnType<typeof setTimeout> | undefined;
export const relayState = () => state;

const pemToDer = (pem: string): Bytes => fromB64(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));

// The hosting it connects for: reconnects use the latest (moveRelay).
let current: Hosting | null = null;

export async function startRelay(h: Hosting) {
  stopped = false;
  current = h;
  if (sock) return;
  const secret = await getSecret<string>(`hosting:${h.orgId}:secret`);
  const key = await getSecret<{ publicKey: string; privateKey: string }>(`hosting:${h.orgId}:key`);
  // Not registered yet (the app finishes that): tried again when it is.
  if (!secret || !key) return;
  // Called again while those were read, or stopped meanwhile. One connection only:
  // a second one would replace this host's own at the relay.
  if (sock || stopped) return;
  clearTimeout(next);
  const staticPrivate = pemToDer(key.privateKey);
  const staticPublic = fromB64url(key.publicKey);
  const url = new URL('/relay/host', (current ?? h).issuer);
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
    if (m.t === 'ready') {
      state = 'online';
      onlineAt = Date.now();
      failing = false;
      if (!drops) {
        retry = 0;
        console.log(`[relay] ${h.orgName} is reachable by its members.`);
      } else {
        // It has been dropping: say so again only once it has held, and not before.
        setTimeout(() => {
          if (sock !== ws || state !== 'online') return;
          drops = 0;
          retry = 0;
          console.log(`[relay] ${h.orgName} is reachable by its members again (connection to ${url.host} is holding).`);
        }, STABLE_MS).unref();
      }
      return;
    }
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
  ws.onclose = e => {
    const was = state;
    const stayed = onlineAt ? Date.now() - onlineAt : 0;
    sock = null;
    state = 'off';
    onlineAt = 0;
    if (stopped) return;
    const again = (ms: number) => void (next = setTimeout(() => !stopped && void startRelay(current ?? h), ms));
    // It held for longer than another host would have waited: that one has gone.
    if (stayed > REPLACED_MAX_MS + STABLE_MS) replaced = 0;
    if (e.code === REPLACED) {
      // Straight back would only push the other host off, and it would push back.
      const wait = replacedPause(++replaced);
      drops = 0;
      retry = 0;
      console.warn(
        `[relay] Another host took this one's place: a newer connection signed in to ${url.host} as the host of ${h.orgName}, ` +
          `so members reach that one now. If this agency is running in two places, stop one (this one still runs its schedule). ` +
          `Trying again in ${wait / 60_000} min; restarting this one takes the place back at once.`,
      );
      return again(wait);
    }
    // Growing pauses (up to a minute): a connection that keeps dropping right after it is
    // ready no longer retries every second.
    const wait = Math.min(60_000, 1000 * 2 ** retry++);
    const why = `code ${e.code}${e.reason ? `, "${String(e.reason).slice(0, 100)}"` : ''}`;
    if (was === 'online') {
      if (stayed >= STABLE_MS) {
        drops = 0;
        retry = 0;
        console.log(`[relay] Connection to ${url.host} closed (${why}) after ${Math.round(stayed / 1000)}s; connecting again.`);
      } else if (++drops === 1) {
        console.log(
          `[relay] Connection to ${url.host} dropped (${why}) ${Math.round(stayed / 1000)}s after it was ready; connecting again, ` +
            `waiting longer if it keeps dropping. It is logged again once it holds.`,
        );
      }
    } else if (!failing) {
      failing = true;
      console.log(`[relay] Could not connect to ${url.host} (${why}); trying again, waiting longer each time. Logged once until it connects.`);
    }
    again(wait);
  };
  ws.onerror = () => {}; // onclose follows
}

// Our backend moved (its issuer changed): connect to the new address.
export function moveRelay(h: Hosting) {
  stopped = false;
  current = h;
  if (sock) sock.close(); // onclose reconnects, to the new address
  else void startRelay(h);
}

export function stopRelay() {
  stopped = true;
  clearTimeout(next);
  replaced = 0;
  sock?.close();
}

// One of the app's requests, to the organization's agency on this computer.
async function answer(r: Request): Promise<{ id: number; status: number; body: string; type: string }> {
  const fail = (status: number, error: string) => ({ id: r.id, status, body: JSON.stringify({ error }), type: 'application/json' });
  if (typeof r.path !== 'string' || !/^\/api\/[\w\-/]*(\?[^#\s]*)?$/.test(r.path)) return fail(404, 'Not found.');
  const auth = r.headers?.authorization ?? '';
  if (!/^Bearer \S+$/.test(auth)) return fail(401, 'Sign in first.');
  if ((r.body?.length ?? 0) > MAX_BODY) return fail(413, 'Too much.');
  const method = r.method === 'POST' ? 'POST' : 'GET';
  try {
    const res = await fetch(`http://127.0.0.1:${agencyPort()}${r.path}`, {
      method,
      headers: { authorization: auth, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: method === 'POST' ? (r.body ?? '{}') : undefined,
    });
    return { id: r.id, status: res.status, body: (await res.text()).slice(0, MAX_BODY), type: res.headers.get('content-type') ?? 'application/json' };
  } catch {
    return fail(503, 'The organization’s agency is starting.');
  }
}
