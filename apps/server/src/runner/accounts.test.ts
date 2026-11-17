import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import {
  accountRow,
  accountsDue,
  accountsForPrompt,
  accountsOwed,
  attemptFailed,
  baseDomain,
  cancelAccount,
  judgeAccountPage,
  markWorking,
  needAccounts,
  nudged,
  NUDGE_MS,
  pageKept,
  passwordTyped,
  personFinished,
  retryIn,
  startAttempt,
  workerOf,
  type PageFacts,
} from './accounts.js';
import { FLEET_ENGINEER } from './agent.js';
import { one, resetDbForTests, run as exec } from './db.js';
import { listPasswords, passwordRow, readPassword } from './passwords.js';

// The accounts agents owe (accounts.ts): written down before any sign-up, hidden from
// the password store until the app has seen them work, owed again after every try that
// can't be shown to have worked, and ended only by a person.

const AGENT = 'zz-growth';
const T0 = 1_800_000_000_000;
const start = (id: string, username = 'northside@bikes.test', fresh = false, runId = 'r_1') => startAttempt(id, { username, browser: 1, runId, fresh, now: T0 });
const signedIn = (over: Partial<PageFacts> = {}): PageFacts => ({ url: 'https://x.test/settings/account', passwordFields: 0, text: 'Account\nnorthside@bikes.test', controls: 'Log out /logout', ...over });

beforeEach(() => resetDbForTests());

test('accounts are written down once: asking for the same one again changes nothing', () => {
  const first = needAccounts(AGENT, [{ site: 'https://www.x.test/signup', purpose: 'Brand account' }, { site: 'x.test', purpose: 'Outreach account 2' }], T0);
  assert.deepEqual(first.map(r => [r.site, r.state]), [['x.test', 'needed'], ['x.test', 'needed']]);
  const again = needAccounts(AGENT, [{ site: 'x.test', purpose: 'brand account' }], T0 + 5);
  assert.equal(again[0].id, first[0].id);
  assert.equal(accountsOwed(AGENT).length, 2);
});

test("a sign-up's password is hidden from the store until the account is seen working", async () => {
  const [a] = needAccounts(AGENT, [{ site: 'x.test', purpose: 'Brand account' }], T0);
  const t = await start(a.id);
  assert.equal(t.reuse, false);
  assert.equal(accountRow(a.id)!.state, 'started');
  assert.deepEqual(listPasswords('x.test'), [], 'not an account yet: not in the store');
  assert.equal((await readPassword(t.passwordId)).length, 20, 'but it can be typed');
  passwordTyped(t.passwordId, true, 'https://x.test/i/flow/signup', T0 + 1);
  const done = markWorking(a.id, T0 + 2);
  assert.equal(done.state, 'working');
  const rows = listPasswords('x.test');
  assert.deepEqual(rows.map(r => [r.username, !!r.confirmed_at]), [['northside@bikes.test', true]]);
  assert.equal(accountsOwed(AGENT).length, 0);
});

test('a failed try whose password never reached the site: the password is deleted, and the next try makes a new one', async () => {
  const [a] = needAccounts(AGENT, [{ site: 'x.test', purpose: 'Brand account' }], T0);
  const t = await start(a.id);
  const failed = await attemptFailed(a.id, 'the run ended before the sign-up was finished and checked', T0 + 10);
  assert.deepEqual([failed!.state, failed!.attempts, failed!.password_id], ['needed', 1, null]);
  assert.equal(passwordRow(t.passwordId), undefined, 'nothing saved for a sign-up that did not go through');
  const next = await start(a.id);
  assert.equal(next.reuse, false);
  assert.notEqual(next.passwordId, t.passwordId);
});

test('a failed try whose password did reach the site may be a real account: kept hidden, signed in with first, deleted once the site says no', async () => {
  const [a] = needAccounts(AGENT, [{ site: 'x.test', purpose: 'Brand account' }], T0);
  const t = await start(a.id);
  passwordTyped(t.passwordId, true, 'https://x.test/signup', T0 + 1);
  await attemptFailed(a.id, 'the page kept for the person was lost', T0 + 10);
  assert.equal(accountRow(a.id)!.password_id, t.passwordId);
  assert.deepEqual(listPasswords('x.test'), [], 'still not in the store');
  const again = await start(a.id);
  assert.deepEqual([again.reuse, again.passwordId], [true, t.passwordId], 'sign in with it first');
  // The site said there's no such account.
  const fresh = await start(a.id, 'northside@bikes.test', true);
  assert.equal(fresh.reuse, false);
  assert.equal(passwordRow(t.passwordId), undefined, 'the dead one is deleted');
  assert.equal(accountRow(a.id)!.typed_ok, null);
});

test('a password the form dropped is never the account\'s: typed_ok goes back to no', async () => {
  const [a] = needAccounts(AGENT, [{ site: 'x.test', purpose: 'Brand account' }], T0);
  const t = await start(a.id);
  passwordTyped(t.passwordId, true, 'https://x.test/signup', T0 + 1);
  passwordTyped(t.passwordId, false, 'https://x.test/signup', T0 + 2);
  assert.equal(accountRow(a.id)!.typed_ok, 0);
  assert.match(judgeAccountPage(accountRow(a.id)!, signedIn())[0], /never went into the site as typed/);
});

