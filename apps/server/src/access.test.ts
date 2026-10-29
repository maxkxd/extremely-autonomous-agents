import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, beforeEach, test } from 'node:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import {
  AccessError,
  actorFor,
  asActor,
  authorize,
  checkToken,
  currentActor,
  personFor,
  recordAction,
  requireMakerOrAdmin,
  setAccessConfig,
  useKeysForTests,
  type Actor,
} from './access.js';
import { remove, save, type AgentFiles } from './files.js';
import { FLEET_ENGINEER } from './runner/agent.js';
import { all, resetDbForTests, run as exec } from './runner/db.js';

// The host's side of org access tokens: a key of our own stands in for the
// backend's, signing exactly what it signs (apps/backend/src/tokens.ts).

const ISSUER = 'http://backend.test';
const ORG = 'org-1';
let key: CryptoKey;
let otherKey: CryptoKey;
let testKeys: ReturnType<typeof createLocalJWKSet>;

before(async () => {
  const pair = await generateKeyPair('EdDSA');
  key = pair.privateKey;
  otherKey = (await generateKeyPair('EdDSA')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'EdDSA' };
  testKeys = createLocalJWKSet({ keys: [jwk] });
  useKeysForTests(testKeys);
});
after(() => useKeysForTests(null));
beforeEach(() => {
  resetDbForTests();
  setAccessConfig({ issuer: ISSUER, orgId: ORG });
});

const token = (o: { sub?: string; org?: string; role?: string; name?: string; aud?: string; iss?: string; exp?: number; signer?: CryptoKey } = {}) =>
  new SignJWT({ org: o.org ?? ORG, role: o.role ?? 'member', name: o.name ?? 'Ben', kind: 'team' })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
    .setSubject(o.sub ?? 'user_ben')
    .setIssuer(o.iss ?? ISSUER)
    .setAudience(o.aud ?? 'eaa-host')
    .setIssuedAt()
    .setExpirationTime(o.exp ?? Math.floor(Date.now() / 1000) + 900)
    .sign(o.signer ?? key);

const req = (address: string, authorization?: string) => ({ headers: authorization ? { authorization } : {}, socket: { remoteAddress: address } }) as never;
const status = async (p: Promise<unknown>) => p.then(() => 200, e => (e instanceof AccessError ? e.status : 500));

test('a token from the issuer, for this organisation, is that person in that role', async () => {
  assert.deepEqual(await checkToken(await token({ role: 'admin', name: 'Ben' })), { id: 'user_ben', name: 'Ben', role: 'admin', via: 'token' });
  // Over the network or not, a token is checked the same way.
  assert.equal((await actorFor(req('203.0.113.9', `Bearer ${await token()}`))).id, 'user_ben');
});

test('anything else is turned away', async () => {
  assert.equal(await status(checkToken(await token({ org: 'org-2' }))), 403);
  assert.equal(await status(checkToken(await token({ aud: 'something-else' }))), 401);
  assert.equal(await status(checkToken(await token({ iss: 'http://elsewhere.test' }))), 401);
  assert.equal(await status(checkToken(await token({ exp: Math.floor(Date.now() / 1000) - 60 }))), 401);
  assert.equal(await status(checkToken(await token({ signer: otherKey }))), 401);
  assert.equal(await status(checkToken(await token({ role: 'superuser' }))), 401);
  assert.equal(await status(checkToken('not.a.token')), 401);
  // Not hosting an organisation yet: no token at all.
  setAccessConfig({ orgId: null });
  assert.equal(await status(checkToken(await token())), 401);
});

test("the issuer's keys are fetched from its /.well-known/jwks.json", async () => {
  const pub = (await generateKeyPair('EdDSA')).publicKey; // another key it publishes
  const pair = await generateKeyPair('EdDSA');
  const jwks = JSON.stringify({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'EdDSA' }, { ...(await exportJWK(pub)), kid: 'k0', alg: 'EdDSA' }] });
  let asked = '';
  const server = createServer((r, res) => ((asked = r.url ?? ''), res.writeHead(200, { 'content-type': 'application/json' }).end(jwks)));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  useKeysForTests(null);
  try {
    setAccessConfig({ issuer });
    assert.equal((await checkToken(await token({ iss: issuer, signer: pair.privateKey }))).id, 'user_ben');
    assert.equal(asked, '/.well-known/jwks.json');
  } finally {
    server.close();
    useKeysForTests(testKeys);
  }
});

