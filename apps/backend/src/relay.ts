import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Db } from './db.js';
import { hostBySecret, roleIn } from './directory.js';
import type { Auth } from './tokens.js';

// The relay (docs/architecture.md, "Accounts and organisations"): how members'
// apps reach an organisation's host, which has no public address. The host keeps
// one connection here (/relay/host, signed in with its host secret); a member's
// app opens one (/relay/app, signed in as them, for an organisation they're in)
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

const MAX_FRAME = 4 * 1024 * 1024;
const MAX_CHANNELS = 200;
const AUTH_WITHIN = 10_000;

type Host = { ws: WebSocket; orgId: string; channels: Map<number, WebSocket> };

export function attachRelay(server: Server, db: Db, auth: Auth) {
  const hosts = new Map<string, Host>();
  let nextChannel = 1;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path !== '/relay/host' && path !== '/relay/app') return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => (path === '/relay/host' ? hostSide(ws) : appSide(ws)));
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
    // One host per organisation: a newer connection (it restarted) takes over.
    const was = hosts.get(orgId);
    if (was) was.ws.close(4000, 'Replaced by a newer connection.');
    const host: Host = { ws, orgId, channels: new Map() };
    hosts.set(orgId, host);
    await db.query('UPDATE hosts SET last_seen = $1 WHERE org_id = $2', [Date.now(), orgId]);
    ws.send(JSON.stringify({ t: 'ready' }));

    ws.on('message', raw => {
      const m = json(raw);
      const app = typeof m?.c === 'number' ? host.channels.get(m.c) : undefined;
      if (!app) return;
      if (m!.t === 'data' && typeof m!.d === 'string') app.send(JSON.stringify({ t: 'data', d: m!.d }));
      else if (m!.t === 'close') app.close(1000, 'The host closed it.');
    });
    ws.on('close', () => {
      if (hosts.get(orgId) === host) hosts.delete(orgId);
      for (const app of host.channels.values()) app.close(4004, 'The host went offline.');
    });
  }

  async function appSide(ws: WebSocket) {
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
    host.ws.send(JSON.stringify({ t: 'open', c }));
    ws.send(JSON.stringify({ t: 'ready' }));
    ws.on('message', raw => {
      const m = json(raw);
      if (m?.t === 'data' && typeof m.d === 'string') host.ws.send(JSON.stringify({ t: 'data', c, d: m.d }));
    });
    ws.on('close', () => {
      if (host.channels.delete(c)) host.ws.send(JSON.stringify({ t: 'close', c }));
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
  }, 30_000);
  beat.unref();

  return { online: (orgId: string) => hosts.has(orgId), close: () => (clearInterval(beat), wss.close()) };
}
