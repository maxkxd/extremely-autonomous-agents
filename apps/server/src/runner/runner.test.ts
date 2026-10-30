import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { DEFAULT_PLAN, type AgentDef } from './agent.js';
import { all, one, resetDbForTests, run as exec, setSetting } from './db.js';
import { APOCALYPTIC, backoffMs, CHILL, DRIVEN, HOUR, RELENTLESS } from './ferocity.js';
import { compactIfNeeded, isToolFailureNote, memoryForPrompt, remember } from './memory.js';
import { ModelError, type Adapter, type Call } from './providers.js';
import { runAgent, stateOf, type RunDeps } from './run.js';
import { dropStaleRequestRuns, nextRun } from './scheduler.js';
import { forgetAgentRuns } from './forget.js';
import { fleetReport } from './doctor.js';
import { answerRequest } from './api.js';
import { notWaitingAlready, requestNotWaiting, withdrawProposal } from './engineer.js';
import { execute, registerTools, requestConnections, serviceLabel, WORKSPACES } from './tools.js';

const ID = 'zz-runner-test';

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: ID,
  name: 'Test Agent',
  department: 'research',
  owner: null,
  org: null,
  charter: '# CHARTER - Test Agent\nWrite ideas.',
  models: [
    { connection: 'a', model: 'm1', effort: 'medium' },
    { connection: 'b', model: 'm2', effort: 'medium' },
  ],
  tiers: {},
  approvalHours: {},
  newTools: [],
  events: [],
  newEvents: [],
  output: [{ action: 'files.write_file', label: 'ideas written' }],
  maxRunsPerDay: 24,
  ferocity: { ...DEFAULT_PLAN, counts: ['files.write_file'], floor: 10, soft_floor: 3, apocalyptic_floor: 30 },
  limits: [],
  ...over,
});

let fileSeq = 0;
const write = (): Call => ({ id: `c${fileSeq}`, name: 'files__write_file', args: { path: `ideas/${fileSeq++}.md`, content: 'an idea' } });

// A model that makes `per` output calls every time it's prompted, then ends
// its turn - so each nudge buys exactly `per` more acts.
function fake(per: number, seen: string[] = []): Adapter {
  return async req => {
    const last = req.messages[req.messages.length - 1];
    seen.push(req.connection);
    if (last.role === 'tool') return { text: 'Done for now.', calls: [], usage: { input: 10, output: 5 } };
    return { text: '', calls: Array.from({ length: per }, write), usage: { input: 10, output: 5 } };
  };
}

const deps = (adapter: Adapter, over: Partial<RunDeps> = {}): RunDeps => ({
  now: () => Date.now(),
  adapter: () => adapter,
  harness: () => null,
  modelInfo: () => ({ usable: true, efforts: [] }),
  cost: async () => 0.001,
  wake: () => {},
  compact: false,
  ...over,
});

const setLevel = (level: number) => {
  stateOf(ID);
  exec('UPDATE agent_state SET ferocity = ? WHERE agent_id = ?', level, ID);
};

beforeEach(() => {
  resetDbForTests();
});
after(async () => {
  await rm(join(WORKSPACES, ID), { recursive: true, force: true });
});

test('Relentless: nudged until it reaches its floor, then it ends', async () => {
  setLevel(RELENTLESS);
  const r = await runAgent(agent(), 'scheduled', null, deps(fake(2)));
  assert.equal(r.status, 'succeeded');
  assert.equal(r.acts, 10); // 2 + 4 nudges x 2
  assert.equal(r.nudges, 4);
});

test('Relentless: after 4 nudges below the floor the run just ends with what it made', async () => {
  setLevel(RELENTLESS);
  const r = await runAgent(agent({ ferocity: { ...agent().ferocity, floor: 50 } }), 'scheduled', null, deps(fake(2)));
  assert.equal(r.status, 'succeeded');
  assert.equal(r.nudges, 4);
  assert.equal(r.acts, 10);
});

test('the nudge says where it stands and where else to look', async () => {
  setLevel(RELENTLESS);
  const prompts: string[] = [];
  const spy: Adapter = async req => {
    const last = req.messages[req.messages.length - 1];
    if (last.role === 'user') prompts.push(last.text);
    return fake(1)(req);
  };
  await runAgent(agent(), 'scheduled', null, deps(spy));
  assert.match(prompts[1], /^Not finished\. This run has made 1 output action\(s\); the floor for every run is 10/);
  assert.match(prompts[1], /Continuation 1 of 4/);
  assert.match(prompts[1], new RegExp(DEFAULT_PLAN.hint));
});

