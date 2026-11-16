import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../relay.js';
import { setup, tick } from './fake-chrome.js';

// After a browser restart Chrome may restore the last session: agent tabs and their
// groups come back with new ids, and the relay's session state is gone. The record in
// chrome.storage.local lets it close them (and leave kept pages as normal tabs).

const A = 'ws://127.0.0.1:5185/api/browser-link';
const B = 'wss://agency.example.com/api/browser-link';
const research = { key: 'run-1', title: 'Researcher' };
const writer = { key: 'run-2', title: 'Writer', color: 'blue' };
const waiting = { key: 'waiting', title: 'Waiting on you', collapsed: false };

// A session with agent tabs of two agencies, a kept page, and the person's own tabs -
// some of them alike enough to be mistaken for agent tabs.
async function lastSession() {
  const s = await setup(createRelay);
  const { f, call, relay } = s;
  await call(A, 'Target.createTarget', { url: 'https://example.com/', eaaGroup: research }); // 100
  await call(A, 'Target.createTarget', { url: 'https://example.com/start', eaaGroup: research }); // 101
  // 101 navigates: the record follows it.
  f.tabs.get(101).url = 'https://example.com/results';
  await f.chrome.tabs.onUpdated.fire(101, { url: 'https://example.com/results' }, { ...f.tabs.get(101) });
  await call(A, 'Target.createTarget', { url: 'https://shop.example.com/checkout', eaaGroup: research }); // 102
  await call(A, 'EAA.groupTab', { targetId: 't:102', ...waiting });
  await call(B, 'Target.createTarget', { url: 'https://docs.example.com/', eaaGroup: writer }); // 103
  const own = f.personGroup('Researcher', 'grey'); // the agent group's title and color
  const mail = f.personTab('https://mail.example.com/', own); // ...but not an agent tab's address
  const red = f.personGroup('Researcher', 'red');
  const sameAddress = f.personTab('https://example.com/', red); // an agent tab's address, another color
  const loose = f.personTab('https://example.com/results'); // an agent tab's address, no group
  await relay.flushRecord();
  return { ...s, person: { mail, sameAddress, loose } };
}

async function restarted(f) {
  const sent = [];
  const relay = createRelay(f.chrome, (agency, frame) => sent.push({ agency, ...frame }), {});
  relay.listen();
  await relay.ready;
  return { relay, sent };
}

test('the record: agent tabs in a group, their address and the group’s title and color', async () => {
  const { f } = await lastSession();
  const { eaaAgentTabs } = await f.chrome.storage.local.get('eaaAgentTabs');
  assert.deepEqual(eaaAgentTabs, {
    v: 1,
    agencies: {
      [A]: [
        { url: 'https://example.com/', title: 'Researcher', color: 'grey', waiting: false },
        { url: 'https://example.com/results', title: 'Researcher', color: 'grey', waiting: false },
        { url: 'https://shop.example.com/checkout', title: 'Waiting on you', color: 'grey', waiting: true },
      ],
      [B]: [{ url: 'https://docs.example.com/', title: 'Writer', color: 'blue', waiting: false }],
    },
  });
});

test('the record is written a moment after a change, and drops closed tabs', async () => {
  const { f, call, relay } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/', eaaGroup: research });
  const now = (await f.chrome.storage.local.get('eaaAgentTabs')).eaaAgentTabs;
  assert.deepEqual(now.agencies, {}); // not yet: debounced
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await f.chrome.storage.local.get('eaaAgentTabs')).eaaAgentTabs.agencies[A].length, 1);
  await call(A, 'Target.closeTarget', { targetId: 't:100' });
  await tick();
  await relay.flushRecord();
  assert.deepEqual((await f.chrome.storage.local.get('eaaAgentTabs')).eaaAgentTabs.agencies, {});
});

test('browser restart: restored agent tabs close, a kept page stays as a normal tab, the person’s are untouched', async () => {
  const { f, person } = await lastSession();
  const id = f.restartBrowser();
  const { relay } = await restarted(f);
  // Nothing happens until the browser says it started.
  assert.equal(f.tabs.size, 7);
  await f.chrome.runtime.onStartup.fire();
  await tick();
  for (const old of [100, 101, 103]) assert.ok(!f.tabs.has(id.tab(old)), `agent tab ${old} closed`);
  const kept = f.tabs.get(id.tab(102));
  assert.ok(kept, 'the kept page stays open');
  assert.equal(kept.groupId, -1);
  for (const p of Object.values(person)) assert.ok(f.tabs.has(id.tab(p)), `the person's tab ${p} is open`);
  assert.notEqual(f.tabs.get(id.tab(person.mail)).groupId, -1);
  assert.notEqual(f.tabs.get(id.tab(person.sameAddress)).groupId, -1);
  assert.equal(relay.agentTabCount(), 0);
});

test('first connection after a restart: only that agency’s restored tabs, once', async () => {
  const { f } = await lastSession();
  const id = f.restartBrowser();
  const { relay } = await restarted(f);
  assert.deepEqual(await relay.sweepRestored(A), { closed: 2, ungrouped: 1 });
  await tick();
  assert.ok(!f.tabs.has(id.tab(100)) && !f.tabs.has(id.tab(101)));
  assert.ok(f.tabs.has(id.tab(103)), 'the other agency’s waits for its own connection');
  // Done with: connecting again later touches nothing.
  const again = f.personTab('https://example.com/', f.tabs.get(id.tab(103)).groupId);
  assert.deepEqual(await relay.sweepRestored(A), { closed: 0, ungrouped: 0 });
  assert.deepEqual(await relay.sweepRestored(B), { closed: 1, ungrouped: 0 });
  assert.ok(f.tabs.has(again), 'not an agent tab’s address in that group: left');
  // A worker restart in the same browser session doesn't bring the old record back.
  const { relay: worker } = await restarted(f);
  assert.deepEqual(await worker.sweepRestored(A), { closed: 0, ungrouped: 0 });
});

test('a tab an agency opened in this session is never swept, even at a restored address', async () => {
  const { f } = await lastSession();
  const id = f.restartBrowser();
  const { relay, sent } = await restarted(f);
  await relay.handle(A, { id: 1, method: 'Target.createTarget', params: { url: 'https://example.com/', eaaGroup: research } });
  const fresh = Number(sent.find(s => s.id === 1).result.targetId.slice(2));
  f.tabs.get(fresh).url = 'https://example.com/';
  await relay.sweepRestored(A);
  await tick();
  assert.ok(f.tabs.has(fresh));
  assert.ok(!f.tabs.has(id.tab(100)));
  assert.equal(relay.agentTabCount(A), 1);
});

test('a worker restart is not a browser restart: agent tabs stay', async () => {
  const { f, relay } = await lastSession();
  await relay.saved();
  const { relay: worker } = await restarted(f);
  assert.deepEqual(await worker.sweepRestored(A), { closed: 0, ungrouped: 0 });
  await f.chrome.runtime.onStartup.fire();
  assert.ok(f.tabs.has(100) && f.tabs.has(101) && f.tabs.has(103));
  assert.equal(worker.agentTabCount(A), 3);
});

test('a removed pairing’s restored tabs are left alone', async () => {
  const { f } = await lastSession();
  const id = f.restartBrowser();
  const { relay } = await restarted(f);
  await relay.forgetAgency(B);
  await f.chrome.runtime.onStartup.fire();
  await tick();
  assert.ok(f.tabs.has(id.tab(103)));
  assert.ok(!f.tabs.has(id.tab(100)));
});
