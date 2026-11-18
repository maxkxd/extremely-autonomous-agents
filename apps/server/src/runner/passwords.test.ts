import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { one, openDb, run as exec } from './db.js';
import { _testing } from './agent-profiles.js';
import { linkReady, managedProfile } from './browser-link.js';
import { ACCOUNTS_PER_SITE, confirmPassword, deletePassword, listPasswords, makePassword, profileFor, readPassword, savePassword, siteOf } from './passwords.js';
import { needAccounts } from './accounts.js';
import { __setBrowserConnForTest, SIGNED_IN_TOOLS } from './browser.js';
import { BASELINE, BROWSER_KIT } from '../catalog.js';

openDb();

test('a site is its host, without www', () => {
  assert.equal(siteOf('https://www.LinkedIn.com/login'), 'linkedin.com');
  assert.equal(siteOf('accounts.google.com'), 'accounts.google.com');
  assert.equal(siteOf('google.com'), 'google.com');
  assert.throws(() => siteOf(' '));
});

test('a made password is strong and has every kind of character', () => {
  const pw = makePassword();
  assert.equal(pw.length, 20);
  for (const set of [/[a-z]/, /[A-Z]/, /[0-9]/, /[!@#$%*?]/]) assert.match(pw, set);
  assert.notEqual(makePassword(), pw);
});

test('a browser holds 10 accounts on one site; the 11th goes in another browser, other sites still fit', async () => {
  exec('DELETE FROM passwords');
  for (let i = 0; i < ACCOUNTS_PER_SITE; i++) {
    const { profile } = profileFor('google.com', [1]);
    assert.equal(profile, 1);
    await savePassword({ site: 'google.com', username: `a${i}@x.test`, password: 'p', profile, agentId: 'zz-a' });
  }
  assert.deepEqual(profileFor('google.com', [1]), { profile: 2, isNew: true });
  assert.deepEqual(profileFor('google.com', [1, 2]), { profile: 2, isNew: false });
  assert.deepEqual(profileFor('linkedin.com', [1, 2]), { profile: 1, isNew: false });
  exec('DELETE FROM passwords');
});

test('the password is in the vault, never in the list; deleting removes both', async () => {
  exec('DELETE FROM passwords');
  const id = await savePassword({ site: 'https://www.youtube.com', username: 'chan@x.test', password: 'S3cret!pass', profile: 1, agentId: 'zz-a', note: 'Brand channel' });
  const rows = listPasswords('youtube.com');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].site, 'youtube.com');
  assert.ok(!JSON.stringify(rows).includes('S3cret'));
  assert.equal(await readPassword(id), 'S3cret!pass');
  assert.equal(await deletePassword(id), true);
  await assert.rejects(readPassword(id), /No password/);
});

test("the agents' tools never hand a password back, and every agent holds the kit", async () => {
  exec('DELETE FROM passwords');
  await savePassword({ site: 'linkedin.com', username: 'me@x.test', password: 'Hidden#Pass1', profile: 1, agentId: 'zz-a' });
  const list = SIGNED_IN_TOOLS.find(t => t.id === 'signed_in_browser.passwords')!;
  const out = await list.impl({}, {} as never);
  assert.match(out, /linkedin\.com - me@x\.test \(browser 1\)/);
  assert.ok(!out.includes('Hidden#Pass1'));
  // Signing up: the password is made for an account the agent owes, and never shown.
  const [owed] = needAccounts('zz-a', [{ site: 'linkedin.com', purpose: 'Second profile' }], Date.now());
  const made = SIGNED_IN_TOOLS.find(t => t.id === 'signed_in_browser.start_sign_up')!;
  const said = await made.impl({ account_id: owed.id, username: 'second@x.test' }, { agent: { id: 'zz-a' }, runId: 'r_pw', now: () => Date.now() } as never);
  assert.match(said, /browser 1/);
  assert.ok(!/[A-Za-z0-9!@#$%*?]{20}/.test(said.replace(/#\w+|password_id "\w+"|"a_\w+"/g, '')), 'the password itself is not in what the agent sees');
  assert.doesNotMatch(String(await list.impl({}, {} as never)), /second@x\.test/, "a sign-up under way isn't in the store");
  assert.equal(SIGNED_IN_TOOLS.some(t => /make_password|confirm_password/.test(t.id)), false, 'no way left to save or confirm an account on the agent\'s word');
  // Every agent's baseline includes it; paying, posting and starting a new tool wait for a person.
  for (const { id, tier } of BROWSER_KIT) assert.ok(BASELINE.some(b => `${b.server}.${b.tool.name}` === id && b.tool.tier === tier), id);
  const tier = (id: string) => BROWSER_KIT.find(t => t.id === id)?.tier;
  assert.equal(tier('signed_in_browser.click'), 'T1');
  assert.equal(tier('signed_in_browser.click_to_pay'), 'T2');
  assert.equal(tier('signed_in_browser.click_to_post'), 'T2');
  assert.equal(tier('signed_in_browser.click_to_start_tool'), 'T2');
  exec('DELETE FROM passwords');
});

test("an account saved before sign-ups were checked stays marked not confirmed; a person's is confirmed", async () => {
  exec('DELETE FROM passwords');
  const mine = await savePassword({ site: 'proton.me', username: 'desk@proton.me', password: 'p', profile: 1, agentId: 'zz-a' });
  const theirs = await savePassword({ site: 'proton.me', username: 'me@proton.me', password: 'p', profile: 1, agentId: null, confirmed: true });
  const byId = () => new Map(listPasswords('proton.me').map(r => [r.id, r.confirmed_at]));
  assert.equal(byId().get(mine), null, 'the sign-up may never finish');
  assert.ok(byId().get(theirs));
  const list = SIGNED_IN_TOOLS.find(t => t.id === 'signed_in_browser.passwords')!;
  assert.match(String(await list.impl({ site: 'proton.me' }, {} as never)), /desk@proton\.me \(browser 1\) - NOT CONFIRMED[\s\S]*check_account with its password_id/);
  confirmPassword(mine);
  assert.ok(byId().get(mine));
  assert.doesNotMatch(String(await list.impl({ site: 'proton.me' }, {} as never)), /NOT CONFIRMED/);
});

test("an agent chooses where to sign up: a named browser (a person's own too), or a new agents' profile", async () => {
  exec('DELETE FROM passwords');
  await linkReady();
  // Browser 5 is Sam Rivera's own Edge, paired by the extension: not an agents' profile.
  await __setBrowserConnForTest(5, null, 'Edge - Sam');
  const made = SIGNED_IN_TOOLS.find(t => t.id === 'signed_in_browser.start_sign_up')!;
  const c = { agent: { id: 'zz-c' }, runId: 'r_choose', now: () => Date.now() } as never;
  const [owed] = needAccounts('zz-c', [{ site: 'x.test', purpose: 'Brand account' }], Date.now());
  // Left to the app: the first with room, and the agent is told it's a person's own browser.
  const picked = await made.impl({ account_id: owed.id, username: 'northside@bikes.test' }, c);
  assert.match(picked, /Sign up in browser 5 \(Edge - Sam\)/);
  assert.match(picked, /a person's own browser[\s\S]*new_profile true/);
  // Named on purpose: the same browser, and still told.
  assert.match(await made.impl({ account_id: owed.id, username: 'northside@bikes.test', browser: '5' }, c), /browser 5[\s\S]*a person's own browser/);
  await assert.rejects(async () => made.impl({ account_id: owed.id, username: 'northside@bikes.test', browser: '9' }, c), /There's no browser 9/);
  await assert.rejects(async () => made.impl({ account_id: owed.id, username: 'northside@bikes.test', browser: '5', new_profile: true }, c), /not both/);
  // No browser to make profiles with: says why.
  _testing.setBrowser(null);
  await assert.rejects(async () => made.impl({ account_id: owed.id, username: 'northside@bikes.test', new_profile: true }, c), /can't make a new agents' profile here/);
  // A new agents' profile: made, the sign-up moved there, and no note about anyone's accounts.
  _testing.setBrowser({ exe: 'msedge.exe', kind: 'edge' });
  const fresh = await made.impl({ account_id: owed.id, username: 'northside@bikes.test', new_profile: true }, c);
  const n = Number(/Sign up in browser (\d+)/.exec(fresh)?.[1]);
  assert.notEqual(n, 5);
  assert.ok(managedProfile(n), "it's an agents' profile");
  assert.doesNotMatch(fresh, /a person's own browser/);
  assert.equal(one<{ browser: number }>('SELECT browser FROM accounts WHERE id = ?', owed.id)?.browser, n);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM passwords WHERE account_id = ?", owed.id)?.n, 1, 'the first try\'s password (never typed) is gone');
  // A browser already holding its fill of the site can't be named.
  for (let i = 0; i < ACCOUNTS_PER_SITE; i++) await savePassword({ site: 'x.test', username: `full${i}@bikes.test`, password: 'p', profile: 5, agentId: 'zz-c' });
  await assert.rejects(async () => made.impl({ account_id: owed.id, username: 'northside@bikes.test', browser: '5' }, c), /already holds 10 x\.test accounts/);
  _testing.setBrowser(null);
  await __setBrowserConnForTest(5, null);
  exec('DELETE FROM passwords');
});