test('Driven: one gentle nudge at most', async () => {
  setLevel(DRIVEN);
  const r = await runAgent(agent(), 'scheduled', null, deps(fake(1)));
  assert.equal(r.nudges, 1);
  assert.equal(r.acts, 2);
});

test('Chill: never nudged', async () => {
  setLevel(CHILL);
  const r = await runAgent(agent(), 'scheduled', null, deps(fake(1)));
  assert.equal(r.nudges, 0);
});

test('a run answering your message is never pushed past its answer', async () => {
  setLevel(APOCALYPTIC);
  const r = await runAgent(agent(), 'your message', 'What are you working on?', deps(fake(1)));
  assert.equal(r.nudges, 0);
});

test('a natural limit refuses the call, and refused calls never count', async () => {
  setLevel(RELENTLESS);
  const limited = agent({ limits: [{ tool: 'files.write_file', max: 3, per_hours: 24, why: 'once a morning' }] });
  const r = await runAgent(limited, 'scheduled', null, deps(fake(2)));
  assert.equal(r.acts, 3); // 3 allowed, every later call refused and not counted
  const refused = one<{ n: number }>("SELECT COUNT(*) AS n FROM actions WHERE outcome = 'refused'")!.n;
  assert.ok(refused > 0);
});

test('T2 actions are queued for approval, never run, the run carries on, and they count', async () => {
  setLevel(RELENTLESS);
  let sent = 0;
  registerTools([
    {
      id: 'zztest.send_pitch',
      tier: 'T2',
      description: 'Send a pitch',
      schema: { type: 'object', properties: { to: { type: 'string' } } },
      impl: () => {
        sent++;
        return 'sent';
      },
    },
  ]);
  const pitcher = agent({ tiers: { 'zztest.send_pitch': 'T2' }, ferocity: { ...agent().ferocity, counts: ['zztest.send_pitch'], floor: 3 } });
  let n = 0;
  const model: Adapter = async req => {
    const last = req.messages[req.messages.length - 1];
    if (last.role === 'tool') return { text: 'Queued my pitches.', calls: [], usage: { input: 1, output: 1 } };
    return { text: '', calls: [{ id: `p${n++}`, name: 'zztest__send_pitch', args: { to: 'someone' } }], usage: { input: 1, output: 1 } };
  };
  const r = await runAgent(pitcher, 'scheduled', null, deps(model));
  assert.equal(r.status, 'succeeded');
  assert.equal(r.acts, 3); // each queued pitch counted toward the floor of 3
  assert.equal(sent, 0); // nothing ran without a person's decision
  assert.equal(all("SELECT id FROM approvals WHERE status = 'pending'").length, 3);
});

test('a registered tool the agent does not hold is refused', async () => {
  setLevel(CHILL);
  registerTools([{ id: 'zztest.other', tier: 'T0', description: 'x', schema: { type: 'object' }, impl: () => 'ran' }]);
  const model: Adapter = async req =>
    req.messages.length > 1
      ? { text: 'ok', calls: [], usage: { input: 1, output: 1 } }
      : { text: '', calls: [{ id: 'x', name: 'zztest__other', args: {} }], usage: { input: 1, output: 1 } };
  await runAgent(agent(), 'scheduled', null, deps(model));
  assert.equal(one<{ outcome: string }>('SELECT outcome FROM actions')!.outcome, 'refused');
});

test('a model that fails mid-run hands over to the next one, and no action is repeated', async () => {
  setLevel(CHILL);
  let calls = 0;
  const a: Adapter = async req => {
    calls++;
    if (req.messages.length > 1) throw new ModelError('busy', 'rate', 429); // fails after its first turn
    return { text: '', calls: [write()], usage: { input: 1, output: 1 } };
  };
  const b: Adapter = async () => ({ text: 'Finished on the second model.', calls: [], usage: { input: 1, output: 1 } });
  const r = await runAgent(agent(), 'scheduled', null, deps(a, { adapter: c => (c === 'a' ? a : b) }));
  assert.equal(r.status, 'succeeded');
  assert.equal(r.summary, 'Finished on the second model.');
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM actions')!.n, 1);
  assert.equal(one<{ connection: string }>('SELECT connection FROM runs')!.connection, 'b');
  assert.ok(calls >= 2);
});