test('owed again after every failed try, further apart each time, never given up on', async () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(retryIn), [0, 600_000, 2_400_000, 10_800_000, 43_200_000, 86_400_000, 86_400_000, 86_400_000]);
  const [a] = needAccounts(AGENT, [{ site: 'x.test', purpose: 'Brand account' }], T0);
  assert.equal(accountsDue(T0).get(AGENT)?.length, 1, 'due as soon as it is written down');
  await start(a.id);
  assert.equal(accountsDue(T0).size, 0, 'someone is on it');
  await attemptFailed(a.id, 'blocked', T0);
  assert.equal(accountsDue(T0 + 9 * 60_000).size, 0);
  assert.equal(accountsDue(T0 + 11 * 60_000).get(AGENT)?.length, 1);
  // Woken for it: left alone a while, then woken again - for as long as it's owed.
  nudged(accountsDue(T0 + 11 * 60_000).get(AGENT)!, T0 + 11 * 60_000);
  assert.equal(accountsDue(T0 + 12 * 60_000).size, 0);
  assert.equal(accountsDue(T0 + 11 * 60_000 + NUDGE_MS + 1).get(AGENT)?.length, 1);
  for (let i = 0; i < 30; i++) {
    await start(a.id, 'northside@bikes.test', true);
    await attemptFailed(a.id, 'blocked again', T0);
  }
  const r = accountRow(a.id)!;
  assert.deepEqual([r.state, r.attempts], ['needed', 31]);
  assert.equal(accountsDue(T0 + 86_400_001).get(AGENT)?.length, 1, 'still owed after 31 tries');
});

test("the person's part: kept for them, then back with the agent to finish and check", async () => {
  const [a] = needAccounts(AGENT, [{ site: 'x.test', purpose: 'Brand account' }], T0);
  await start(a.id);
  pageKept(a.id, T0 + 1);
  assert.equal(accountRow(a.id)!.state, 'waiting');
  assert.equal(accountsDue(T0 + 10).size, 0, 'nothing to do while it waits on them');
  personFinished(a.id, T0 + 20, true);
  assert.equal(accountRow(a.id)!.state, 'returned');
  assert.equal(accountsDue(T0 + 21).get(AGENT)?.length, 1, 'the agent is woken to finish it');
  // A working account's sign-in page kept for them stays working.
  markWorking(a.id, T0 + 30);
  pageKept(a.id, T0 + 31);
  assert.equal(accountRow(a.id)!.state, 'working');
});

test('only a person ends one: cancelling deletes its password and it is no longer owed', async () => {
  const [a] = needAccounts(AGENT, [{ site: 'x.test', purpose: 'Brand account' }], T0);
  const t = await start(a.id);
  passwordTyped(t.passwordId, true, 'https://x.test/signup', T0);
  assert.equal(await cancelAccount(a.id, 'A person turned its request down.', T0 + 1), true);
  assert.equal(accountRow(a.id)!.state, 'cancelled');
  assert.equal(passwordRow(t.passwordId), undefined);
  assert.equal(accountsOwed(AGENT).length, 0);
  await assert.rejects(start(a.id), /cancelled by a person/);
  // Asked for anew, it's a new account.
  assert.notEqual(needAccounts(AGENT, [{ site: 'x.test', purpose: 'Brand account' }], T0 + 2)[0].id, a.id);
});

