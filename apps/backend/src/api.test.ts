import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT, type CryptoKey } from 'jose';
import { createApp } from './app.js';
import { connect, migrate, type Db } from './db.js';
import { ORG_TOKEN_AUDIENCE, createAuth } from './tokens.js';

// The whole API over HTTP, with PGlite for Postgres and a key of our own standing in for Clerk's.

const ISSUER = 'https://clerk.test';
const PEOPLE: Record<string, { email: string; name: string }> = {
  ana: { email: 'ana@example.com', name: 'Ana' },
  ben: { email: 'ben@example.com', name: 'Ben' },
  cat: { email: 'cat@example.com', name: 'Cat' },
};

let db: Db;
let server: Server;
let base = '';
let clerkKey: CryptoKey;

before(async () => {
  db = await connect('');
  await migrate(db);
  await migrate(db); // starting again is harmless
  const pair = await generateKeyPair('RS256');
  clerkKey = pair.privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'clerk', alg: 'RS256' };
  const auth = await createAuth({
    sessionKeys: createLocalJWKSet({ keys: [jwk] }),
    sessionIssuer: ISSUER,
    profile: async id => ({ id, ...PEOPLE[id] }),
    issuer: 'http://backend.test',
  });
  server = createServer(createApp(db, auth));
  await new Promise<void>(r => server.listen(0, r));
  base = `http://localhost:${(server.address() as { port: number }).port}`;
});

after(async () => {
  server.close();
  await db.close();
});

const session = (sub: string, issuer = ISSUER) =>
  new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'clerk' }).setSubject(sub).setIssuer(issuer).setIssuedAt().setExpirationTime('5m').sign(clerkKey);

async function call(who: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who) headers.authorization = `Bearer ${await session(who)}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as any };
}

test('signing in needs a real session', async () => {
  assert.equal((await call(null, 'GET', '/me')).status, 401);
  const forged = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${await session('ana', 'https://elsewhere.test')}` } });
  assert.equal(forged.status, 401);
  assert.equal((await call(null, 'GET', '/health')).status, 200);
});

test('everyone gets one personal agency, made once', async () => {
  const first = await call('ana', 'GET', '/me');
  assert.equal(first.status, 200);
  assert.equal(first.body.user.email, 'ana@example.com');
  assert.deepEqual(
    first.body.orgs.map((o: any) => [o.kind, o.name, o.role]),
    [['personal', "Ana's agency", 'owner']],
  );
  await Promise.all([call('ana', 'GET', '/me'), call('ana', 'GET', '/me')]);
  assert.equal((await call('ana', 'GET', '/me')).body.orgs.length, 1);
});

test('the personal agency cannot be shared, left or deleted', async () => {
  const personal = (await call('ana', 'GET', '/me')).body.orgs[0].id;
  assert.equal((await call('ana', 'POST', `/orgs/${personal}/invites`, {})).status, 400);
  assert.equal((await call('ana', 'POST', `/orgs/${personal}/leave`)).status, 400);
  assert.equal((await call('ana', 'DELETE', `/orgs/${personal}`)).status, 400);
});

test('own one organisation, join many', async () => {
  const anaOrg = await call('ana', 'POST', '/orgs', { name: '  Ana   Co ' });
  assert.equal(anaOrg.status, 200);
  assert.equal(anaOrg.body.name, 'Ana Co');
  assert.equal((await call('ana', 'POST', '/orgs', { name: 'Second' })).status, 409);
  assert.equal((await call('ben', 'POST', '/orgs', { name: '' })).status, 400);
  const benOrg = await call('ben', 'POST', '/orgs', { name: 'Ben Ltd' });

  // Cat joins both.
  for (const [owner, org] of [['ana', anaOrg.body.id], ['ben', benOrg.body.id]]) {
    const inv = await call(owner, 'POST', `/orgs/${org}/invites`, {});
    assert.equal((await call('cat', 'POST', `/invites/${inv.body.code}/accept`)).status, 200);
  }
  const cat = (await call('cat', 'GET', '/me')).body.orgs;
  assert.deepEqual(
    cat.map((o: any) => [o.kind, o.name, o.role]),
    [['personal', "Cat's agency", 'owner'], ['team', 'Ana Co', 'member'], ['team', 'Ben Ltd', 'member']],
  );
});

