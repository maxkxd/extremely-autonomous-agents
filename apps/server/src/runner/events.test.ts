import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { DATA, save } from '../files.js';
import type { EventSource } from '../integrations/index.js';
import { Integration } from '../integrations/schema.js';
import { all, resetDbForTests, setSetting } from './db.js';
import { handleHook, hookToken, itemsFrom, pollEvents, verifySignature } from './events.js';
import { stateOf } from './run.js';
import { nextRun } from './scheduler.js';
import { loadAgent } from './agent.js';

const AGENT = 'zz-events-agent';
const OTHER = 'zz-events-other';

// A made-up service: a list of issues to poll, and signed webhook posts.
const integration = Integration.parse({
  kind: 'http',
  id: 'zz-tracker',
  name: 'ZZ Tracker',
  what: 'test',
  auth: { type: 'none' },
  base_url: 'https://tracker.example.com/api',
  test: { tool: 'zz.list', args: {} },
  tools: [{ id: 'zz.list', tier: 'T0', description: 'x', input: { type: 'object' }, request: { path: '/issues' } }],
  events: [
    {
      id: 'zz.new_issue',
      description: 'A new issue',
      poll: { request: { path: '/issues' }, items: 'data', id: 'id', fields: { title: 'title', level: 'level' }, every_minutes: 5 },
      webhook: { items: 'issues', id: 'id', fields: { title: 'title' }, signature: { header: 'X-Sig', algorithm: 'sha256', prefix: 'sha256=' } },
    },
    { id: 'zz.alarm', description: 'An alarm', webhook: {} },
  ],
});
const sources: EventSource[] = (integration.events ?? []).map(event => ({ integration, event, key: async () => undefined }));

let answer: unknown = { data: [] };
const fetcher = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(answer) });

const booked: { agent: string; trigger: string; task: string | null }[] = [];
const book = (agent: string, trigger: string, task: string | null) => {
  booked.push({ agent, trigger, task });
  all("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, ?, ?, 0, 0) RETURNING id", agent, trigger, task);
};

const agentFiles = (id: string, events: string[]) => ({
  id,
  name: id,
  department: 'engineering',
  charter: '# CHARTER\nTest.',
  tools: `agent_id: ${id}\ntool_tiers: {}\nevents: ${JSON.stringify(events)}\n`,
  kpi: 'output: []\n',
  models: [],
});

beforeEach(async () => {
  resetDbForTests();
  booked.length = 0;
  answer = { data: [] };
  await save(agentFiles(AGENT, ['zz.new_issue', 'zz.alarm']), { name: AGENT, department: 'engineering', output: [], status: 'ready' });
  await save(agentFiles(OTHER, []), { name: OTHER, department: 'engineering', output: [], status: 'ready' });
});
after(async () => {
  await rm(join(DATA, AGENT), { recursive: true, force: true });
  await rm(join(DATA, OTHER), { recursive: true, force: true });
});

test('items: the list at a path, each one\'s id and the fields the agent sees', () => {
  const items = itemsFrom({ data: [{ id: 7, title: 'Crash', extra: 'x' }] }, 'data', 'id', { title: 'title' });
  assert.deepEqual(items, [{ id: '7', summary: { title: 'Crash' } }]);
  // No path and not a list: the whole thing is one item, its id a hash of it.
  const one = itemsFrom({ alarm: 'CPU high' }, undefined, undefined, undefined);
  assert.equal(one.length, 1);
  assert.equal(one[0].id.length, 24);
  // A path that isn't there: nothing.
  assert.deepEqual(itemsFrom({}, 'data', 'id', undefined), []);
});

test("the agent's subscriptions are read from its TOOLS.yaml", async () => {
  assert.deepEqual((await loadAgent(AGENT))?.events, ['zz.new_issue', 'zz.alarm']);
});

