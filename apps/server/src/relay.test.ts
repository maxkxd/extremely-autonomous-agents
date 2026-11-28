import './test-data-dir.js';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { WebSocketServer, type WebSocket as HostConnection } from 'ws';
import { relayState, replacedPause, startRelay, stopRelay } from './relay.js';
import { setSecret } from './vault.js';

// The host's connection to the relay (relay.ts), against a stand-in relay: it
// comes back after a drop, but one that another host replaced waits before it
// takes the place back, so two hosts don't push each other off every second.

const relay = new WebSocketServer({ host: '127.0.0.1', port: 0 });
const listening = new Promise<void>(r => relay.once('listening', () => r()));
// Each connection that signed in, oldest first.
const hosts: HostConnection[] = [];
relay.on('connection', ws => void ws.once('message', () => (hosts.push(ws), ws.send(JSON.stringify({ t: 'ready' })))));
after(() => {
  stopRelay();
  for (const ws of hosts) ws.terminate();
  relay.close();
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(what: () => boolean) {
  for (let i = 0; i < 100 && !what(); i++) await sleep(50);
  assert.ok(what());
}

test('a replaced host waits a minute, then longer, never more than 15 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 20].map(replacedPause), [60_000, 120_000, 240_000, 480_000, 900_000, 900_000]);
});

test('a dropped connection is made again; a replaced one says so and waits', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  await listening;
  await setSecret('hosting:org-test:secret', 'not-a-real-secret');
  // Placeholders: the keys are only used once a member's app opens a channel, and none does here.
  await setSecret('hosting:org-test:key', { publicKey: 'AAAA', privateKey: 'AAAA' });
  const h = { orgId: 'org-test', orgName: 'Test org', issuer: `http://127.0.0.1:${(relay.address() as AddressInfo).port}` };

  // Started twice at once: one connection, or it would replace itself.
  await Promise.all([startRelay(h), startRelay(h)]);
  await until(() => relayState() === 'online');
  await sleep(300);
  assert.equal(hosts.length, 1);

  // Dropped: back again by itself.
  hosts[0].terminate();
  await until(() => hosts.length === 2 && relayState() === 'online');
  assert.equal(warn.mock.callCount(), 0);

  // Replaced, as the relay does it: no new try within the seconds an ordinary drop takes.
  hosts[1].close(4000, 'Replaced by a newer connection.');
  await until(() => relayState() === 'off');
  await sleep(3_500);
  assert.equal(hosts.length, 2);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /Another host took this one's place.*Trying again in 1 min/);

  // Started again (a restart, or the app asking): takes the place back straight away.
  await startRelay(h);
  await until(() => hosts.length === 3 && relayState() === 'online');
});
