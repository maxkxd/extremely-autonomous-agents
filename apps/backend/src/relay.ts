import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Db } from './db.js';
import { hostBySecret, roleIn } from './directory.js';
import type { Auth } from './tokens.js';

// The relay (docs/architecture.md, "Accounts and organizations"): how members'
// apps reach an organization's host, which has no public address. The host keeps
// one connection here (/relay/host, signed in with its host secret); a member's
// app opens one (/relay/app, signed in as them, for an organization they're in)
// and gets a channel to that host. The app and the host then set up an
// end-to-end encrypted session over it, with the host's published key: what
// passes through here is ciphertext, and it's only ever passed on.
//
// Frames are JSON. First, from either side: {t: 'auth', ...}. Then:
//   app  -> relay: {t: 'data', d}            relay -> host: {t: 'data', c, d}
//   host -> relay: {t: 'data', c, d}         relay -> app:  {t: 'data', d}
//   relay -> host: {t: 'open', c} / {t: 'close', c}; host -> relay: {t: 'close', c}
// d is base64 (opaque here). Close codes: 4001 sign in, 4003 not a member,
// 4004 host offline, 4008 too much.
//
// Once a minute it logs how many bytes passed each way ("[relay] ..."), and one
// line for each app channel that carried any, with its user agent and address,
// so a stream nobody means to be watching can be traced to the client.

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_CHANNELS = 200;
const AUTH_WITHIN = 10_000;

type Host = { ws: WebSocket; orgId: string; channels: Map<number, WebSocket> };
// What the traffic log keeps about one app channel: who opened it and what
// passed in the current minute.
type Chan = { ua: string; ip: string; since: number; toApp: number; fromApp: number };

const megabytes = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
// Printable ASCII only, and short, so a header can't forge or flood a log line.
const plain = (s: unknown, max: number) => String(s ?? '').replace(/[^\x20-\x7e]/g, '?').slice(0, max);

