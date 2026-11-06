import './test-data-dir.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openSealed, packBundle, sealFor, unpackBundle } from './move.js';
import { DATA_DIR } from './paths.js';

test('a bundle opens with the key it was made for, into the same files', async () => {
  const key = randomBytes(32);
  const from = await mkdtemp(join(tmpdir(), 'eaa-move-from-'));
  await mkdir(join(from, 'agency', 'agents', 'scout'), { recursive: true });
  await writeFile(join(from, 'agency', 'agents', 'scout', 'CHARTER.md'), '# Scout\nFinds bike shops for Northside Bikes.');
  await writeFile(join(from, 'agency', 'agency.db'), randomBytes(5000));
  const out = join(await mkdtemp(join(tmpdir(), 'eaa-move-out-')), 'org.eaa');
  await packBundle(from, key, out);
  const bundle = await readFile(out);
  assert.equal(bundle.subarray(0, 8).toString(), 'EAAMOVE1');
  assert.ok(!bundle.includes(Buffer.from('Northside Bikes')), 'nothing readable in it');

  const to = await mkdtemp(join(tmpdir(), 'eaa-move-to-'));
  await unpackBundle(out, key, to);
  assert.equal(await readFile(join(to, 'agency', 'agents', 'scout', 'CHARTER.md'), 'utf8'), '# Scout\nFinds bike shops for Northside Bikes.');
  assert.deepEqual(await readFile(join(to, 'agency', 'agency.db')), await readFile(join(from, 'agency', 'agency.db')));
});

test('a bundle is refused with another key, or changed on the way', async () => {
  const key = randomBytes(32);
  const from = await mkdtemp(join(tmpdir(), 'eaa-move-from-'));
  await writeFile(join(from, 'a.txt'), 'hello');
  const out = join(await mkdtemp(join(tmpdir(), 'eaa-move-out-')), 'org.eaa');
  await packBundle(from, key, out);
  await assert.rejects(unpackBundle(out, randomBytes(32), await mkdtemp(join(tmpdir(), 'eaa-move-to-'))), /doesn't open with this vault key/);
  const b = await readFile(out);
  b[20] ^= 1;
  await writeFile(out, b);
  await assert.rejects(unpackBundle(out, key, await mkdtemp(join(tmpdir(), 'eaa-move-to-'))), /doesn't open with this vault key/);
  await writeFile(out, 'not a bundle at all, just some text');
  await assert.rejects(unpackBundle(out, key, await mkdtemp(join(tmpdir(), 'eaa-move-to-'))), /isn't an agency bundle/);
});

test('secrets sealed for the new machine are read by its vault', async () => {
  const key = randomBytes(32);
  process.env.EAA_VAULT_KEY = key.toString('base64');
  const was = { key: 'sk-test-not-a-real-key-000000' };
  assert.deepEqual(openSealed(key, sealFor(key, was)), was);
  await writeFile(join(DATA_DIR, 'vault.json'), JSON.stringify({ anthropic: sealFor(key, was), 'browser:1:carried-cookies': sealFor(key, [{ name: 'sid', value: 'x', domain: '.example.test', path: '/' }]) }));
  const { getSecret } = await import('./vault.js');
  assert.deepEqual(await getSecret('anthropic'), was);
  assert.equal((await getSecret<unknown[]>('browser:1:carried-cookies'))?.length, 1);
});

test('in the cloud, sign-ins come back to the app on 5175, whatever port the platform gives the host', async () => {
  const { callbackPort, signInReturn } = await import('./integrations/oauth.js');
  assert.equal(callbackPort({ EAA_CLOUD_HOST: '1', PORT: '8080' }), 5175);
  assert.equal(callbackPort({ EAA_CLOUD_HOST: '1', PORT: '8080', EAA_CALLBACK_PORT: '5199' }), 5199);
  assert.equal(callbackPort({ PORT: '5175' }), 5175);
  assert.equal(callbackPort({}), 5175);
  const cloud = { EAA_CLOUD_HOST: '1', PORT: '8080' };
  assert.equal(signInReturn('/api/oauth/chatgpt/callback', '127.0.0.1', cloud), 'http://127.0.0.1:5175/api/oauth/chatgpt/callback');
  assert.equal(signInReturn('/api/oauth/openrouter/callback', 'localhost', cloud), 'http://localhost:5175/api/oauth/openrouter/callback');
  assert.equal(signInReturn('/api/oauth/chatgpt/callback', '127.0.0.1', { PORT: '5175' }), 'http://127.0.0.1:5175/api/oauth/chatgpt/callback');
});
