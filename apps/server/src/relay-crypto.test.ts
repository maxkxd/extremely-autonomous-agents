import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { appHandshake, fromB64url, hostHandshake, type Bytes } from './relay-crypto.js';

// The app's and the host's ends of the encrypted session, as the relay would join them.

// A host key pair as hosting.ts makes one.
const hostKey = () => {
  const pair = generateKeyPairSync('x25519');
  const publicKey = (pair.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  return { publicKey, der: new Uint8Array(pair.privateKey.export({ format: 'der', type: 'pkcs8' })) as Bytes };
};
const text = (s: string) => new TextEncoder().encode(s) as Bytes;
const read = (b: Bytes) => new TextDecoder().decode(b);

async function connect(org = 'org-1', key = hostKey(), appSees = key.publicKey) {
  const app = await appHandshake(org, appSees);
  const host = await hostHandshake(org, key.der, fromB64url(key.publicKey), app.hello);
  return { app: await app.finish(host.reply), host: host.session };
}

test('the app and the real host agree, and talk both ways', async () => {
  const { app, host } = await connect();
  assert.equal(read(await host.open(await app.seal(text('GET /api/runner/agents')))), 'GET /api/runner/agents');
  assert.equal(read(await app.open(await host.seal(text('{"ok":true}')))), '{"ok":true}');
  // And keep going, each message once.
  for (let i = 0; i < 5; i++) assert.equal(read(await host.open(await app.seal(text(`#${i}`)))), `#${i}`);
});

test("someone without the host's key can't pass for it", async () => {
  // The app expects one host; another (the relay, say) answers.
  await assert.rejects(connect('org-1', hostKey(), hostKey().publicKey), /isn’t this organisation’s host/);
});

test('a session is for one organisation', async () => {
  const key = hostKey();
  const app = await appHandshake('org-1', key.publicKey);
  const host = await hostHandshake('org-2', key.der, fromB64url(key.publicKey), app.hello);
  await assert.rejects(app.finish(host.reply));
});

test("what's sealed can't be read, changed, replayed or reordered", async () => {
  const { app, host } = await connect();
  const one = await app.seal(text('approve ap_1'));
  assert.ok(!read(one).includes('approve'), 'unreadable on the way');
  const changed = one.slice() as Bytes;
  changed[3] ^= 1;
  await assert.rejects(host.open(changed));
  const { app: a2, host: h2 } = await connect();
  const first = await a2.seal(text('first'));
  const second = await a2.seal(text('second'));
  await assert.rejects(h2.open(second), 'out of order');
  const { app: a3, host: h3 } = await connect();
  const m = await a3.seal(text('once'));
  assert.equal(read(await h3.open(m)), 'once');
  await assert.rejects(h3.open(m), 'replayed');
  void first;
});

test('every session has its own keys', async () => {
  const key = hostKey();
  const s1 = await connect('org-1', key);
  const s2 = await connect('org-1', key);
  await assert.rejects(s2.host.open(await s1.app.seal(text('x'))));
});

test("the app's copy is the same file", async () => {
  const here = await readFile(new URL('./relay-crypto.ts', import.meta.url), 'utf8');
  const app = await readFile(new URL('../../desktop/src/relay-crypto.ts', import.meta.url), 'utf8');
  assert.equal(app.replace(/\r\n/g, '\n'), here.replace(/\r\n/g, '\n'));
});
