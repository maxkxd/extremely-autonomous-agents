import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, run as exec } from './db.js';
import { ACCOUNTS_PER_SITE, deletePassword, listPasswords, makePassword, profileFor, readPassword, savePassword, siteOf } from './passwords.js';
import { SIGNED_IN_TOOLS } from './browser.js';
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

test('a profile holds 10 accounts on one site; the 11th goes in a new profile, other sites still fit', async () => {
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
  assert.match(out, /linkedin\.com - me@x\.test \(profile 1\)/);
  assert.ok(!out.includes('Hidden#Pass1'));
  const made = SIGNED_IN_TOOLS.find(t => t.id === 'signed_in_browser.make_password')!;
  const said = await made.impl({ site: 'linkedin.com', username: 'second@x.test' }, { agent: { id: 'zz-a' } } as never);
  assert.match(said, /profile 1/);
  assert.ok(!/[A-Za-z0-9!@#$%*?]{20}/.test(said.replace(/#\w+|password_id "\w+"/g, '')), 'the password itself is not in what the agent sees');
  // Every agent's baseline includes it; paying, posting and starting a new tool wait for a person.
  for (const { id, tier } of BROWSER_KIT) assert.ok(BASELINE.some(b => `${b.server}.${b.tool.name}` === id && b.tool.tier === tier), id);
  const tier = (id: string) => BROWSER_KIT.find(t => t.id === id)?.tier;
  assert.equal(tier('signed_in_browser.click'), 'T1');
  assert.equal(tier('signed_in_browser.click_to_pay'), 'T2');
  assert.equal(tier('signed_in_browser.click_to_post'), 'T2');
  assert.equal(tier('signed_in_browser.click_to_start_tool'), 'T2');
  exec('DELETE FROM passwords');
});