test('invites: preview, email lock, single use, revoke', async () => {
  const org = (await call('ana', 'GET', '/me')).body.orgs.find((o: any) => o.kind === 'team').id;
  const forBen = await call('ana', 'POST', `/orgs/${org}/invites`, { email: 'BEN@example.com', role: 'admin' });
  assert.equal(forBen.body.email, 'ben@example.com');
  const preview = await call(null, 'GET', `/invites/${forBen.body.code}`);
  assert.equal(preview.status, 401); // only for people signed in
  assert.deepEqual((await call('cat', 'GET', `/invites/${forBen.body.code}`)).body, { org: 'Ana Co', invitedBy: 'Ana', role: 'admin', forEmail: 'ben@example.com' });
  assert.equal((await call('cat', 'POST', `/invites/${forBen.body.code}/accept`)).status, 403);
  assert.equal((await call('ben', 'POST', `/invites/${forBen.body.code}/accept`)).status, 200);
  assert.equal((await call('ben', 'POST', `/invites/${forBen.body.code}/accept`)).status, 410);

  const spare = await call('ana', 'POST', `/orgs/${org}/invites`, {});
  assert.equal((await call('ana', 'GET', `/orgs/${org}/invites`)).body.length, 1);
  assert.equal((await call('cat', 'DELETE', `/invites/${spare.body.code}`)).status, 403);
  assert.equal((await call('ana', 'DELETE', `/invites/${spare.body.code}`)).status, 200);
  assert.equal((await call('ana', 'GET', `/invites/${spare.body.code}`)).status, 404);
  assert.equal((await call('ana', 'POST', `/orgs/${org}/invites`, { email: 'not an email' })).status, 400);
});

test('roles: who can invite, promote and remove whom', async () => {
  const org = (await call('ana', 'GET', '/me')).body.orgs.find((o: any) => o.kind === 'team').id;
  const roles = async () => Object.fromEntries((await call('ana', 'GET', `/orgs/${org}/members`)).body.map((m: any) => [m.userId, m.role]));
  assert.deepEqual(await roles(), { ana: 'owner', ben: 'admin', cat: 'member' });

  assert.equal((await call('cat', 'POST', `/orgs/${org}/invites`, {})).status, 403); // members don't invite
  assert.equal((await call('ben', 'POST', `/orgs/${org}/invites`, { role: 'admin' })).status, 403); // admins invite members only
  assert.equal((await call('ben', 'POST', `/orgs/${org}/invites`, {})).status, 200);
  assert.equal((await call('ben', 'PATCH', `/orgs/${org}/members/cat`, { role: 'admin' })).status, 403); // only the owner changes roles
  assert.equal((await call('ana', 'PATCH', `/orgs/${org}/members/ana`, { role: 'member' })).status, 400);
  assert.equal((await call('ana', 'PATCH', `/orgs/${org}/members/cat`, { role: 'owner' })).status, 400);
  assert.equal((await call('cat', 'DELETE', `/orgs/${org}/members/ben`)).status, 403);
  assert.equal((await call('ben', 'DELETE', `/orgs/${org}/members/ana`)).status, 400);
  assert.equal((await call('ana', 'POST', `/orgs/${org}/leave`)).status, 400); // the owner deletes instead

  assert.equal((await call('ben', 'PATCH', `/orgs/${org}`, { name: 'Ana & Co' })).status, 200);
  assert.equal((await call('cat', 'PATCH', `/orgs/${org}`, { name: 'Nope' })).status, 403);
  assert.equal((await call('ben', 'DELETE', `/orgs/${org}/members/cat`)).status, 200);
  assert.equal((await call('cat', 'GET', `/orgs/${org}/members`)).status, 404); // gone means it isn't there for you
  assert.equal((await call('ben', 'POST', `/orgs/${org}/leave`)).status, 200);
  assert.deepEqual(await roles(), { ana: 'owner' });
});

test('org access tokens: checkable against the published keys, and only for members', async () => {
  const org = (await call('ana', 'GET', '/me')).body.orgs.find((o: any) => o.kind === 'team').id;
  assert.equal((await call('cat', 'POST', `/orgs/${org}/token`)).status, 404);
  const issued = await call('ana', 'POST', `/orgs/${org}/token`);
  assert.equal(issued.status, 200);
  assert.ok(issued.body.expiresAt > Date.now() + 14 * 60_000);

  // What a host does: our keys, our issuer, its audience.
  const keys = (await call(null, 'GET', '/.well-known/jwks.json')).body;
  assert.equal(keys.keys.length, 1);
  assert.equal(keys.keys[0].d, undefined, 'never the private half');
  const { payload, protectedHeader } = await jwtVerify(issued.body.token, createLocalJWKSet(keys), { issuer: 'http://backend.test', audience: ORG_TOKEN_AUDIENCE });
  assert.equal(protectedHeader.alg, 'EdDSA');
  assert.deepEqual({ sub: payload.sub, org: payload.org, role: payload.role, name: payload.name, kind: payload.kind }, { sub: 'ana', org, role: 'owner', name: 'Ana', kind: 'team' });
  await assert.rejects(jwtVerify(issued.body.token, createLocalJWKSet(keys), { audience: 'something-else' }));
});