test('every model failing fails the run, posts why, and backs the agent off', async () => {
  setLevel(CHILL);
  const down: Adapter = async () => {
    throw new ModelError('down', 'server', 500);
  };
  const r = await runAgent(agent(), 'scheduled', null, deps(down));
  assert.equal(r.status, 'failed');
  assert.match(one<{ body: string }>('SELECT body FROM dm')!.body, /Run failed/);
  const st = stateOf(ID);
  assert.equal(st.fail_streak, 1);
  assert.ok(st.backoff_until! > Date.now());
});

test('the run posts to its DM channel with argument names only', async () => {
  setLevel(CHILL);
  await runAgent(agent(), 'scheduled', null, deps(fake(1)));
  const post = JSON.parse(one<{ body: string }>("SELECT body FROM dm WHERE kind = 'run'")!.body);
  assert.equal(post.kind, 'run');
  assert.deepEqual(post.tools[0], { server: 'files', tool: 'write_file', fields: ['path', 'content'], status: 'ok' });
  assert.ok(!JSON.stringify(post).includes('an idea')); // never the values
});

test('memory: tool failures are refused, notes come newest first', () => {
  assert.equal(isToolFailureNote('send_email does not work, it fails every time', ['gmail.send_email']), true);
  assert.equal(isToolFailureNote('The tool is broken', []), true);
  assert.equal(isToolFailureNote('Max prefers wallpapers with mountains', ['gmail.send_email']), false);
  assert.equal(remember(ID, 'web_search is broken', ['web.web_search']).ok, false);
  remember(ID, 'first', [], 1000);
  remember(ID, 'second', [], 2000);
  const text = memoryForPrompt(ID, 3000);
  assert.ok(text.indexOf('second') < text.indexOf('first'));
});

test('memory compacts its oldest notes past the cap', async () => {
  for (let i = 0; i < 130; i++) remember(ID, `note ${i}`, [], 1000 + i);
  let given: string[] = [];
  const done = await compactIfNeeded(ID, async old => {
    given = old;
    return 'Summary of the early notes.';
  });
  assert.equal(done, true);
  assert.equal(given.length, 50); // 130 - 80 kept
  assert.equal(all("SELECT id FROM memories WHERE kind = 'note'").length, 80);
  assert.match(memoryForPrompt(ID, 5000), /Earlier, .* Summary of the early notes\./);
});

test('schedule: Chill runs on its schedule; Apocalyptic straight after the last run', () => {
  const now = Date.now();
  const a = agent();
  setLevel(CHILL);
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'scheduled'); // never run yet: now
  exec('UPDATE agent_state SET last_scheduled_at = ? WHERE agent_id = ?', now - 2 * HOUR, ID);
  assert.equal(nextRun(a, stateOf(ID), now), null); // every 24 h
  exec('UPDATE agent_state SET last_scheduled_at = ? WHERE agent_id = ?', now - 25 * HOUR, ID);
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'scheduled');

  setLevel(APOCALYPTIC);
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, ended_at) VALUES ('r1', ?, 'apocalyptic', 4, 'succeeded', ?, ?)", ID, now - 60_000, now - 5_000);
  assert.equal(nextRun(a, stateOf(ID), now), null); // a breath between runs
  assert.equal(nextRun(a, stateOf(ID), now + 30_000)?.trigger, 'apocalyptic');
});

test('schedule: stopped runs nothing at all; backoff and the backstop hold everything else', () => {
  const now = Date.now();
  const a = agent();
  stateOf(ID);
  exec("UPDATE agent_state SET state = 'stopped' WHERE agent_id = ?", ID);
  assert.equal(nextRun(a, stateOf(ID), now), null);
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, 'your message', 'hi', ?, ?)", ID, now, now);
  assert.equal(nextRun(a, stateOf(ID), now), null); // not even a message; it waits
  exec("UPDATE agent_state SET state = 'active' WHERE agent_id = ?", ID);
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'your message'); // answered once it's back on

  resetDbForTests();
  stateOf(ID);
  exec('UPDATE agent_state SET backoff_until = ? WHERE agent_id = ?', now + 60_000, ID);
  assert.equal(nextRun(a, stateOf(ID), now), null);

  resetDbForTests();
  setLevel(CHILL);
  for (let i = 0; i < 40; i++) exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at) VALUES (?, ?, 'scheduled', 0, 'succeeded', ?)", `r${i}`, ID, now - i);
  assert.equal(nextRun(a, stateOf(ID), now), null); // past the backstop for today
});

