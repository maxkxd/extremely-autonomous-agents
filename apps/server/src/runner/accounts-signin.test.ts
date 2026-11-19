import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, test } from 'node:test';
import { accountRow, accountsDue, accountsForPrompt, accountsOwed, attemptFailed, cancelAccount, judgeAccountPage, markWorking, needAccounts, passwordTyped, startAttempt, type PageFacts } from './accounts.js';
import { one, resetDbForTests, run as exec } from './db.js';
import { listPasswords, passwordRow, readPassword } from './passwords.js';
import type { SignIn } from './signin.js';

// Accounts with no password (signin.ts, accounts.ts): an emailed code, "Sign in with
// Google/GitHub/Microsoft/Meta...", or a company's own Entra ID / Okta sign-in. Owed,
// started, checked by the page and kept in the store like any other - only never held
// to a password that doesn't exist.

const AGENT = 'zz-growth';
const T0 = 1_800_000_000_000;
const facts = (over: Partial<PageFacts> = {}): PageFacts => ({ url: 'https://glama.ai/settings', passwordFields: 0, text: 'Settings\nme@bikes.test', controls: 'Sign out', ...over });
const begin = (id: string, signIn?: SignIn, runId = 'r_1', now = T0) => startAttempt(id, { username: 'me@bikes.test', browser: 1, runId, signIn, now });

beforeEach(() => resetDbForTests());

const METHODS: [string, SignIn][] = [
  ['an emailed code', { method: 'email_code', provider: null }],
  ['Sign in with Google', { method: 'sso', provider: 'google' }],
  ['Sign in with GitHub', { method: 'sso', provider: 'github' }],
  ['Sign in with Microsoft', { method: 'sso', provider: 'microsoft' }],
  ['Sign in with Apple', { method: 'sso', provider: 'apple' }],
  ['Sign in with Meta', { method: 'sso', provider: 'meta' }],
  ["a company's Entra ID", { method: 'company_sso', provider: 'entra' }],
  ["a company's Okta", { method: 'company_sso', provider: 'okta' }],
];