export function attachRelay(server: Server, db: Db, auth: Auth, { beatMs = 30_000, statsMs = 60_000 } = {}) {
  const hosts = new Map<string, Host>();
  let nextChannel = 1;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  // Bytes (about: the length of each JSON frame) since the last log line.
  const traffic = { fromHost: 0, toHost: 0, fromApps: 0, toApps: 0 };
  const chans = new Map<number, Chan>();
  const size = (raw: unknown) => (Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw)));
  const toHost = (host: Host, text: string) => {
    traffic.toHost += text.length;
    host.ws.send(text);
  };

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/relay/host' && path !== '/relay/app') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      // noServer doesn't emit it itself; the heartbeat below counts on it.
      wss.emit('connection', ws, req);
      void (path === '/relay/host' ? hostSide(ws) : appSide(ws, req));
    });
  });

  // Signed in within a few seconds, or gone.
  const firstFrame = (ws: WebSocket) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => (ws.close(4001, 'Sign in first.'), reject(new Error('timeout'))), AUTH_WITHIN);
      ws.once('message', raw => {
        clearTimeout(t);
        try {
          resolve(JSON.parse(String(raw)));
        } catch {
          ws.close(4001, 'Sign in first.');
          reject(new Error('not JSON'));
        }
      });
    });
  const json = (raw: unknown) => {
    try {
      return JSON.parse(String(raw)) as { t?: string; c?: number; d?: string };
    } catch {
      return null;
    }
  };

  async function hostSide(ws: WebSocket) {
    const hello = await firstFrame(ws).catch(() => null);
    const orgId = typeof hello?.secret === 'string' ? await hostBySecret(db, hello.secret) : null;
    if (!orgId) return ws.close(4001, 'Not a registered host.');
    // One host per organization: a newer connection (it restarted) takes over.
    const was = hosts.get(orgId);
    if (was) was.ws.close(4000, 'Replaced by a newer connection.');
    const host: Host = { ws, orgId, channels: new Map() };
    hosts.set(orgId, host);
    await db.query('UPDATE hosts SET last_seen = $1 WHERE org_id = $2', [Date.now(), orgId]);
    ws.send(JSON.stringify({ t: 'ready' }));

    ws.on('message', raw => {
      traffic.fromHost += size(raw);
      const m = json(raw);
      const app = typeof m?.c === 'number' ? host.channels.get(m.c) : undefined;
      if (!app) return;
      if (m!.t === 'data' && typeof m!.d === 'string') {
        const text = JSON.stringify({ t: 'data', d: m!.d });
        traffic.toApps += text.length;
        const chan = chans.get(m!.c!);
        if (chan) chan.toApp += text.length;
        app.send(text);
      } else if (m!.t === 'close') app.close(1000, 'The host closed it.');
    });
    ws.on('close', () => {
      if (hosts.get(orgId) === host) hosts.delete(orgId);
      for (const app of host.channels.values()) app.close(4004, 'The host went offline.');
    });
  }

  async function appSide(ws: WebSocket, req: IncomingMessage) {
    const hello = await firstFrame(ws).catch(() => null);
    const userId = typeof hello?.token === 'string' ? await auth.session(hello.token).catch(() => null) : null;
    if (!userId) return ws.close(4001, 'Sign in first.');
    const orgId = typeof hello?.org === 'string' ? hello.org : '';
    if (!(await roleIn(db, orgId, userId).catch(() => null))) return ws.close(4003, 'Not a member.');
    const host = hosts.get(orgId);
    if (!host) return ws.close(4004, 'The host is offline.');
    if (host.channels.size >= MAX_CHANNELS) return ws.close(4008, 'Too many connections to this host.');

    const c = nextChannel++;
    host.channels.set(c, ws);
    // Behind Railway's proxy the first x-forwarded-for entry is the client.
    const ip = plain(String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim(), 45);
    chans.set(c, { ua: plain(req.headers['user-agent'], 80), ip, since: Date.now(), toApp: 0, fromApp: 0 });
    toHost(host, JSON.stringify({ t: 'open', c }));
    ws.send(JSON.stringify({ t: 'ready' }));
    ws.on('message', raw => {
      traffic.fromApps += size(raw);
      const chan = chans.get(c);
      if (chan) chan.fromApp += size(raw);
      const m = json(raw);
      if (m?.t === 'data' && typeof m.d === 'string') toHost(host, JSON.stringify({ t: 'data', c, d: m.d }));
    });
    ws.on('close', () => {
      chans.delete(c);
      if (host.channels.delete(c)) toHost(host, JSON.stringify({ t: 'close', c }));
    });
  }

  // Keep idle connections open through proxies (Railway's included), and drop dead ones.
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on('connection', ws => {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
  });
  const beat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) ws.terminate();
      else (alive.set(ws, false), ws.ping());
    }
  }, beatMs);
  beat.unref();

  // The traffic log: nothing at all while there is no host and no app channel.
  let lastReport = Date.now();
  const report = setInterval(() => {
    const now = Date.now();
    const secs = Math.round((now - lastReport) / 1000);
    lastReport = now;
    if (hosts.size || chans.size) {
      console.log(
        `[relay] last ${secs}s: ${hosts.size} host(s), ${chans.size} app channel(s); ` +
          `from hosts ${megabytes(traffic.fromHost)}, to hosts ${megabytes(traffic.toHost)}, ` +
          `from apps ${megabytes(traffic.fromApps)}, to apps ${megabytes(traffic.toApps)}`,
      );
      for (const [c, chan] of chans) {
        if (!chan.toApp && !chan.fromApp) continue;
        console.log(
          `[relay]   channel ${c}: open ${Math.round((now - chan.since) / 1000)}s, ${chan.ip || 'unknown address'}, ` +
            `"${chan.ua || 'no user agent'}", to app ${megabytes(chan.toApp)}, from app ${megabytes(chan.fromApp)}`,
        );
      }
    }
    traffic.fromHost = traffic.toHost = traffic.fromApps = traffic.toApps = 0;
    for (const chan of chans.values()) chan.toApp = chan.fromApp = 0;
  }, statsMs);
  report.unref();

  return { online: (orgId: string) => hosts.has(orgId), close: () => (clearInterval(beat), clearInterval(report), wss.close()) };
}