test('schedule: draining starts nothing itself, but runs what a person sets off', () => {
  const now = Date.now();
  const a = agent();
  stateOf(ID);
  exec("UPDATE agent_state SET state = 'draining' WHERE agent_id = ?", ID);
  assert.equal(nextRun(a, stateOf(ID), now), null); // its schedule is due (never run), but no
  const booking = (trigger: string) => exec('INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, ?, ?, ?, ?)', ID, trigger, 't', now, now);
  booking('self-booked');
  booking('handoff');
  assert.equal(nextRun(a, stateOf(ID), now), null); // nor its own bookings, nor handed work
  booking('run now');
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'run now');
  exec("DELETE FROM bookings WHERE trigger = 'run now'");
  booking('approval');
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'approval'); // hearing how its approval went
  booking('your message');
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'your message'); // a person's message first
  setLevel(APOCALYPTIC);
  exec("UPDATE agent_state SET state = 'draining' WHERE agent_id = ?", ID);
  exec("DELETE FROM bookings WHERE agent_id = ?", ID);
  assert.equal(nextRun(a, stateOf(ID), now), null); // Apocalyptic doesn't chain either
});

test('a run a person stops is "stopped", not failed, and brings no backoff', async () => {
  const controller = new AbortController();
  const adapter: Adapter = async () => {
    controller.abort();
    throw new ModelError('aborted', 'network');
  };
  await runAgent(agent(), 'scheduled', null, deps(adapter), controller.signal);
  const row = one<{ status: string }>('SELECT status FROM runs ORDER BY started_at DESC LIMIT 1');
  assert.equal(row?.status, 'stopped');
  assert.equal(stateOf(ID).fail_streak, 0);
  assert.equal(stateOf(ID).backoff_until, null);
});

test('failure backoff grows and caps at an hour', () => {
  assert.equal(backoffMs(0), 0);
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(3), 4 * 60_000);
  assert.equal(backoffMs(20), 60 * 60_000);
});

test('the agency stopped: nothing runs, not even a message, until it is resumed', () => {
  const now = Date.now();
  const a = agent();
  stateOf(ID);
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, 'your message', 'hi', ?, ?)", ID, now, now);
  setSetting('agency_state', 'stopped');
  assert.equal(stateOf(ID).state, 'stopped');
  assert.equal(nextRun(a, stateOf(ID), now), null);
  setSetting('agency_state', 'active');
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'your message');
});

test('a run a restart cut short carries on, told what it already did', async () => {
  exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, at) VALUES ('r_cut', ?, 'files.write_file', '[]', 'T0', 'ok', ?)", ID, Date.now());
  let opening = '';
  const adapter: Adapter = async req => {
    const first = req.messages[0];
    opening ||= first.role === 'user' ? first.text : '';
    return { text: 'Done.', calls: [], usage: { input: 1, output: 1 } };
  };
  await runAgent(agent(), 'run now', null, deps(adapter), undefined, 'r_cut');
  assert.match(opening, /restarted part-way.*files\.write_file \(ok\)/);
});

