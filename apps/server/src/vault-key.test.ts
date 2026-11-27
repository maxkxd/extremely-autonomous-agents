import './test-data-dir.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { DATA_DIR } from './paths.js';
import { getSecret, setSecret } from './vault.js';

const KEY_FILE = join(DATA_DIR, 'vault.key');

test("a key file that can't be read or used is left alone, and the failure isn't kept", async () => {
  // The key file is what's tested, whatever the shell running this has set.
  delete process.env.EAA_VAULT_KEY;

  // There, but it can't be read (a folder in its place fails on every OS).
  await mkdir(KEY_FILE);
  await assert.rejects(setSecret('first', 'one'), { code: 'EISDIR' });
  await rmdir(KEY_FILE);

  // There, but damaged: left as it was.
  const damaged = randomBytes(8).toString('base64');
  await writeFile(KEY_FILE, damaged);
  await assert.rejects(setSecret('first', 'one'), /can't be used/);
  assert.equal(await readFile(KEY_FILE, 'utf8'), damaged);

  // Good again: the next call works, with no restart, and uses that key.
  const good = randomBytes(32).toString('base64');
  await writeFile(KEY_FILE, good);
  await setSecret('first', 'one');
  assert.equal(await getSecret('first'), 'one');
  assert.equal(await readFile(KEY_FILE, 'utf8'), good);
});
