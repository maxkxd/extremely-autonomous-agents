import assert from 'node:assert/strict';
import { before, test } from 'node:test';

// A self-hosted organisation: its own accounts, invites, sessions and tokens,
// trusted by nothing but itself. (The mode is read once, so it's set first.)
process.env.EAA_SELF_HOSTED = '1';
process.env.EAA_HOSTED_ORG = 'self-test-org';
const self = await import('./selfhost.js');
const { checkToken } = await import('./access.js');
const { resetDbForTests } = await import('./runner/db.js');

const status = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
    return 200;
  } catch (e) {
    return (e as { status?: number }).status ?? 500;
  }
};
const local = { id: 'local', name: 'Ana', role: 'owner' as const, via: 'local' as const };

before(() => resetDbForTests());

test('set up once, with its owner', async () => {
  assert.equal(await status(self.setup({ email: 'ana@example.com', name: 'Ana', password: 'short' })), 400);
  await self.setup({ email: 'Ana@Example.com', name: 'Ana', password: 'a long enough password', orgName: 'Self Co' });
  assert.equal(await status(self.setup({ email: 'eve@example.com', name: 'Eve', password: 'another long password' })), 409);
  assert.deepEqual(self.members().map(m => [m.email, m.role]), [['ana@example.com', 'owner']]);
});

test('signing in: the right password, a session, then org tokens this host trusts', async () => {
  assert.equal(await status(self.signIn({ email: 'ana@example.com', password: 'wrong password!' })), 401);
  const s = await self.signIn({ email: 'ANA@example.com', password: 'a long enough password' });
  assert.equal(s.org.name, 'Self Co');
  const { token } = await self.tokenFor({ session: s.session });
  const actor = await checkToken(token);
  assert.deepEqual([actor.name, actor.role, actor.via], ['Ana', 'owner', 'token']);
  assert.equal(await status(self.tokenFor({ session: 'made-up' })), 401);
  // Signed out: that session is done.
  self.signOut({ session: s.session });
  assert.equal(await status(self.tokenFor({ session: s.session })), 401);
});

test('too many wrong passwords: a pause', async () => {
  for (let i = 0; i < 5; i++) await status(self.signIn({ email: 'ana@example.com', password: `nope ${i} nope nope` }));
  assert.equal(await status(self.signIn({ email: 'ana@example.com', password: 'a long enough password' })), 429);
});

test('invites: joining, roles at once, removal at once', async () => {
  assert.equal(await status(() => self.createInvite({ ...local, role: 'member' }, {})), 403);
  const inv = self.createInvite(local, { email: 'ben@example.com' });
  assert.deepEqual(self.previewInvite(inv.code), { org: 'Self Co', role: 'member', forEmail: 'ben@example.com' });
  assert.equal(await status(self.acceptInvite({ code: inv.code, email: 'cat@example.com', password: 'cats password here' })), 403);
  const ben = await self.acceptInvite({ code: inv.code, email: 'ben@example.com', name: 'Ben', password: 'bens password here' });
  assert.equal(await status(self.acceptInvite({ code: inv.code, email: 'ben@example.com', password: 'bens password here' })), 410);
  const { token } = await self.tokenFor({ session: ben.session });
  assert.equal((await checkToken(token)).role, 'member');

  // Promoted: the same token says admin straight away (the role is the host's, not the token's).
  self.setRole(local, ben.you.id, 'admin');
  assert.equal((await checkToken(token)).role, 'admin');
  assert.equal(await status(() => self.createInvite({ id: ben.you.id, name: 'Ben', role: 'admin', via: 'token' }, { role: 'admin' })), 403);

  // Removed: that token and session stop at once.
  self.removeMember(local, ben.you.id);
  assert.equal(await status(checkToken(token)), 401);
  assert.equal(await status(self.tokenFor({ session: ben.session })), 401);
});

test("the owner can't be removed or leave; a token from anywhere else isn't trusted", async () => {
  const owner = self.members()[0];
  assert.equal(await status(() => self.removeMember(local, owner.userId)), 400);
  assert.equal(await status(() => self.leave(local)), 400);
  assert.equal(await status(checkToken('eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJ4In0.c2ln')), 401);
});

test('the address members use', () => {
  assert.equal(self.setAddress('https://agency.example.com/').address, 'https://agency.example.com');
  assert.throws(() => self.setAddress('agency.example.com'));
});
