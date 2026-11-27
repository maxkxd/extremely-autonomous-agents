import './test-data-dir.js';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { DATA_DIR } from './paths.js';
import { deleteSecret, getSecret, keepSecret, setSecret } from './vault.js';

const VAULT = join(DATA_DIR, 'vault.json');

test('a save that fails writes over nothing, and the next one goes ahead', async () => {
  // No vault yet: empty, not an error.
  assert.equal(await getSecret('first'), null);
  await setSecret('first', 'one');
  const good = await readFile(VAULT, 'utf8');

  // The vault can't be read: reads and saves fail, and the file stays as it was.
  const damaged = good.slice(0, 20);
  await writeFile(VAULT, damaged);
  await assert.rejects(setSecret('second', 'two'), /can't be read/);
  await assert.rejects(deleteSecret('first'), /can't be read/);
  await assert.rejects(getSecret('first'), /can't be read/);
  assert.equal(await readFile(VAULT, 'utf8'), damaged);

  // Readable again: the next save works, with no restart, and keeps what was there.
  await writeFile(VAULT, good);
  await setSecret('second', 'two');
  assert.equal(await getSecret('first'), 'one');
  assert.equal(await getSecret('second'), 'two');

  // Saves made at the same moment all land.
  await Promise.all([setSecret('third', 'three'), setSecret('fourth', 'four'), deleteSecret('second')]);
  assert.equal(await getSecret('third'), 'three');
  assert.equal(await getSecret('fourth'), 'four');
  assert.equal(await getSecret('second'), null);
  assert.deepEqual((await readdir(DATA_DIR)).filter(f => f.endsWith('.tmp')), []);
});

test("a renewed sign-in that can't be saved is used from memory, and saved once it can be", async () => {
  await setSecret('signin', 'old');
  const good = await readFile(VAULT, 'utf8');
  const damaged = good.slice(0, 20);
  await writeFile(VAULT, damaged);

  // Neither throws, and both are what's read back.
  await keepSecret('signin', 'renewed');
  await setSecret('integration-token:example', 'swapped');
  assert.equal(await getSecret('signin'), 'renewed');
  assert.equal(await getSecret('integration-token:example'), 'swapped');
  // Any other save still fails, and the file is left alone.
  await assert.rejects(setSecret('other', 'x'), /can't be read/);
  assert.equal(await readFile(VAULT, 'utf8'), damaged);

  // It can be saved again: the next save writes them too.
  await writeFile(VAULT, good);
  await setSecret('other', 'x');
  const saved = JSON.parse(await readFile(VAULT, 'utf8')) as Record<string, unknown>;
  assert.notDeepEqual(saved.signin, (JSON.parse(good) as Record<string, unknown>).signin);
  assert.ok(saved['integration-token:example']);
  assert.equal(await getSecret('signin'), 'renewed');

  // Signing out of one still held takes it away for good.
  await writeFile(VAULT, damaged);
  await keepSecret('signin', 'again');
  await writeFile(VAULT, good);
  await deleteSecret('signin');
  assert.equal(await getSecret('signin'), null);
});

test("a held value isn't written back after a sign-out or a replacement that couldn't be saved", async () => {
  await setSecret('kept', 'one');
  const good = await readFile(VAULT, 'utf8');
  const damaged = good.slice(0, 20);

  // The sign-out fails; once the file can be read, another save mustn't bring it back.
  await writeFile(VAULT, damaged);
  await keepSecret('signed-out', 'renewed');
  await assert.rejects(deleteSecret('signed-out'), /can't be read/);
  await writeFile(VAULT, good);
  await setSecret('other', 'y');
  assert.equal(await getSecret('signed-out'), null);

  // The same for a replacement that fails.
  await writeFile(VAULT, damaged);
  await keepSecret('replaced', 'renewed');
  await assert.rejects(setSecret('replaced', 'newer'), /can't be read/);
  await writeFile(VAULT, good);
  await setSecret('other', 'z');
  assert.equal(await getSecret('replaced'), null);
  assert.equal(await getSecret('kept'), 'one');
});