test('hosts: the owner registers one, members see its key', async () => {
  const org = (await call('ana', 'GET', '/me')).body.orgs.find((o: any) => o.kind === 'team').id;
  const inv = await call('ana', 'POST', `/orgs/${org}/invites`, {});
  await call('cat', 'POST', `/invites/${inv.body.code}/accept`);
  const publicKey = 'k'.repeat(43);

  assert.equal((await call('ana', 'GET', `/orgs/${org}/host`)).body.host, null);
  assert.equal((await call('cat', 'POST', `/orgs/${org}/host`, { publicKey })).status, 403);
  assert.equal((await call('ana', 'POST', `/orgs/${org}/host`, { publicKey: 'short' })).status, 400);
  const reg = await call('ana', 'POST', `/orgs/${org}/host`, { publicKey });
  assert.equal(reg.status, 200);
  assert.equal(typeof reg.body.hostSecret, 'string');
  assert.equal((await call('cat', 'GET', `/orgs/${org}/host`)).body.host.publicKey, publicKey);
  assert.equal((await call('cat', 'GET', '/me')).body.orgs.find((o: any) => o.id === org).host.registered, true);
  assert.equal((await call('ben', 'GET', `/orgs/${org}/host`)).status, 404);

  const stored = await db.query<{ secret_hash: string }>('SELECT secret_hash FROM hosts WHERE org_id = $1', [org]);
  assert.notEqual(stored.rows[0].secret_hash, reg.body.hostSecret, 'only its hash is kept');
});

test('deleting an organisation takes its members, invites and host with it', async () => {
  const org = (await call('ana', 'GET', '/me')).body.orgs.find((o: any) => o.kind === 'team').id;
  assert.equal((await call('cat', 'DELETE', `/orgs/${org}`)).status, 403);
  assert.equal((await call('ana', 'DELETE', `/orgs/${org}`)).status, 200);
  for (const table of ['members', 'invites', 'hosts']) assert.equal((await db.query(`SELECT 1 FROM ${table} WHERE org_id = $1`, [org])).rows.length, 0, table);
  assert.equal((await call('ana', 'POST', '/orgs', { name: 'Ana Again' })).status, 200); // free to own one again
});

test('bad requests answer plainly', async () => {
  assert.equal((await call('ana', 'GET', '/nowhere')).status, 404);
  const res = await fetch(`${base}/orgs`, { method: 'POST', headers: { authorization: `Bearer ${await session('ana')}` }, body: '{not json' });
  assert.equal(res.status, 400);
  const pre = await fetch(`${base}/me`, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /authorization/);
});

test('development sign-in: only when asked for, and a session like any other', async () => {
  // The tests run with Clerk's stand-in, so it's off here.
  assert.equal((await call(null, 'GET', '/config')).body.signIn, 'clerk');
  assert.equal((await call(null, 'POST', '/dev/sign-in', { email: 'dee@example.com' })).status, 404);

  const auth = await createAuth({ dev: true, issuer: 'http://backend.test' });
  const dev = createServer(createApp(db, auth));
  await new Promise<void>(r => dev.listen(0, r));
  const url = `http://localhost:${(dev.address() as { port: number }).port}`;
  try {
    assert.equal(((await (await fetch(`${url}/config`)).json()) as any).signIn, 'dev');
    const bad = await fetch(`${url}/dev/sign-in`, { method: 'POST', body: JSON.stringify({ email: 'nope' }) });
    assert.equal(bad.status, 400);
    const { token } = (await (await fetch(`${url}/dev/sign-in`, { method: 'POST', body: JSON.stringify({ email: 'Dee@Example.com', name: 'Dee' }) })).json()) as any;
    const me = (await (await fetch(`${url}/me`, { headers: { authorization: `Bearer ${token}` } })).json()) as any;
    assert.equal(me.user.email, 'dee@example.com');
    assert.equal(me.orgs[0].name, "Dee's agency");
    // Same email, same person.
    const again = (await (await fetch(`${url}/dev/sign-in`, { method: 'POST', body: JSON.stringify({ email: 'dee@example.com' }) })).json()) as any;
    assert.equal(((await (await fetch(`${url}/me`, { headers: { authorization: `Bearer ${again.token}` } })).json()) as any).user.id, me.user.id);
  } finally {
    dev.close();
  }
});

test("hosts check a member's role with their own secret, never a person's session", async () => {
  const org = (await call('ana', 'POST', '/orgs', { name: 'Host Check' })).body.id ?? (await call('ana', 'GET', '/me')).body.orgs.find((o: any) => o.kind === 'team').id;
  const { hostSecret } = (await call('ana', 'POST', `/orgs/${org}/host`, { publicKey: 'h'.repeat(43) })).body;
  const inv = await call('ana', 'POST', `/orgs/${org}/invites`, {});
  await call('ben', 'POST', `/invites/${inv.body.code}/accept`);
  const ask = (who: string, auth?: string) => fetch(`${base}/host/members/${who}`, { headers: auth ? { authorization: auth } : {} }).then(async r => [r.status, await r.json()]);
  assert.deepEqual(await ask('ben', `Host ${hostSecret}`), [200, { role: 'member', name: 'Ben' }]);
  assert.deepEqual(await ask('ana', `Host ${hostSecret}`), [200, { role: 'owner', name: 'Ana' }]);
  assert.equal((await ask('cat', `Host ${hostSecret}`))[0], 404);
  assert.equal((await ask('ben', 'Host wrong'))[0], 401);
  assert.equal((await ask('ben', `Bearer ${await session('ana')}`))[0], 401);
  assert.equal((await ask('ben'))[0], 401);
  await call('ana', 'DELETE', `/orgs/${org}/members/ben`);
  assert.equal((await ask('ben', `Host ${hostSecret}`))[0], 404); // removed: no longer
});