test('polling: the first poll is only noted; new items after it wake the subscribed agent, once', async () => {
  answer = { data: [{ id: 1, title: 'Old bug', level: 'error' }] };
  await pollEvents(book, 0, fetcher, sources);
  assert.equal(booked.length, 0); // what was there already isn't news

  answer = { data: [{ id: 1, title: 'Old bug' }, { id: 2, title: 'New crash', level: 'fatal' }] };
  await pollEvents(book, 60_000, fetcher, sources); // not due yet (every 5 minutes)
  assert.equal(booked.length, 0);
  await pollEvents(book, 6 * 60_000, fetcher, sources);
  assert.equal(booked.length, 1);
  assert.equal(booked[0].agent, AGENT); // not the agent that isn't subscribed
  assert.equal(booked[0].trigger, 'event');
  assert.match(booked[0].task ?? '', /A new issue \(zz\.new_issue\): 1 new\n- \{"title":"New crash","level":"fatal"\}/);
  assert.doesNotMatch(booked[0].task ?? '', /Old bug/);

  // The same item again: nothing.
  await pollEvents(book, 12 * 60_000, fetcher, sources);
  assert.equal(booked.length, 1);
});

test('a burst while the wake is still waiting joins it: one run, not one per item', async () => {
  await pollEvents(book, 0, fetcher, sources); // baseline: nothing there
  answer = { data: [{ id: 'a', title: 'First' }] };
  await pollEvents(book, 6 * 60_000, fetcher, sources);
  answer = { data: [{ id: 'a', title: 'First' }, { id: 'b', title: 'Second' }] };
  await pollEvents(book, 12 * 60_000, fetcher, sources);
  const waiting = all<{ task: string }>("SELECT task FROM bookings WHERE agent_id = ? AND trigger = 'event'", AGENT);
  assert.equal(waiting.length, 1);
  assert.match(waiting[0].task, /First[\s\S]*Second/);
});

test('a failing poll is noted and retried on the next one; the agency stopped polls nothing', async () => {
  const broken = async () => ({ ok: false, status: 500, text: async () => '{"message":"down"}' });
  await pollEvents(book, 0, broken, sources);
  const st = JSON.parse(all<{ value: string }>("SELECT value FROM settings WHERE key = 'event_polls'")[0].value) as Record<string, { error: string }>;
  assert.match(st['zz.new_issue'].error, /ZZ Tracker answered 500: down/);

  resetDbForTests();
  setSetting('agency_state', 'stopped');
  let called = false;
  await pollEvents(book, 0, async () => ((called = true), { ok: true, status: 200, text: async () => '{"data":[]}' }), sources);
  assert.equal(called, false);
});

test('webhooks: signed posts are checked; a good one wakes the agent with each item', async () => {
  const token = hookToken('zz.new_issue');
  const raw = Buffer.from(JSON.stringify({ issues: [{ id: 'x1', title: 'Webhook crash' }] }));
  // No signing secret saved: refused.
  assert.equal((await handleHook(token, raw, { 'x-sig': 'sha256=abc' }, book, 0, sources)).status, 401);
  assert.equal((await handleHook('f'.repeat(36), raw, {}, book, 0, sources)).status, 404);
  assert.equal(booked.length, 0);

  // Unsigned event: any post is an item.
  const alarm = await handleHook(hookToken('zz.alarm'), Buffer.from('{"AlarmName":"CPU","NewStateValue":"ALARM"}'), {}, book, 0, sources);
  assert.deepEqual(alarm, { status: 200, message: '1 new' });
  assert.match(booked[0].task ?? '', /An alarm \(zz\.alarm\): 1 new\n- \{"AlarmName":"CPU","NewStateValue":"ALARM"\}/);
});

test('signatures: the HMAC of the raw body, with or without a prefix', () => {
  const raw = Buffer.from('{"a":1}');
  const sig = createHmac('sha256', 's3cret').update(raw).digest('hex');
  const opts = { algorithm: 'sha256' as const, prefix: 'sha256=', encoding: 'hex' as const };
  assert.equal(verifySignature(raw, `sha256=${sig}`, 's3cret', opts), true);
  assert.equal(verifySignature(raw, sig, 's3cret', opts), true);
  assert.equal(verifySignature(raw, `sha256=${sig}`, 'wrong', opts), false);
  assert.equal(verifySignature(Buffer.from('{"a":2}'), `sha256=${sig}`, 's3cret', opts), false);
  assert.equal(verifySignature(raw, undefined, 's3cret', opts), false);
});