test('seen working is the app reading the page, never the agent saying so', async () => {
  const [a] = needAccounts(AGENT, [{ site: 'x.test', purpose: 'Brand account' }], T0);
  const judge = (page: PageFacts) => judgeAccountPage(accountRow(a.id)!, page);
  assert.match(judge(signedIn())[0], /No sign-up has been started/);
  const t = await start(a.id);
  assert.match(judge(signedIn())[0], /never went into the site as typed/, 'the password was never typed');
  passwordTyped(t.passwordId, true, 'https://x.test/i/flow/signup', T0);
  assert.deepEqual(judge(signedIn()), []);
  // Still the sign-up form (a CAPTCHA stopped it): a password box shows.
  assert.match(judge(signedIn({ url: 'https://x.test/i/flow/signup', passwordFields: 1 })).join('\n'), /still shows a password box[\s\S]*still part of signing up/);
  // A "check your email" step.
  assert.match(judge(signedIn({ url: 'https://x.test/account/verify' })).join('\n'), /verification step/);
  // Another site altogether.
  assert.match(judge(signedIn({ url: 'https://elsewhere.test/home' }))[0], /isn't on x\.test/);
  // On the site, no form - but nothing shows who is signed in (the logged-out home page).
  assert.match(judge(signedIn({ url: 'https://x.test/', text: 'Welcome to X. Join today.', controls: 'Create account /signup\nSign in /login' }))[0], /Nothing on this page shows northside@bikes\.test signed in/);
  // The username alone is enough, or a sign-out link alone.
  assert.deepEqual(judge(signedIn({ controls: '' })), []);
  assert.deepEqual(judge(signedIn({ text: 'Home', controls: 'Sign out' })), []);
  // The start of an email address is no proof: it's too often a plain word on the page.
  assert.equal(judge(signedIn({ text: 'Welcome, northside. Talk to our team.', controls: '' })).length, 1);
});

test('a username shows as a word of its own, not inside another', async () => {
  const [a] = needAccounts(AGENT, [{ site: 'x.test', purpose: 'Handle' }], T0);
  const t = await start(a.id, 'sales');
  passwordTyped(t.passwordId, true, 'https://x.test/signup', T0);
  const judge = (text: string) => judgeAccountPage(accountRow(a.id)!, { url: 'https://x.test/home', passwordFields: 0, text, controls: '' });
  assert.deepEqual(judge('Profile\n@sales'), []);
  assert.equal(judge('Talk to our salesforce team').length, 1);
});

test('a sign-up on another host of the same site, or the host its password was typed on, counts as that site', async () => {
  assert.deepEqual(['accounts.shop.example.co.uk', 'www.x.test', 'x.test', 'a.b.c.example.com'].map(baseDomain), ['example.co.uk', 'x.test', 'x.test', 'example.com']);
  const [a] = needAccounts(AGENT, [{ site: 'youtube.test', purpose: 'Channel' }], T0);
  const t = await start(a.id, 'channel@bikes.test');
  passwordTyped(t.passwordId, true, 'https://accounts.google.test/signup', T0);
  const ok = (url: string) => judgeAccountPage(accountRow(a.id)!, { url, passwordFields: 0, text: 'channel@bikes.test', controls: '' });
  assert.deepEqual(ok('https://studio.youtube.test/channel'), []);
  assert.deepEqual(ok('https://myaccount.google.test/'), []);
  assert.equal(ok('https://other.test/').length, 1);
});

test("a new agent's accounts are the Agency Engineer's to make while it's in setup; its setup item closes when the app has seen them work", async () => {
  exec("INSERT INTO agent_state (agent_id, state, setup, updated_at) VALUES ('zz-new', 'stopped', 1, ?)", T0);
  exec("INSERT INTO requests (agent_id, what, why, created_at, stage, setup) VALUES ('zz-new', 'Make 2 x.test accounts', 'w', ?, 'engineer', 1)", T0);
  const request = one<{ id: number }>('SELECT MAX(id) AS id FROM requests')!.id;
  const [a, b] = needAccounts('zz-new', [{ site: 'x.test', purpose: 'Brand (1 of 2)' }, { site: 'x.test', purpose: 'Brand (2 of 2)' }], T0, request);
  assert.equal(workerOf('zz-new'), FLEET_ENGINEER);
  assert.equal(accountsOwed(FLEET_ENGINEER).length, 2);
  assert.equal(accountsOwed('zz-new').length, 0);
  assert.match(accountsForPrompt(FLEET_ENGINEER), /## Accounts you owe[\s\S]*x\.test for zz-new: Brand \(1 of 2\) - to make/);
  assert.equal(accountsForPrompt('zz-new'), '');
  await startAttempt(a.id, { username: 'one@bikes.test', browser: 1, runId: 'r_e', now: T0 });
  markWorking(a.id, T0 + 1);
  assert.equal(one<{ status: string }>('SELECT status FROM requests WHERE id = ?', request)!.status, 'open', 'one of two: not done');
  await startAttempt(b.id, { username: 'two@bikes.test', browser: 1, runId: 'r_e', now: T0 });
  markWorking(b.id, T0 + 2);
  const r = one<{ status: string; answer: string }>('SELECT status, answer FROM requests WHERE id = ?', request)!;
  assert.equal(r.status, 'done');
  assert.match(r.answer, /one@bikes\.test at x\.test, two@bikes\.test at x\.test/);
  // Started by its person: what's left is its own.
  exec("UPDATE agent_state SET state = 'active', setup = NULL WHERE agent_id = 'zz-new'");
  assert.equal(workerOf('zz-new'), 'zz-new');
});

test("the run's instructions carry the app's record: what's owed, how often it failed, and that unchecked means it doesn't exist", async () => {
  const [a] = needAccounts(AGENT, [{ site: 'x.test', purpose: 'Brand account' }], T0);
  const t = await start(a.id);
  passwordTyped(t.passwordId, true, 'https://x.test/signup', T0);
  await attemptFailed(a.id, 'the page kept for the person on x.test closed before its check was done (the browser closed)', T0);
  const said = accountsForPrompt(AGENT);
  assert.match(said, /An account not marked working does not exist/);
  assert.match(said, new RegExp(`${a.id} x\\.test: Brand account \\(northside@bikes\\.test\\) - to make - 1 try failed, last: the page kept for the person`));
  assert.match(said, /An earlier try may have made it as northside@bikes\.test/);
  assert.match(said, /wait_for_person once/);
});