test('deleting an agent settles everything it left: approvals, requests, bookings, work handed to it', async () => {
  const now = Date.now();
  stateOf(ID);
  exec("INSERT INTO approvals (id, agent_id, run_id, tool, args, created_at, expires_at) VALUES ('a1', ?, 'r1', 'gmail.send', '{}', ?, ?)", ID, now, now + 86_400_000);
  exec("INSERT INTO approvals (id, agent_id, run_id, tool, args, created_at, expires_at) VALUES ('a2', 'fleet', 'r2', 'engineer.give_tools', ?, ?, ?)", JSON.stringify({ for_agent: ID }), now, now + 86_400_000);
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, 'run now', null, ?, ?)", ID, now, now);
  exec("INSERT INTO requests (agent_id, what, why, created_at) VALUES (?, 'a tool', 'needs it', ?)", ID, now);
  exec("INSERT INTO tasks (agent_id, from_agent, task, created_at) VALUES (?, 'other', 'do a thing', ?)", ID, now);
  await forgetAgentRuns(ID, now);
  assert.deepEqual(all<{ status: string }>("SELECT status FROM approvals ORDER BY id").map(a => a.status), ['rejected', 'rejected']);
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM bookings')!.n, 0);
  assert.equal(one<{ status: string }>('SELECT status FROM requests')!.status, 'withdrawn'); // nobody turned it down
  // An agent remade under the same id isn't told its predecessor's were turned down.
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM requests WHERE delivered_at IS NULL')!.n, 0);
  assert.match(one<{ status: string; result: string }>('SELECT status, result FROM tasks')!.result, /deleted/);
});

test('tools that need a service nobody connected are asked for, once per service, and closed once it is', () => {
  const now = Date.now();
  let connected = false;
  registerTools([
    { id: 'gmail.list_messages', tier: 'T0', description: 'Search', schema: {}, impl: () => '', ready: () => connected },
    { id: 'gmail.send_email', tier: 'T2', description: 'Send', schema: {}, impl: () => '', ready: () => connected },
  ]);
  const woke: string[] = [];
  const tiers = { 'gmail.list_messages': 'T0', 'gmail.send_email': 'T2', 'crm.search_records': 'T0', 'crm.create_record': 'T1', 'my.invented': 'T0' } as const;
  const filed = requestConnections(ID, 'Test Agent', tiers, now, a => woke.push(a));
  assert.deepEqual(filed.sort(), ['Connect email (Gmail or Outlook)', 'Set up a CRM (HubSpot, Zoho, Salesforce)']);
  const rows = all<{ what: string; stage: string }>('SELECT what, stage FROM requests ORDER BY what');
  // Both the Agency Engineer's: it walks a person through connecting Gmail, and builds a CRM.
  assert.deepEqual(rows.map(r => r.stage), ['engineer', 'engineer']);
  assert.deepEqual(woke, ['fleet', 'fleet']);
  assert.deepEqual(requestConnections(ID, 'Test Agent', tiers, now + 1, () => {}), []); // not again while open
  // The engineer drafts a CRM: "Connect" is the same ask as the open "Set up", not another.
  registerTools([{ id: 'crm.search_records', tier: 'T0', description: 'Find', schema: {}, impl: () => '', ready: () => connected }, { id: 'crm.create_record', tier: 'T1', description: 'Add', schema: {}, impl: () => '', ready: () => connected }]);
  assert.deepEqual(requestConnections(ID, 'Test Agent', tiers, now + 1, () => {}), []);
  // Its agent deleted: withdrawn, and the same agent added back asks again straight away.
  exec("UPDATE requests SET status = 'withdrawn', answered_at = ? WHERE status = 'open'", now + 1);
  assert.deepEqual(requestConnections(ID, 'Test Agent', tiers, now + 2, () => {}).sort(), ['Connect a CRM (HubSpot, Zoho, Salesforce)', 'Connect email (Gmail or Outlook)']);
  connected = true;
  requestConnections(ID, 'Test Agent', tiers, now + 3, () => {});
  assert.deepEqual(all<{ status: string }>("SELECT status FROM requests WHERE status = 'open'"), []); // closed once connected
});

test('the agency on standby: nothing starts by itself, a person is still answered, and an agent stopped on its own stays stopped', () => {
  const now = Date.now();
  const a = agent();
  setLevel(CHILL);
  setSetting('agency_state', 'standby');
  assert.equal(stateOf(ID).state, 'draining');
  assert.equal(nextRun(a, stateOf(ID), now), null); // its schedule waits
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, 'your message', 'hi', ?, ?)", ID, now, now);
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'your message');
  exec("UPDATE agent_state SET state = 'stopped' WHERE agent_id = ?", ID);
  assert.equal(stateOf(ID).state, 'stopped');
  setSetting('agency_state', 'active');
});