test('an event wake waits on standby and while stopped, like a schedule; it runs when active', async () => {
  const a = (await loadAgent(AGENT))!;
  stateOf(AGENT);
  all("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, 'event', 'x', 0, 0) RETURNING id", AGENT);
  all("UPDATE agent_state SET state = 'draining' WHERE agent_id = ? RETURNING agent_id", AGENT);
  assert.equal(nextRun(a, stateOf(AGENT), Date.now()), null);
  all("UPDATE agent_state SET state = 'active' WHERE agent_id = ? RETURNING agent_id", AGENT);
  assert.equal(nextRun(a, stateOf(AGENT), Date.now())?.trigger, 'event');
});

test("the builder's events: existing ones kept, its new ones added, and the engineer asked once for each missing one", async () => {
  const { compose } = await import('../files.js');
  const { requestWhatsMissing } = await import('../agents.js');
  const build = {
    name: 'Bug Triage',
    department: 'engineering',
    charter: '# CHARTER',
    tools: [],
    new_tools: [],
    events: [{ id: 'zz.new_issue', why: 'triage each one' }, { id: 'made.up', why: 'x' }],
    new_events: [{ server: 'sentry', name: 'new_issue', description: 'A new Sentry issue', how_detected: 'Sentry issue alert webhook' }],
    kpi: [],
    max_runs_per_day: 10,
    approval_hours: [],
    models: [],
  } as unknown as Parameters<typeof compose>[0];
  const files = compose(build, 'zz-bug-triage', new Set(), [], new Set(['zz.new_issue']));
  const yaml = (await import('yaml')).parse(files.tools) as { events: string[]; new_events: { id: string }[] };
  assert.deepEqual(yaml.events, ['zz.new_issue', 'sentry.new_issue']); // made.up exists nowhere: dropped
  assert.deepEqual(yaml.new_events.map(e => e.id), ['sentry.new_issue']);

  await requestWhatsMissing(files);
  await requestWhatsMissing(files); // again (a pack agent after its tailoring): not asked twice
  const asked = all<{ what: string; evidence: string }>("SELECT what, evidence FROM requests WHERE agent_id = 'zz-bug-triage'");
  assert.deepEqual(asked.map(r => r.what), ['Set up Sentry events']); // one request per service
  assert.match(asked[0].evidence, /Sentry issue alert webhook/);
});

test("an agent remade under an old id asks again; a fleet tool it reuses that nobody built is asked for too", async () => {
  const { requestWhatsMissing } = await import('../agents.js');
  // A request from the deleted agent that had this id, closed.
  all("INSERT INTO requests (agent_id, what, why, status, created_at) VALUES ('zz-remade', 'Set up Zz', 'old', 'rejected', 0) RETURNING id");
  const files = {
    id: 'zz-remade',
    name: 'Remade',
    tools: 'tool_tiers: { zz.ping: T0, zz.someone_elses: T0, web.fetch_page: T0, files.write_file: T0 }\nnew_tools:\n  - { id: zz.ping, description: Pings, input_schema: {} }\n',
  };
  const filed = await requestWhatsMissing(files);
  // One request for the service, listing both: its own invention and another agent's nobody built. Catalogue and plumbing tools aren't asked for.
  assert.deepEqual(filed, ['Set up Zz']);
  // In the agent's own words; the tool ids are for the engineer.
  const r = all<{ why: string; evidence: string }>("SELECT why, evidence FROM requests WHERE agent_id = 'zz-remade' AND status = 'open'")[0];
  assert.match(r.why, /^I need Zz/);
  assert.match(r.why, /Pings/);
  assert.doesNotMatch(r.why, /zz\.ping/);
  assert.match(r.evidence, /zz\.ping, zz\.someone_elses/);
  assert.deepEqual(await requestWhatsMissing(files), []); // open now: not asked twice
});