test('this computer itself is its owner; elsewhere needs a token', async () => {
  exec("INSERT INTO settings (key, value) VALUES ('host_person', '\"Ana\"')");
  for (const a of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.deepEqual(await actorFor(req(a)), { id: 'local', name: 'Ana', role: 'owner', via: 'local', here: true });
  assert.equal(await status(actorFor(req('192.168.1.20'))), 401);
  assert.equal(await status(actorFor(req('::ffff:10.0.0.5'))), 401);
  // A bad token isn't waved through just because it came from here.
  assert.equal(await status(actorFor(req('127.0.0.1', 'Bearer nope'))), 401);
});

test("'at the host computer' only when the person's own agency says so, in an organisation's agency", async () => {
  const t = `Bearer ${await token()}`;
  const with_ = (address: string, here?: string) => ({ headers: { authorization: t, ...(here ? { 'x-eaa-here': here } : {}) }, socket: { remoteAddress: address } }) as never;
  assert.equal((await actorFor(with_('127.0.0.1', '1'))).here, false, 'not an organisation’s agency');
  process.env.EAA_HOSTED_ORG = ORG;
  try {
    assert.equal((await actorFor(with_('127.0.0.1', '1'))).here, true);
    assert.equal((await actorFor(with_('127.0.0.1'))).here, false);
    assert.equal((await actorFor(with_('203.0.113.9', '1'))).here, false, 'never from elsewhere');
  } finally {
    delete process.env.EAA_HOSTED_ORG;
  }
  assert.equal((await actorFor(req('127.0.0.1'))).here, true, 'this computer’s own person is here');
});

const member: Actor ={ id: 'user_ben', name: 'Ben', role: 'member', via: 'token' };
const admin: Actor = { id: 'user_cat', name: 'Cat', role: 'admin', via: 'token' };
const owner: Actor = { id: 'user_ana', name: 'Ana', role: 'owner', via: 'token' };
const local: Actor = { id: 'local', name: 'Ana', role: 'owner', via: 'local' };
const may = (a: Actor, route: string) => {
  const [method, path] = route.split(' ');
  try {
    authorize(a, method, path);
    return true;
  } catch {
    return false;
  }
};

test('members: see everything, build and run agents, connect integrations', () => {
  for (const r of [
    'GET /api/runner/agents',
    'GET /api/connections',
    'GET /api/runner/approvals',
    'POST /api/builder/build',
    'POST /api/agents',
    'POST /api/agents/delete',
    'POST /api/runner/agent',
    'POST /api/runner/run-now',
    'POST /api/dm',
    'POST /api/integrations/connect',
    'POST /api/runner/approvals/decide',
    // Their own agency MCP address, acting as them; Send to IDE for their own agents' requests.
    'GET /api/settings/agency-mcp',
    'POST /api/settings/agency-mcp',
    'POST /api/runner/requests/ide',
  ])
    assert.ok(may(member, r), r);
});

test('admins: AI connections, the agency, caps, settings; members not', () => {
  for (const r of [
    'POST /api/connections/key',
    'POST /api/connections/disconnect',
    'POST /api/runner/agency',
    'POST /api/usage',
    'POST /api/events/tunnel',
    'POST /api/settings/code-plugins',
    'POST /api/browser/sign-in',
    'POST /api/something/new', // a write nobody listed needs an admin
  ]) {
    assert.ok(!may(member, r), r);
    assert.ok(may(admin, r), r);
    assert.ok(may(owner, r), r);
  }
});

test('some things happen only on the host computer itself', () => {
  for (const r of ['POST /api/settings/access', 'POST /api/settings/host-person', 'GET /api/oauth/chatgpt/callback']) {
    assert.ok(!may(owner, r), r);
    assert.ok(may(local, r), r);
  }
});

test("approvals and requests: the agent's maker, or an admin", async () => {
  const files: AgentFiles = { id: 'zz-access-test', name: 'Access Test', department: 'ops', charter: '', tools: '', kpi: '', models: [] };
  await save(files, { name: files.name, department: 'ops', output: [], status: 'ready', owner: 'Ben', ownerId: 'user_ben' });
  try {
    assert.equal(await status(requireMakerOrAdmin(files.id, null, member)), 200);
    assert.equal(await status(requireMakerOrAdmin(files.id, null, { ...member, id: 'user_dan' })), 403);
    assert.equal(await status(requireMakerOrAdmin(files.id, null, admin)), 200);
    assert.equal(await status(requireMakerOrAdmin(files.id, null, local)), 200);
    // The Agency Engineer's go-live for a request belongs to whoever's agent filed it.
    exec("INSERT INTO requests (id, agent_id, what, why, created_at) VALUES (7, 'zz-access-test', 'a tool', 'needed', 0)");
    assert.equal(await status(requireMakerOrAdmin(FLEET_ENGINEER, 7, member)), 200);
    assert.equal(await status(requireMakerOrAdmin(FLEET_ENGINEER, 7, { ...member, id: 'user_dan' })), 403);
    assert.equal(await status(requireMakerOrAdmin(FLEET_ENGINEER, null, member)), 403);
  } finally {
    await remove(files.id);
  }
});

test('a route runs as whoever asked, and the body never says otherwise', async () => {
  assert.equal(currentActor().via, 'local');
  await asActor(member, async () => {
    await Promise.resolve();
    assert.equal(currentActor().id, 'user_ben');
    assert.equal(personFor('Ana'), 'Ben');
  });
  assert.equal(personFor('Ana'), 'Ana'); // on the host computer, as the app says
});

test('who did what: the change and what it was about, never keys or words', () => {
  recordAction(member, 'POST', '/api/integrations/connect', { id: 'github', key: 'ghp_secret' }, 1000);
  recordAction(admin, 'POST', '/api/runner/approvals/decide', { id: 'ap1', decision: 'approved', note: 'looks fine' }, 2000);
  const rows = all<{ actor_id: string; actor_name: string; role: string; via: string; route: string; about: string }>('SELECT * FROM person_actions ORDER BY at');
  assert.deepEqual(
    rows.map(r => [r.actor_name, r.role, r.via, r.route, JSON.parse(r.about)]),
    [
      ['Ben', 'member', 'token', 'POST /api/integrations/connect', { id: 'github' }],
      ['Cat', 'admin', 'token', 'POST /api/runner/approvals/decide', { id: 'ap1', decision: 'approved' }],
    ],
  );
});
