import './test-data-dir.js';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { DATA_DIR } from './paths.js';
import { deleteSecret, getSecret, setSecret } from './vault.js';

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
