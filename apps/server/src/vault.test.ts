import './test-data-dir.js';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DATA_DIR } from './paths.js';
import { deleteSecret, getSecret, setSecret } from './vault.js';

const VAULT = join(DATA_DIR, 'vault.json');
const TMP = `${VAULT}.tmp`;
const KEY = join(DATA_DIR, 'vault.key');
const keys = () => Object.keys(JSON.parse(readFileSync(VAULT, 'utf8'))).sort();
const sealedLike = { iv: 'AAAAAAAAAAAAAAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA==', data: 'AA==' };

test("a vault with keys but no key file stops; no new key is made over the old one", async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(VAULT, JSON.stringify({ sealed: sealedLike }));
  await assert.rejects(getSecret('sealed'), /key .* is missing/);
  assert.equal(existsSync(KEY), false);
  rmSync(VAULT);
});

test('saved keys come back; a new vault gets its key', async () => {
  await setSecret('anthropic', { key: 'sk-test-1' });
  await setSecret('github', { token: 'fake-token' });
  assert.deepEqual(await getSecret('anthropic'), { key: 'sk-test-1' });
  assert.ok(existsSync(KEY));
  assert.equal(existsSync(TMP), false);
  await deleteSecret('github');
  assert.deepEqual(keys(), ['anthropic']);
});

test("a vault that can't be read is never taken for an empty one, and never written over", async () => {
  const good = readFileSync(VAULT, 'utf8');
  writeFileSync(VAULT, good.slice(0, 20)); // half written
  await assert.rejects(getSecret('anthropic'));
  await assert.rejects(setSecret('new', { key: 'x' }));
  assert.equal(readFileSync(VAULT, 'utf8'), good.slice(0, 20));
  writeFileSync(VAULT, good);
});

test("a save whose copy couldn't take the vault's place: the copy is the vault, and the next save keeps everything in it", async () => {
  await setSecret('one', { v: 1 });
  const before = readFileSync(VAULT, 'utf8');
  await setSecret('two', { v: 2 });
  const latest = readFileSync(VAULT, 'utf8');
  // As if the last swap was refused: the older vault in place, the latest beside it.
  writeFileSync(VAULT, before);
  writeFileSync(TMP, latest);
  const past = new Date(Date.now() - 60_000);
  utimesSync(VAULT, past, past);
  assert.deepEqual(await getSecret('two'), { v: 2 });
  await setSecret('three', { v: 3 });
  assert.deepEqual(keys(), ['anthropic', 'one', 'three', 'two']);
  assert.equal(existsSync(TMP), false);
});

test('a copy older than the vault is left over from before and ignored', async () => {
  writeFileSync(TMP, JSON.stringify({ stale: sealedLike }));
  const past = new Date(Date.now() - 60_000);
  utimesSync(TMP, past, past);
  assert.equal(await getSecret('stale'), null);
  assert.deepEqual(await getSecret('one'), { v: 1 });
  rmSync(TMP);
});

test('a vault half written over in place: the whole copy beside it is used', async () => {
  const whole = readFileSync(VAULT, 'utf8');
  writeFileSync(TMP, whole);
  const past = new Date(Date.now() - 60_000);
  utimesSync(TMP, past, past); // older than the broken vault, still the one to use
  writeFileSync(VAULT, whole.slice(0, 30));
  assert.deepEqual(await getSecret('three'), { v: 3 });
  await setSecret('four', { v: 4 });
  assert.deepEqual(keys(), ['anthropic', 'four', 'one', 'three', 'two']);
});

test("one failed save doesn't fail the saves after it", async () => {
  mkdirSync(TMP); // the copy can't be written
  await assert.rejects(setSecret('five', { v: 5 }));
  rmSync(TMP, { recursive: true });
  await setSecret('six', { v: 6 });
  assert.deepEqual(await getSecret('six'), { v: 6 });
  assert.equal(await getSecret('five'), null);
});
