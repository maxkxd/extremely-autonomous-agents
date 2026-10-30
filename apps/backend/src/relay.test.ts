import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { createApp } from './app.js';
import { connect, migrate, type Db } from './db.js';
import { acceptInvite, createInvite, createOrg, ensureUser, registerHost } from './directory.js';
import { attachRelay } from './relay.js';
import { createAuth } from './tokens.js';

// The relay: hosts sign in with their secret, members with their session, and
// what passes between them is passed on untouched.

const ISSUER = 'https://clerk.test';
let db: Db;
let server: Server;
let ws = '';
let key: CryptoKey;
let relay: ReturnType<typeof attachRelay>;
let orgId = '';
let hostSecret = '';

before(async () => {
  db = await connect('');
  await migrate(db);
  const pair = await generateKeyPair('RS256');
  key = pair.privateKey;
  const auth = await createAuth({
    sessionKeys: createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k', alg: 'RS256' }] }),
    sessionIssuer: ISSUER,
    profile: async id => ({ id, email: `${id}@example.com`, name: id }),
  });
  server = createServer(createApp(db, auth));
  relay = attachRelay(server, db, auth);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  ws = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;

  for (const id of ['ana', 'ben', 'cat']) await ensureUser(db, { id, email: `${id}@example.com`, name: id });
  orgId = (await createOrg(db, 'ana', 'Relay Co')).id;
  hostSecret = (await registerHost(db, orgId, 'ana', 'k'.repeat(43))).hostSecret;
  const inv = await createInvite(db, orgId, 'ana', {});
  await acceptInvite(db, inv.code, { id: 'ben', email: 'ben@example.com', name: 'ben' });
});
after(() => {
  relay.close();
  server.close();
});

const session = (sub: string) =>
  new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'k' }).setSubject(sub).setIssuer(ISSUER).setIssuedAt().setExpirationTime('5m').sign(key);

// A connection that collects what it's sent, and how it closed.
function open(path: string, first: unknown) {
  const sock = new WebSocket(ws + path);
  const got: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  let closed: { code: number; reason: string } | null = null;
  sock.onopen = () => sock.send(JSON.stringify(first));
  sock.onmessage = e => (got.push(JSON.parse(String(e.data))), waiters.splice(0).forEach(w => w()));
  sock.onclose = e => ((closed = { code: e.code, reason: e.reason }), waiters.splice(0).forEach(w => w()));
  const until = async (ok: () => boolean) => {
    const end = Date.now() + 3000;
    while (!ok()) {
      if (Date.now() > end) throw new Error(`waited: ${JSON.stringify(got)} ${JSON.stringify(closed)}`);
      await new Promise<void>(r => (waiters.push(r), setTimeout(r, 50)));
    }
  };
  return {
    sock,
    got,
    closed: () => closed as { code: number; reason: string } | null,
    until,
    send: (m: unknown) => sock.send(JSON.stringify(m)),
  };
}

test('a host signs in with its secret, and nothing else', async () => {
  const bad = open('/relay/host', { t: 'auth', secret: 'wrong' });
  await bad.until(() => !!bad.closed());
  assert.equal(bad.closed()!.code, 4001);
  const host = open('/relay/host', { t: 'auth', secret: hostSecret });
  await host.until(() => host.got.some(m => m.t === 'ready'));
  assert.equal(relay.online(orgId), true);
  host.sock.close();
  await host.until(() => !!host.closed());
});

test("members only, and only while their organisation's host is there", async () => {
  const stranger = open('/relay/app', { t: 'auth', token: await session('cat'), org: orgId });
  await stranger.until(() => !!stranger.closed());
  assert.equal(stranger.closed()!.code, 4003);
  const nobody = open('/relay/app', { t: 'auth', token: 'not-a-session', org: orgId });
  await nobody.until(() => !!nobody.closed());
  assert.equal(nobody.closed()!.code, 4001);
  await new Promise(r => setTimeout(r, 100));
  const early = open('/relay/app', { t: 'auth', token: await session('ben'), org: orgId });
  await early.until(() => !!early.closed());
  assert.equal(early.closed()!.code, 4004);
});

test('what passes between app and host is passed on untouched, both ways', async () => {
  const host = open('/relay/host', { t: 'auth', secret: hostSecret });
  await host.until(() => host.got.some(m => m.t === 'ready'));
  const app = open('/relay/app', { t: 'auth', token: await session('ben'), org: orgId });
  await app.until(() => app.got.some(m => m.t === 'ready'));
  await host.until(() => host.got.some(m => m.t === 'open'));
  const c = host.got.find(m => m.t === 'open')!.c;

  app.send({ t: 'data', d: 'b3BhcXVl' });
  await host.until(() => host.got.some(m => m.t === 'data'));
  assert.deepEqual(host.got.find(m => m.t === 'data'), { t: 'data', c, d: 'b3BhcXVl' });
  host.send({ t: 'data', c, d: 'cmVwbHk=' });
  await app.until(() => app.got.some(m => m.t === 'data'));
  assert.deepEqual(app.got.find(m => m.t === 'data'), { t: 'data', d: 'cmVwbHk=' });
  // Another channel's number goes nowhere.
  host.send({ t: 'data', c: 999, d: 'eA==' });

  // The app leaves: the host hears. The host goes: its apps hear.
  const app2 = open('/relay/app', { t: 'auth', token: await session('ana'), org: orgId });
  await app2.until(() => app2.got.some(m => m.t === 'ready'));
  app.sock.close();
  await host.until(() => host.got.some(m => m.t === 'close' && m.c === c));
  host.sock.close();
  await app2.until(() => !!app2.closed());
  assert.equal(app2.closed()!.code, 4004);
  assert.equal(relay.online(orgId), false);
});

test('a live connection outlasts the heartbeat: answered pings keep it open', async () => {
  const s = createServer();
  const r = attachRelay(s, db, await createAuth({ sessionKeys: createLocalJWKSet({ keys: [] }), sessionIssuer: ISSUER, profile: async id => ({ id, email: '', name: id }) }), { beatMs: 100 });
  await new Promise<void>(done => s.listen(0, '127.0.0.1', done));
  const sock = new WebSocket(`ws://127.0.0.1:${(s.address() as { port: number }).port}/relay/host`);
  let closed = false;
  let ready = false;
  sock.onopen = () => sock.send(JSON.stringify({ t: 'auth', secret: hostSecret }));
  sock.onmessage = e => (ready ||= JSON.parse(String(e.data)).t === 'ready');
  sock.onclose = () => (closed = true);
  await new Promise(done => setTimeout(done, 650)); // six beats
  assert.equal(ready, true);
  assert.equal(closed, false);
  sock.close();
  r.close();
  s.close();
});

test('a host that connects again takes over from its old connection', async () => {
  const first = open('/relay/host', { t: 'auth', secret: hostSecret });
  await first.until(() => first.got.some(m => m.t === 'ready'));
  const second = open('/relay/host', { t: 'auth', secret: hostSecret });
  await second.until(() => second.got.some(m => m.t === 'ready'));
  await first.until(() => !!first.closed());
  assert.equal(relay.online(orgId), true);
  second.sock.close();
  await second.until(() => !!second.closed());
});