test("the Agency Engineer's queued runs for closed requests are dropped, not run", () => {
  const now = Date.now();
  const open = Number(exec("INSERT INTO requests (agent_id, what, why, created_at) VALUES ('a', 'x', 'y', ?)", now).lastInsertRowid);
  const closed = Number(exec("INSERT INTO requests (agent_id, what, why, status, created_at) VALUES ('b', 'x', 'y', 'rejected', ?)", now).lastInsertRowid);
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES ('fleet', 'request', ?, ?, ?)", `Request #${open} from a: x`, now, now);
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES ('fleet', 'request', ?, ?, ?)", `Request #${closed} from b: x`, now, now);
  dropStaleRequestRuns();
  assert.deepEqual(all<{ task: string }>('SELECT task FROM bookings').map(b => b.task), [`Request #${open} from a: x`]);
});

test("quick replies on a request join the Agency Engineer's waiting run: one run answers them all", async () => {
  const { replyToEngineer } = await import('./api.js');
  replyToEngineer(4, 'Max', 'use acme/web');
  replyToEngineer(4, 'Max', 'actually acme/app');
  replyToEngineer(41, 'Max', 'yes');
  const queued = all<{ task: string }>("SELECT task FROM bookings WHERE agent_id = 'fleet' ORDER BY id").map(b => b.task);
  assert.equal(queued.length, 2);
  assert.match(queued[0], /replied on request #4: "use acme\/web"\nThen: "actually acme\/app"/);
  assert.match(queued[1], /request #41: "yes"/);
});

test('a resumed Agency Engineer run is told what it already said, so it does not answer twice', async () => {
  const now = Date.now();
  exec("INSERT INTO runs (id, agent_id, trigger, task, ferocity, status, started_at) VALUES ('r_cut2', 'fleet', 'request reply', 'x', 0, 'failed', ?)", now - 60_000);
  exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, at) VALUES ('r_cut2', 'fleet', 'engineer.reply_to_request', '[]', 'T0', 'ok', ?)", now - 30_000);
  exec("INSERT INTO request_messages (request_id, from_who, text, at) VALUES (37, 'engineer', 'Sentry is the right provider. Reply with the org slug.', ?)", now - 30_000);
  exec("INSERT INTO request_messages (request_id, from_who, text, at) VALUES (37, 'engineer', 'An older message from before the run.', ?)", now - 600_000);
  let opening = '';
  const adapter: Adapter = async req => {
    const first = req.messages[0];
    opening ||= first.role === 'user' ? first.text : '';
    return { text: 'Done.', calls: [], usage: { input: 1, output: 1 } };
  };
  await runAgent({ ...agent(), id: 'fleet' }, 'run now', null, deps(adapter), undefined, 'r_cut2');
  assert.match(opening, /Already sent on request #37 \(the person has it - don't send it again\): "Sentry is the right provider/);
  assert.doesNotMatch(opening, /older message/);
  assert.match(opening, /you're done: end the run/);
});

test("a queued reply the engineer has since read and answered is dropped; one it hasn't read stays", () => {
  const now = Date.now();
  const id = Number(exec("INSERT INTO requests (agent_id, what, why, created_at, stage) VALUES ('a', 'x', 'y', ?, 'engineer')", now - 60_000).lastInsertRowid);
  exec("INSERT INTO request_messages (request_id, from_who, text, at) VALUES (?, 'you', 'reply 1', ?)", id, now - 50_000);
  exec("INSERT INTO request_messages (request_id, from_who, text, at) VALUES (?, 'you', 'reply 2', ?)", id, now - 49_000);
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES ('fleet', 'request reply', ?, ?, ?)", `Max replied on request #${id}: "reply 2"`, now, now - 49_000);
  // Not read yet: it stays.
  dropStaleRequestRuns();
  assert.equal(all('SELECT id FROM bookings').length, 1);
  // Read before reply 2 came: still not seen.
  exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, at) VALUES ('r1', 'fleet', 'engineer.list_requests', '[]', 'T0', 'ok', ?)", now - 49_500);
  exec("INSERT INTO request_messages (request_id, from_who, text, at) VALUES (?, 'engineer', 'answer to reply 1', ?)", id, now - 40_000);
  dropStaleRequestRuns();
  assert.equal(all('SELECT id FROM bookings').length, 1);
  // Read after it, then answered: dropped.
  exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, at) VALUES ('r1', 'fleet', 'engineer.list_requests', '[]', 'T0', 'ok', ?)", now - 45_000);
  exec("INSERT INTO request_messages (request_id, from_who, text, at) VALUES (?, 'engineer', 'answer to both', ?)", id, now - 30_000);
  dropStaleRequestRuns();
  assert.equal(all('SELECT id FROM bookings').length, 0);
});

test("a person's no doesn't strand the agent: the Agency Engineer is woken to follow it up, and that run isn't dropped as stale", async () => {
  const now = Date.now();
  exec("INSERT INTO requests (agent_id, what, why, created_at, stage) VALUES (?, 'Set up a CRM (HubSpot)', 'leads', ?, 'waiting_you')", ID, now);
  const id = one<{ id: number }>('SELECT MAX(id) AS id FROM requests')!.id;
  assert.equal(await answerRequest(id, 'rejected', null), true);
  const b = one<{ trigger: string; task: string }>("SELECT trigger, task FROM bookings WHERE agent_id = 'fleet'");
  assert.equal(b?.trigger, 'turned down');
  assert.match(b!.task, /without saying why/);
  dropStaleRequestRuns();
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM bookings WHERE agent_id = 'fleet'")!.n, 1);
});

test("the Agency Engineer can't queue the same proposal twice while a person hasn't decided the first", () => {
  const now = Date.now();
  exec("INSERT INTO approvals (id, agent_id, run_id, tool, args, created_at, expires_at) VALUES ('p1', 'fleet', 'r1', 'engineer.publish_integration', ?, ?, ?)", JSON.stringify({ for_agent: 'lead-research', integration_id: 'google-drive', request_id: 5 }), now, now + 86_400_000);
  assert.throws(() => notWaitingAlready('engineer.publish_integration', { for_agent: 'lead-research', integration_id: 'google-drive' }, 'integration_id'), /already waiting/);
  notWaitingAlready('engineer.publish_integration', { for_agent: 'outreach', integration_id: 'google-drive' }, 'integration_id'); // another agent: fine
  exec("UPDATE approvals SET status = 'approved' WHERE id = 'p1'");
  notWaitingAlready('engineer.publish_integration', { for_agent: 'lead-research', integration_id: 'google-drive' }, 'integration_id'); // decided: fine
});

test('one card per agent: a request already on a waiting card, its own or grouped into another, gets no second one', () => {
  const now = Date.now();
  exec("INSERT INTO approvals (id, agent_id, run_id, tool, args, created_at, expires_at) VALUES ('g1', 'fleet', 'r1', 'engineer.publish_integration', ?, ?, ?)", JSON.stringify({ for_agent: 'lead-research', integration_id: 'drive', request_id: 41, also: [{ for_agent: 'outreach', request_id: 42, tools: [] }] }), now, now + 86_400_000);
  assert.throws(() => requestNotWaiting(41), /already on a card/);
  assert.throws(() => requestNotWaiting(42), /already on a card/); // grouped into Lead Research's
  requestNotWaiting(43);
});

test('the Agency Engineer withdraws its waiting card to propose an updated one: every request on it comes back', () => {
  const now = Date.now();
  exec("INSERT INTO requests (id, agent_id, what, why, created_at, stage) VALUES (61, 'lead-research', 'Set up Drive', 'files', ?, 'approval'), (62, 'outreach', 'Set up Drive', 'files', ?, 'approval')", now, now);
  exec("INSERT INTO approvals (id, agent_id, run_id, tool, args, created_at, expires_at) VALUES ('w1', 'fleet', 'r1', 'engineer.publish_integration', ?, ?, ?)", JSON.stringify({ for_agent: 'lead-research', integration_id: 'drive2', request_id: 61, also: [{ for_agent: 'outreach', request_id: 62, tools: [] }] }), now, now + 86_400_000);
  assert.throws(() => requestNotWaiting(62), /withdraw it first/);
  assert.deepEqual(withdrawProposal(62, 'They asked for read-only.'), [61, 62]);
  assert.equal(one<{ status: string }>("SELECT status FROM approvals WHERE id = 'w1'")!.status, 'withdrawn');
  assert.deepEqual(all<{ stage: string }>('SELECT stage FROM requests WHERE id IN (61, 62)').map(r => r.stage), ['engineer', 'engineer']);
  requestNotWaiting(61); // free to propose the updated card
  requestNotWaiting(62);
  assert.throws(() => withdrawProposal(61, 'again'), /no card waiting/);
});

test("the Agency Doctor's report shows what nobody asked about: a request filed again and again, and output made of busywork", async () => {
  const now = Date.now();
  stateOf(ID);
  exec("INSERT INTO requests (agent_id, what, why, created_at, status, answer, answered_at) VALUES (?, 'Set up Google Drive', 'docs', ?, 'done', 'You now have: drive.read_doc', ?), (?, 'Set up Google Drive', 'docs', ?, 'open', NULL, NULL)", ID, now - 7200_000, now - 3600_000, ID, now - 60_000);
  exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, output, at) VALUES ('r9', ?, 'files.write_file', '[]', 'T0', 'ok', 9, ?), ('r9', ?, 'gmail.send_email', '[]', 'T2', 'queued', 1, ?)", ID, now - 1000, ID, now - 1000);
  const report = await fleetReport(now, now - 24 * 3600_000, [ID]);
  assert.match(report, /filed 2 times: "Set up Google Drive"/);
  assert.match(report, /files\.write_file 9 \(90%\)/);
  assert.match(report, /answered #\d+: "Set up Google Drive" -> You now have/);
});

test("a request names the service the agent's instructions use, not the catalogue's examples", async () => {
  const { DATA } = await import('../files.js');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(DATA, 'zz-books'), { recursive: true });
  await writeFile(join(DATA, 'zz-books', 'CHARTER.md'), '# Revenue Ops\nReconcile Stripe against Xero and draft invoices in Xero.');
  assert.equal(serviceLabel('xero', 'zz-books'), 'Xero'); // not "accounting (Xero, QuickBooks)"
  assert.equal(serviceLabel('crm', 'zz-books'), 'a CRM (HubSpot, Zoho, Salesforce)'); // names none: the examples stay
  assert.equal(serviceLabel('xero'), 'accounting (Xero, QuickBooks)');
});