for (const [label, signIn] of METHODS)
  test(`signs in with ${label}: no password made or asked for, seen working by the page alone, in the store as how it signs in`, async () => {
    const [a] = needAccounts(AGENT, [{ site: 'glama.ai', purpose: 'Directory listing' }], T0);
    const t = await begin(a.id, signIn);
    const row = accountRow(a.id)!;
    assert.deepEqual([row.state, row.method, row.provider, row.typed_ok], ['started', signIn.method, signIn.provider, null]);
    const pw = passwordRow(t.passwordId)!;
    assert.deepEqual([pw.method, pw.provider, pw.account_id, pw.confirmed_at], [signIn.method, signIn.provider, a.id, null], 'a hidden store entry, with how it signs in');
    await assert.rejects(readPassword(t.passwordId), /has no password: it signs in with/, 'nothing to type');
    assert.deepEqual(listPasswords('glama.ai'), [], 'hidden until it works');
    // No "the password never went in" - there is none. Only the page.
    assert.deepEqual(judgeAccountPage(row, facts()), []);
    // As strict as ever about the page itself.
    assert.match(judgeAccountPage(row, facts({ url: 'https://glama.ai/sign-in', text: 'Enter your email', controls: 'Continue' })).join('\n'), /still part of signing up/);
    assert.match(judgeAccountPage(row, facts({ text: 'Welcome to Glama', controls: 'Sign up /sign-up' })).join('\n'), /Nothing on this page shows me@bikes\.test signed in/);
    assert.match(judgeAccountPage(row, facts({ url: 'https://elsewhere.test/home' }))[0], /isn't on glama\.ai/);
    const done = markWorking(a.id, T0 + 5);
    assert.equal(done.state, 'working');
    assert.deepEqual(
      listPasswords('glama.ai').map(p => [p.username, p.method, p.provider, !!p.confirmed_at]),
      [['me@bikes.test', signIn.method, signIn.provider, true]],
    );
    assert.equal(accountsOwed(AGENT).length, 0, 'no longer owed');
  });

test("still on Google's, Microsoft's or the company's sign-in page: not working, and it says whose page it is", async () => {
  const [a] = needAccounts(AGENT, [{ site: 'glama.ai', purpose: 'Listing' }], T0);
  await begin(a.id, { method: 'sso', provider: 'google' });
  const row = accountRow(a.id)!;
  assert.match(judgeAccountPage(row, facts({ url: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1', passwordFields: 1 }))[0], /This page is Google's sign-in \(accounts\.google\.com\), not glama\.ai/);
  assert.match(judgeAccountPage(row, facts({ url: 'https://acme.okta.com/app/sso/saml' }))[0], /This page is Okta's sign-in/);
  assert.match(judgeAccountPage(row, facts({ url: 'https://login.microsoftonline.com/common/oauth2' }))[0], /Microsoft's sign-in[\s\S]*show_person/);
});

test('written down already knowing how it signs in, the sign-up uses that; written down again another way, it changes', async () => {
  const [a] = needAccounts(AGENT, [{ site: 'toolradar.com', purpose: 'Listing', signIn: { method: 'email_code', provider: null } }], T0);
  assert.equal(accountRow(a.id)!.method, 'email_code');
  assert.match(accountsForPrompt(AGENT), /toolradar\.com: Listing \(signs in with a code or link emailed to it\) - to make/);
  const t = await begin(a.id);
  assert.equal(passwordRow(t.passwordId)!.method, 'email_code', 'no sign_in given: as written down');
  needAccounts(AGENT, [{ site: 'toolradar.com', purpose: 'listing', signIn: { method: 'sso', provider: 'google' } }], T0 + 1);
  assert.deepEqual([accountRow(a.id)!.method, accountRow(a.id)!.provider], ['sso', 'google']);
  assert.match(accountsForPrompt(AGENT), /\(me@bikes\.test, signs in with a Google account\)/);
});

test("switching a password try to no password throws the earlier password away (and says so); switching back makes a fresh one", async () => {
  const [a] = needAccounts(AGENT, [{ site: 'aicxstack.com', purpose: 'Listing' }], T0);
  const first = await begin(a.id);
  assert.equal(accountRow(a.id)!.method, null, 'a password account by default');
  passwordTyped(first.passwordId, true, 'https://aicxstack.com/signup', T0 + 1);
  await attemptFailed(a.id, 'no password box after all', T0 + 2);
  assert.equal(accountRow(a.id)!.password_id, first.passwordId, 'kept: it reached the site');
  const next = await begin(a.id, { method: 'email_code', provider: null }, 'r_2', T0 + 3);
  assert.deepEqual([next.reuse, next.dropped], [false, true]);
  assert.equal(passwordRow(first.passwordId), undefined, 'the old password is gone');
  assert.equal(accountRow(a.id)!.typed_ok, null);
  const back = await begin(a.id, { method: 'password', provider: null }, 'r_3', T0 + 4);
  assert.deepEqual([back.reuse, back.dropped], [false, false]);
  assert.equal((await readPassword(back.passwordId)).length, 20);
  assert.equal(accountRow(a.id)!.method, null);
  assert.match(judgeAccountPage(accountRow(a.id)!, facts({ url: 'https://aicxstack.com/me' }))[0], /never went into the site as typed/, 'a password account is still held to its password');
});

test('the same way again keeps nothing to reuse: a new hidden entry each try, the old one gone', async () => {
  const [a] = needAccounts(AGENT, [{ site: 'glama.ai', purpose: 'Listing' }], T0);
  const one1 = await begin(a.id, { method: 'sso', provider: 'github' });
  const two = await begin(a.id, undefined, 'r_2', T0 + 1);
  assert.equal(two.reuse, false);
  assert.equal(passwordRow(one1.passwordId), undefined);
  assert.equal(passwordRow(two.passwordId)!.provider, 'github', 'still GitHub: as it was');
});

test('a failed try with no password leaves nothing behind but how it signs in, and is owed again; a person can still cancel it', async () => {
  const [a] = needAccounts(AGENT, [{ site: 'bestofai.test', purpose: 'Listing' }], T0);
  const t = await begin(a.id, { method: 'sso', provider: 'google' });
  const failed = (await attemptFailed(a.id, 'the run ended before the sign-up was finished and checked', T0 + 1))!;
  assert.deepEqual([failed.state, failed.password_id, failed.method, failed.provider], ['needed', null, 'sso', 'google']);
  assert.equal(passwordRow(t.passwordId), undefined);
  assert.equal(accountsDue(T0 + 11 * 60_000).get(AGENT)?.length, 1, 'woken for it again after the usual wait');
  await begin(a.id, undefined, 'r_2', T0 + 2);
  assert.equal(await cancelAccount(a.id, 'A person said no.', T0 + 3), true);
  assert.deepEqual(listPasswords('bestofai.test'), []);
});

test("a new agent's setup item names how its passwordless account signs in", async () => {
  exec("INSERT INTO agent_state (agent_id, state, setup, updated_at) VALUES ('zz-new2', 'stopped', 1, ?)", T0);
  exec("INSERT INTO requests (agent_id, what, why, created_at, stage, setup) VALUES ('zz-new2', 'Make a glama.ai account', 'w', ?, 'engineer', 1)", T0);
  const request = one<{ id: number }>('SELECT MAX(id) AS id FROM requests')!.id;
  const [a] = needAccounts('zz-new2', [{ site: 'glama.ai', purpose: 'Listing' }], T0, request);
  await begin(a.id, { method: 'sso', provider: 'github' }, 'r_e');
  markWorking(a.id, T0 + 1);
  const r = one<{ status: string; answer: string }>('SELECT status, answer FROM requests WHERE id = ?', request)!;
  assert.equal(r.status, 'done');
  assert.match(r.answer, /me@bikes\.test at glama\.ai \(signs in with a GitHub account\)[\s\S]*in the password store/);
});

test('a store from before sign-in methods gets the columns on opening, and its accounts and passwords read as password ones', async () => {
  const cols = (t: string) => (one<{ c: string }>(`SELECT group_concat(name) AS c FROM pragma_table_info('${t}')`)?.c ?? '').split(',');
  for (const t of ['accounts', 'passwords']) assert.ok(cols(t).includes('method') && cols(t).includes('provider'), `fresh store: ${t}`);
  // An old store: the two tables as they were, with an account and its password in them.
  const dir = mkdtempSync(join(tmpdir(), 'eaa-signin-'));
  const file = join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE passwords (id TEXT PRIMARY KEY, site TEXT NOT NULL, username TEXT NOT NULL, profile INTEGER NOT NULL, agent_id TEXT, note TEXT, created_at INTEGER NOT NULL, confirmed_at INTEGER, account_id TEXT);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, site TEXT NOT NULL, purpose TEXT NOT NULL, state TEXT NOT NULL, username TEXT, browser INTEGER, password_id TEXT, typed_ok INTEGER, typed_host TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, run_id TEXT, request_id INTEGER, setup_request INTEGER, next_try_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, working_at INTEGER);
    INSERT INTO passwords VALUES ('pw1', 'x.test', 'me@bikes.test', 1, 'zz-growth', NULL, 1, NULL, 'a_old');
    INSERT INTO accounts (id, agent_id, site, purpose, state, username, browser, password_id, typed_ok, created_at, updated_at) VALUES ('a_old', 'zz-growth', 'x.test', 'Brand', 'started', 'me@bikes.test', 1, 'pw1', 1, 1, 1);`);
  old.close();
  try {
    resetDbForTests(file);
    for (const t of ['accounts', 'passwords']) assert.ok(cols(t).includes('method') && cols(t).includes('provider'), `old store: ${t}`);
    const a = accountRow('a_old')!;
    assert.deepEqual([a.method, a.provider, passwordRow('pw1')!.method], [null, null, null]);
    assert.match(judgeAccountPage(a, facts({ url: 'https://x.test/me' })).join('\n'), /^$/, 'judged as the password account it was');
    // Opened again (a restart): no harm done.
    resetDbForTests(file);
    assert.equal(accountRow('a_old')!.state, 'started');
  } finally {
    resetDbForTests();
    rmSync(dir, { recursive: true, force: true });
  }
});