test("busywork doesn't meet a target: past 5 workspace files a run, they don't count for an agent with real output", async () => {
  const busy = agent({ ferocity: { ...DEFAULT_PLAN, counts: ['files.write_file', 'gmail.send_email'], floor: 20, soft_floor: 3, apocalyptic_floor: 30 } });
  const ctx = { agent: busy, runId: 'r_busy', level: 0, now: () => Date.now(), fleet: async () => [], wake: () => {} };
  const ids = new Map([['files__write_file', 'files.write_file']]);
  let total = 0;
  let last = '';
  for (let i = 0; i < 8; i++) {
    const r = await execute(ctx, { id: `c${i}`, name: 'files__write_file', args: { path: `notes/n${i}.md`, content: 'x' } }, ids);
    total += r.counted;
    last = r.content;
  }
  assert.equal(total, 5);
  assert.match(last, /don't count toward your target/);
  // An agent whose only output is files: every one counts.
  const writer = { ...ctx, runId: 'r_writer', agent: agent() };
  let written = 0;
  for (let i = 0; i < 7; i++) written += (await execute(writer, { id: `w${i}`, name: 'files__write_file', args: { path: `w/n${i}.md`, content: 'x' } }, ids)).counted;
  assert.equal(written, 7);
});

test("a tool that keeps failing isn't hammered: after 3 failures in a run it's refused for the rest of it", async () => {
  registerTools([{ id: 'zzbroken.call', tier: 'T0', description: 'x', schema: { type: 'object' }, impl: () => { throw new Error('404 Not Found'); } }]);
  const ctx = { agent: agent({ tiers: { 'zzbroken.call': 'T0' } }), runId: 'r_storm', level: 0, now: () => Date.now(), fleet: async () => [], wake: () => {} };
  const ids = new Map([['zzbroken__call', 'zzbroken.call']]);
  const outcomes: string[] = [];
  for (let i = 0; i < 5; i++) outcomes.push((await execute(ctx, { id: `s${i}`, name: 'zzbroken__call', args: {} }, ids)).outcome);
  assert.deepEqual(outcomes, ['failed', 'failed', 'failed', 'refused', 'refused']);
});
