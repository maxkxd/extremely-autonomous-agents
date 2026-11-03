import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { DEFAULT_PLAN, planFrom, realName, type AgentDef } from './agent.js';
import { all, one, resetDbForTests, run as exec, setSetting } from './db.js';
import { APOCALYPTIC, apocalypticWait, APOCALYPTIC_GAP_MS, backoffMs, CHILL, DRIVEN, HOUR, RELENTLESS } from './ferocity.js';
import { compactIfNeeded, isToolFailureNote, memoryForPrompt, remember } from './memory.js';
import { ModelError, type Adapter, type Call } from './providers.js';
import { LOOPING, loopGuard, runAgent, SAME_CALL_LIMIT, stateOf, type RunDeps } from './run.js';
import { book, dropStaleRequestRuns, engineerCanJoin, engineerScope, nextRun } from './scheduler.js';
import { forgetAgentRuns } from './forget.js';
import { decideApproval } from './approvals.js';
import { fleetReport } from './doctor.js';
import { answerRequest, evidenceForPeople } from './api.js';
import { dropGuesses, notWaitingAlready, rate, requestNotWaiting, withdrawProposal } from './engineer.js';
import { actsIn, execute, MAX_WAITING_ON_PERSON, registerTools, requestConnections, serviceLabel, settleJoined, tooManyWaiting, WORKSPACES } from './tools.js';

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

test("Relentless: no target when nothing it's counted by is connected - it isn't pushed into padding", async () => {
  setLevel(RELENTLESS);
  const r = await runAgent(agent({ ferocity: { ...agent().ferocity, counts: ['xero.create_invoice_draft'] } }), 'scheduled', null, deps(fake(2)));
  assert.equal(r.status, 'succeeded');
  assert.equal(r.nudges, 0);
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

test('a save the person turned down leaves the weekly limit for the corrected one', async () => {
  registerTools([{ id: 'zztest.save_week', tier: 'T2', description: 'Save the weekly list', schema: { type: 'object', properties: { path: { type: 'string' } } }, impl: () => 'saved' }]);
  const weekly = agent({ tiers: { 'zztest.save_week': 'T2' }, limits: [{ tool: 'zztest.save_week', max: 1, per_hours: 168, why: 'one list a week' }] });
  const ctx = { agent: weekly, runId: 'r_week', level: 0, now: () => Date.now(), fleet: async () => [], wake: () => {} };
  const ids = new Map([['zztest__save_week', 'zztest.save_week']]);
  const first = await execute(ctx, { id: 'w1', name: 'zztest__save_week', args: { path: '~/Documents/Wrong/list.md' } }, ids);
  assert.equal(first.outcome, 'queued');
  exec("UPDATE approvals SET status = 'rejected' WHERE tool = 'zztest.save_week'");
  const again = await execute(ctx, { id: 'w2', name: 'zztest__save_week', args: { path: 'C:/Right/list.md' } }, ids);
  assert.equal(again.outcome, 'queued'); // not "limited to 1 per 7 days"
  const third = await execute(ctx, { id: 'w3', name: 'zztest__save_week', args: { path: 'C:/Right/other.md' } }, ids);
  assert.equal(third.outcome, 'refused'); // the corrected one does count
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

test("an action waiting for a person carries the agent's reason to the card, never to the tool", async () => {
  setLevel(CHILL);
  let got: Record<string, unknown> | null = null;
  registerTools([
    {
      id: 'zztest.add_lead',
      tier: 'T2',
      description: 'Add a lead',
      schema: { type: 'object', properties: { company: { type: 'string' } }, required: ['company'] },
      impl: args => {
        got = args;
        return 'added';
      },
    },
  ]);
  let offered: unknown = null;
  const model: Adapter = async req => {
    offered ??= req.tools.find(t => t.name === 'zztest__add_lead')?.schema;
    if (req.messages[req.messages.length - 1].role === 'tool') return { text: 'Queued.', calls: [], usage: { input: 1, output: 1 } };
    return { text: '', calls: [{ id: 'l1', name: 'zztest__add_lead', args: { company: 'Acme', why: 'Acme is buying a rival (ACCC, 1 Oct).' } }], usage: { input: 1, output: 1 } };
  };
  await runAgent(agent({ tiers: { 'zztest.add_lead': 'T2' } }), 'scheduled', null, deps(model));
  assert.deepEqual((offered as { required: string[] }).required, ['company', 'why']);
  const a = one<{ id: string; args: string }>("SELECT id, args FROM approvals WHERE tool = 'zztest.add_lead'")!;
  assert.equal(JSON.parse(a.args)._why, 'Acme is buying a rival (ACCC, 1 Oct).');
  await decideApproval(a.id, 'approved', null, () => {}, Date.now(), async () => agent({ tiers: { 'zztest.add_lead': 'T2' } }));
  assert.deepEqual(got, { company: 'Acme' });
});

test('approvals decided together wake the agent once, with all of them', () => {
  exec("DELETE FROM bookings WHERE agent_id = 'zz-coalesce'");
  book('zz-coalesce', 'approval', 'A person APPROVED one.');
  book('zz-coalesce', 'approval', 'A person APPROVED two.');
  const b = all<{ task: string }>("SELECT task FROM bookings WHERE agent_id = 'zz-coalesce'");
  assert.equal(b.length, 1);
  assert.match(b[0].task, /one\.[\s\S]*two\./);
});

test('closing a handed-over task wakes whoever handed it, once for results that come in together', async () => {
  exec("DELETE FROM bookings WHERE agent_id = 'zz-sender'");
  const woken: { agent: string; trigger: string }[] = [];
  const ctx = { agent: agent(), runId: 'r_done', level: 0, now: () => Date.now(), fleet: async () => [], wake: (a: string, t: string, k: string) => (woken.push({ agent: a, trigger: t }), book(a, t as 'task done', k)) };
  const ids = new Map([['tasks__complete_task', 'tasks.complete_task']]);
  for (const n of [1, 2]) {
    const t = exec('INSERT INTO tasks (agent_id, from_agent, task, created_at) VALUES (?, ?, ?, ?)', ID, 'zz-sender', `job ${n}`, Date.now());
    await execute(ctx, { id: `d${n}`, name: 'tasks__complete_task', args: { task_id: Number(t.lastInsertRowid), result: 'done' } }, ids);
  }
  assert.deepEqual(woken.map(w => w.trigger), ['task done', 'task done']);
  assert.equal(all("SELECT id FROM bookings WHERE agent_id = 'zz-sender' AND trigger = 'task done'").length, 1);
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

test('a run making the same failing call hundreds of times in a row is ended; output never is', async () => {
  setLevel(CHILL);
  let turns = 0;
  const stuck: Adapter = async () => {
    turns++;
    return { text: '', calls: [{ id: `s${turns}`, name: 'zztest__other', args: { page: 1 } }], usage: { input: 1, output: 1 } };
  };
  const r = await runAgent(agent(), 'scheduled', null, deps(stuck));
  assert.equal(r.status, 'failed');
  assert.equal(r.error, LOOPING);
  assert.equal(turns, SAME_CALL_LIMIT);
});

test('the loop count only grows on the exact same call with nothing to show; output or a new call resets it', () => {
  const g = loopGuard();
  const same = { name: 'search', args: { q: 'x' } };
  for (let i = 1; i < SAME_CALL_LIMIT; i++) assert.equal(g(same, 0, true), null);
  assert.equal(g(same, 1), null); // the same call producing output: never a loop
  for (let i = 1; i < SAME_CALL_LIMIT; i++) assert.equal(g(same, 0), null);
  assert.equal(g({ name: 'search', args: { q: 'y' } }, 0), null); // a different call starts again
  for (let i = 1; i < SAME_CALL_LIMIT; i++) assert.equal(g(same, 0), null);
  assert.equal(g(same, 0), LOOPING);
  // The same output-producing call any number of times is fine.
  const w = loopGuard();
  for (let i = 0; i < SAME_CALL_LIMIT * 3; i++) assert.equal(w({ name: 'write', args: {} }, 1), null);
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

test('an AI out of its allowance asks the person once, and closes when runs work again', async () => {
  setLevel(CHILL);
  const spent: Adapter = async () => {
    throw new ModelError('You have exceeded your monthly quota (Request ID: X1)', 'rate', 429);
  };
  await runAgent(agent(), 'scheduled', null, deps(spent));
  await runAgent(agent(), 'scheduled', null, deps(spent));
  const asks = all<{ id: number; stage: string; evidence: string }>("SELECT id, stage, evidence FROM requests WHERE what LIKE 'Your AI has run out%' AND status = 'open'");
  assert.equal(asks.length, 1);
  assert.equal(asks[0].stage, 'person');
  assert.doesNotMatch(asks[0].evidence, /Request ID/);
  // It names the connection, so its agents can move off it meanwhile - and a run that
  // worked on another AI doesn't close it.
  const conn = one<{ service: string }>('SELECT service FROM requests WHERE id = ?', asks[0].id)!.service;
  assert.equal(conn, 'b'); // the last one tried
  exec('UPDATE requests SET service = ? WHERE id = ?', 'zz-other-ai', asks[0].id);
  await runAgent(agent(), 'scheduled', null, deps(fake(1)));
  assert.equal(one<{ status: string }>('SELECT status FROM requests WHERE id = ?', asks[0].id)!.status, 'open');
  exec('UPDATE requests SET service = ? WHERE id = ?', conn, asks[0].id);
  await runAgent(agent({ models: [{ connection: 'b', model: 'm2', effort: 'medium' }] }), 'scheduled', null, deps(fake(1)));
  assert.equal(one<{ status: string }>('SELECT status FROM requests WHERE id = ?', asks[0].id)!.status, 'done');
});

test("a key's spending limit is out of allowance, not signed out", async () => {
  setLevel(CHILL);
  exec("UPDATE requests SET status = 'done' WHERE status = 'open'");
  const capped: Adapter = async () => {
    throw new ModelError('Key limit exceeded (monthly limit). $10.26 of $10.00 used; resets 2026-12-01', 'rate', 403);
  };
  await runAgent(agent(), 'scheduled', null, deps(capped));
  const open = all<{ what: string }>("SELECT what FROM requests WHERE status = 'open'");
  assert.equal(open.length, 1);
  assert.match(open[0].what, /run out of its allowance/);
});

test('disconnecting an AI yourself closes what was asked about it', async () => {
  const { aiDisconnected } = await import('./helpers.js');
  exec("UPDATE requests SET status = 'done' WHERE status = 'open'");
  const add = (service: string) =>
    Number(exec("INSERT INTO requests (agent_id, what, why, status, created_at, stage, service) VALUES ('fleet', 'Your AI has run out of its allowance', 'x', 'open', 1, 'person', ?)", service).lastInsertRowid);
  const [mine, other] = [add('zz-gone'), add('zz-kept')];
  aiDisconnected('zz-gone');
  const status = (id: number) => one<{ status: string; answer: string | null }>('SELECT status, answer FROM requests WHERE id = ?', id)!;
  assert.equal(status(mine).status, 'done');
  assert.match(status(mine).answer!, /You disconnected/);
  assert.equal(status(other).status, 'open');
  exec("UPDATE requests SET status = 'done' WHERE status = 'open'");
});

test("a person's reply no AI could answer is booked again; a scheduled run isn't", async () => {
  setLevel(CHILL);
  exec('DELETE FROM bookings');
  const down: Adapter = async () => {
    throw new ModelError('Key limit exceeded (monthly limit)', 'rate', 403);
  };
  await runAgent(agent(), 'scheduled', null, deps(down));
  assert.equal(all('SELECT id FROM bookings').length, 0);
  await runAgent(agent(), 'request reply', 'You replied on request #17: "Wix"', deps(down));
  const again = all<{ trigger: string; task: string; due_at: number }>('SELECT trigger, task, due_at FROM bookings');
  assert.equal(again.length, 1);
  assert.equal(again[0].trigger, 'request reply');
  assert.match(again[0].task, /Wix/);
  assert.ok(again[0].due_at > Date.now()); // after the backoff, not straight away
  exec('DELETE FROM bookings');
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

test('schedule: an agent runs at its level before its tools are connected', () => {
  const now = Date.now();
  // Counted by a Gmail tool it doesn't have: it used to run as Steady until connected.
  const a = agent({ ferocity: { ...DEFAULT_PLAN, counts: ['gmail.send_email'], floor: 10, soft_floor: 3, apocalyptic_floor: 30 } });
  setLevel(RELENTLESS);
  exec('UPDATE agent_state SET last_scheduled_at = ? WHERE agent_id = ?', now - 7 * HOUR, ID); // Relentless: every 6 h
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'scheduled');
  setLevel(APOCALYPTIC);
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'apocalyptic');
});

test('schedule: Apocalyptic waits longer after each short run, to Relentless pace after about 20', () => {
  const now = Date.now();
  const a = agent();
  const relentless = a.ferocity.every_hours[RELENTLESS] * HOUR;
  assert.equal(apocalypticWait(a, 0), APOCALYPTIC_GAP_MS);
  assert.ok(apocalypticWait(a, 1) > APOCALYPTIC_GAP_MS && apocalypticWait(a, 10) < relentless);
  assert.equal(Math.round(apocalypticWait(a, 20)), relentless);
  assert.equal(apocalypticWait(a, 25), relentless);
  setLevel(APOCALYPTIC);
  // Six short runs in a row (5 of a 30 target), the last ending a minute ago.
  for (let i = 0; i < 6; i++)
    exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, ended_at, acts, floor) VALUES (?, ?, 'apocalyptic', 4, 'succeeded', ?, ?, 5, 30)", `s${i}`, ID, now - (i + 2) * 60_000, now - (i + 1) * 60_000);
  const wait = apocalypticWait(a, 6);
  assert.ok(wait > 60_000);
  assert.equal(nextRun(a, stateOf(ID), now), null);
  assert.equal(nextRun(a, stateOf(ID), now - 60_000 + wait + 1)?.trigger, 'apocalyptic');
  // One that reaches its target: back to back again.
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, ended_at, acts, floor) VALUES ('hit', ?, 'apocalyptic', 4, 'succeeded', ?, ?, 40, 30)", ID, now - 50_000, now - 30_000);
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'apocalyptic');
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
  for (let i = 0; i < 1000; i++) exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at) VALUES (?, ?, 'scheduled', 0, 'succeeded', ?)", `r${i}`, ID, now - i);
  assert.equal(nextRun(a, stateOf(ID), now), null); // past the backstop for today (1,000 up to Driven)
  setLevel(RELENTLESS);
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'scheduled'); // none at Relentless and Apocalyptic
  setLevel(CHILL);
  // ...but a person's Run now isn't held back by either.
  exec('UPDATE agent_state SET backoff_until = ? WHERE agent_id = ?', now + 60_000, ID);
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, 'run now', NULL, ?, ?)", ID, now, now);
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'run now');
  exec("UPDATE agent_state SET state = 'stopped' WHERE agent_id = ?", ID);
  assert.equal(nextRun(a, stateOf(ID), now), null); // stopped is still stopped
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
  // Named differently since (how the label reads changed): still the same ask, by its service.
  exec("UPDATE requests SET what = 'Connect analytics (PostHog, GA)' WHERE service = 'crm'");
  assert.deepEqual(requestConnections(ID, 'Test Agent', tiers, now + 1, () => {}), []);
  // Its agent deleted: withdrawn, and the same agent added back asks again straight away.
  exec("UPDATE requests SET status = 'withdrawn', answered_at = ? WHERE status = 'open'", now + 1);
  assert.deepEqual(requestConnections(ID, 'Test Agent', tiers, now + 2, () => {}).sort(), ['Connect a CRM (HubSpot, Zoho, Salesforce)', 'Connect email (Gmail or Outlook)']);
  connected = true;
  requestConnections(ID, 'Test Agent', tiers, now + 3, () => {});
  assert.deepEqual(all<{ status: string }>("SELECT status FROM requests WHERE status = 'open'"), []); // closed once connected
});

test('one request per connection: a second agent needing it joins the first, with its own reason, and is settled with it', () => {
  const now = Date.now();
  registerTools([{ id: 'gmail.list_messages', tier: 'T0', description: 'Search', schema: {}, impl: () => '', ready: () => false }]);
  const woke: string[] = [];
  const wake = (a: string, _t: string, task: string) => woke.push(`${a}: ${task}`);
  requestConnections('parts-pull', 'Parts Pull List', { 'gmail.list_messages': 'T0' }, now, wake);
  requestConnections('overstays', 'Workshop Overstays', { 'gmail.list_messages': 'T0' }, now, wake);
  requestConnections('overstays', 'Workshop Overstays', { 'gmail.list_messages': 'T0' }, now + 1, wake); // not again while joined
  const rows = all<{ id: number; agent_id: string; stage: string; joined_to: number | null }>('SELECT id, agent_id, stage, joined_to FROM requests ORDER BY id');
  assert.deepEqual(
    rows.map(r => [r.agent_id, r.stage, r.joined_to]),
    [
      ['parts-pull', 'engineer', null],
      ['overstays', 'joined', rows[0].id],
    ],
  );
  assert.equal(woke.length, 1, 'only the first goes to the Agency Engineer');
  // Settled: every agent waiting on it is answered and woken.
  exec("UPDATE requests SET status = 'done', answer = 'Gmail is connected.' WHERE id = ?", rows[0].id);
  woke.length = 0;
  assert.deepEqual(settleJoined(wake, now + 2), [rows[1].id]);
  assert.equal(one<{ status: string; answer: string }>('SELECT status, answer FROM requests WHERE id = ?', rows[1].id)?.answer, 'Gmail is connected.');
  assert.deepEqual(woke, [`overstays: Request #${rows[1].id} is answered: Gmail is connected.`]);
});

test("one request per connection: turned down for the first agent, the next carries it on", () => {
  const add = (agentId: string, joined: number | null = null) =>
    Number(exec("INSERT INTO requests (agent_id, what, why, status, created_at, stage, service, joined_to) VALUES (?, 'Set up Square', 'x', 'open', 1, ?, 'square', ?)", agentId, joined ? 'joined' : 'engineer', joined).lastInsertRowid);
  const lead = add('parts-pull');
  const [b, c] = [add('overstays', lead), add('bike-fit', lead)];
  exec("UPDATE requests SET status = 'rejected' WHERE id = ?", lead);
  const woke: string[] = [];
  settleJoined(a => woke.push(a));
  const row = (id: number) => one<{ status: string; stage: string; joined_to: number | null }>('SELECT status, stage, joined_to FROM requests WHERE id = ?', id);
  assert.deepEqual({ ...row(b) }, { status: 'open', stage: 'engineer', joined_to: null });
  assert.deepEqual({ ...row(c) }, { status: 'open', stage: 'joined', joined_to: b });
  assert.deepEqual(woke, ['fleet']);
});

test("a request shows people its reasons, not the tool ids for the Agency Engineer", () => {
  assert.equal(
    evidenceForPeople('Tools: square.list_bookings, square.search_inventory\nEvents: square.new_booking\nsquare.list_bookings expects: {"type":"object"}\nAlso used by Parts Pull List.'),
    'Also used by Parts Pull List.',
  );
  assert.equal(evidenceForPeople('Tools: square.list_bookings'), null);
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
  await writeFile(join(DATA, 'zz-books', 'CHARTER.md'), '# Revenue Ops\nReconcile Stripe against Xero and draft invoices in Xero. Check usage in PostHog against the legal plan.');
  assert.equal(serviceLabel('xero', 'zz-books'), 'Xero'); // not "accounting (Xero, QuickBooks)"
  assert.equal(serviceLabel('crm', 'zz-books'), 'a CRM (HubSpot, Zoho, Salesforce)'); // names none: the examples stay
  assert.equal(serviceLabel('xero'), 'accounting (Xero, QuickBooks)');
  assert.equal(serviceLabel('analytics', 'zz-books'), 'PostHog'); // "GA" isn't in "against" or "legal"
  assert.equal(serviceLabel('seo'), 'SEO'); // a made-up server: an acronym, not "Seo"
  assert.equal(serviceLabel('war_app'), 'War App'); // not "WAR APP"
  assert.equal(serviceLabel('search_console'), 'Google Search Console');
});

test("a sign-in MCP server going live replaces the builder's names for it: its guesses and the catalogue's stand-in", async () => {
  const { DATA } = await import('../files.js');
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const { parse } = await import('yaml');
  const dir = join(DATA, 'zz-triage');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'TOOLS.yaml'),
    'tools_allowed: [files.read_file, sentry.list_issues, sentry.get_issue, sentry.search_issues, analytics.query, web.browse]\ntool_tiers: { files.read_file: T0, sentry.list_issues: T0, sentry.get_issue: T0, sentry.search_issues: T0, analytics.query: T0, web.browse: T1 }\nnew_tools:\n  - id: sentry.list_issues\n  - id: sentry.get_issue\n  - id: sentry.search_issues\n  - id: linear.list_issues\n',
  );
  const real = (id: string) => ['sentry.search_issues', 'sentry.find_projects'].includes(id);
  // A request filed for the catalogue's analytics.query, answered by an MCP server: the stand-in goes too.
  assert.deepEqual(await dropGuesses('zz-triage', ['sentry', 'analytics'], real), ['sentry.list_issues', 'sentry.get_issue', 'analytics.query']);
  const doc = parse(await readFile(join(dir, 'TOOLS.yaml'), 'utf8'));
  assert.deepEqual(doc.tools_allowed, ['files.read_file', 'sentry.search_issues', 'web.browse']);
  assert.deepEqual(Object.keys(doc.tool_tiers), ['files.read_file', 'sentry.search_issues', 'web.browse']);
  assert.deepEqual(doc.new_tools.map((t: { id: string }) => t.id), ['sentry.search_issues', 'linear.list_issues']); // another service's stay
  assert.deepEqual(await dropGuesses('zz-triage', ['sentry', 'web'], id => real(id) || id === 'web.browse'), []); // what something serves stays
  await rm(dir, { recursive: true, force: true });
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
  // ...and the Agency Engineer is asked to fix it, once.
  const fix = all<{ what: string; stage: string; evidence: string }>("SELECT what, stage, evidence FROM requests WHERE what LIKE 'Fix the tool zzbroken.call%'");
  assert.equal(fix.length, 1);
  assert.equal(fix[0].stage, 'engineer');
  assert.match(fix[0].evidence, /404 Not Found/);
});

test("a tool that works for other inputs isn't reported broken: a wrong path's 404 is the caller's", async () => {
  registerTools([{ id: 'zzpath.read', tier: 'T0', description: 'x', schema: { type: 'object' }, impl: async a => { if (a.path !== 'ok') throw new Error('Not found'); return 'fine'; } }]);
  const ctx = { agent: agent({ tiers: { 'zzpath.read': 'T0' } }), runId: 'r_paths', level: 0, now: () => Date.now(), fleet: async () => [], wake: () => {} };
  const ids = new Map([['zzpath__read', 'zzpath.read']]);
  for (const path of ['nope', 'ok', 'nope', 'ok', 'nope']) await execute({ ...ctx, runId: `r_paths_${path}_${Math.random()}` }, { id: path, name: 'zzpath__read', args: { path } }, ids);
  assert.equal(all("SELECT 1 FROM requests WHERE what LIKE 'Fix the tool zzpath.read%'").length, 0);
});

test('a target counts real outcomes only; a plan that counted only files counts its KPI, at a quarter of the numbers', () => {
  const kpi = ['crm.create_lead', 'crm.add_lead_note'];
  const filesOnly = planFrom({ counts: ['files.write_file'], floor: 40, soft_floor: 12, apocalyptic_floor: 120 }, kpi);
  assert.deepEqual(filesOnly.counts, kpi);
  assert.deepEqual([filesOnly.soft_floor, filesOnly.floor, filesOnly.apocalyptic_floor], [3, 10, 30]);
  const mixed = planFrom({ counts: ['crm.create_lead', 'files.write_file', 'gmail.send_to_me', 'memory.remember'], floor: 6 }, kpi);
  assert.deepEqual(mixed.counts, ['crm.create_lead']);
  assert.equal(mixed.floor, 6);
  assert.deepEqual(planFrom({ counts: ['files.write_file'] }, ['files.write_file']).counts, []); // nothing real: no target
});

test('a new agent in setup is ready once every connector is connected, and waits to be started', async () => {
  const { setups } = await import('./setup.js');
  exec("INSERT INTO agent_state (agent_id, state, setup, updated_at) VALUES ('zz-setup', 'stopped', 1, 0)");
  const crm = Number(exec("INSERT INTO requests (agent_id, what, why, created_at, stage, setup, service, stars) VALUES ('zz-setup', 'Connect a CRM', 'x', 0, 'waiting_you', 1, 'crm', 5)").lastInsertRowid);
  exec("INSERT INTO requests (agent_id, what, why, status, created_at, setup, service) VALUES ('zz-setup', 'Connect GitHub', 'x', 'done', 0, 1, 'github')");
  const s = (await setups())['zz-setup'];
  assert.deepEqual(s.items.map(i => [i.name, i.stars, i.connected]), [['CRM', 5, false], ['Code repository', 0, true]]); // unrated: no stars yet
  assert.equal(s.progress, 3 / 8); // weighted as 3 until rated
  assert.equal(s.ready, false); // the CRM isn't connected yet
  exec("UPDATE requests SET status = 'done' WHERE id = ?", crm);
  assert.equal((await setups())['zz-setup'].ready, true);
  // Ready, but it doesn't start by itself.
  assert.deepEqual({ ...one<{ state: string; setup: number | null }>('SELECT state, setup FROM agent_state WHERE agent_id = ?', 'zz-setup') }, { state: 'stopped', setup: 1 });
});

test('a setup connector is rated 1-5 before it goes to the person, whichever way it goes', () => {
  const id = Number(exec("INSERT INTO requests (agent_id, what, why, created_at, stage, setup) VALUES ('zz-rate', 'Set up Gmail', 'x', 0, 'engineer', 1)").lastInsertRowid);
  const row = () => one<Parameters<typeof rate>[0]>('SELECT * FROM requests WHERE id = ?', id)!;
  assert.throws(() => rate(row(), undefined), /isn't rated yet/);
  rate(row(), 9);
  assert.equal(row().stars, 5);
  rate(row(), undefined); // rated already: nothing more needed
  const plain = Number(exec("INSERT INTO requests (agent_id, what, why, created_at, stage) VALUES ('zz-rate', 'Fix the CRM tool', 'x', 0, 'engineer')").lastInsertRowid);
  rate(one<Parameters<typeof rate>[0]>('SELECT * FROM requests WHERE id = ?', plain)!, undefined); // not setup: no stars needed
});

test('the Agency Engineer works a few requests at once, never two on the same one or the same service', () => {
  const ins = (service: string) => Number(exec("INSERT INTO requests (agent_id, what, why, created_at, stage, service) VALUES ('zz-par', 'Set up x', 'x', 0, 'engineer', ?)", service).lastInsertRowid);
  const [desk1, desk2, crm] = [ins('helpdesk'), ins('helpdesk'), ins('crm')];
  const task = (id: number) => `Request #${id} from zz-par: Set up x`;
  assert.deepEqual(engineerScope(task(desk1)), { requests: [desk1], services: ['helpdesk'] });
  assert.deepEqual(engineerScope('A person APPROVED your queued engineer.publish_integration (integration_id: x; request_id: 7').requests, [7]);
  const going = [engineerScope(task(desk1))];
  assert.equal(engineerCanJoin(going, { trigger: 'request', task: task(crm) }), true);
  assert.equal(engineerCanJoin(going, { trigger: 'request', task: task(desk2) }), false); // same service: it'd draft Zoho Desk twice
  assert.equal(engineerCanJoin(going, { trigger: 'request reply', task: task(desk1) }), false); // same request
  assert.equal(engineerCanJoin(going, { trigger: 'scheduled', task: null }), false); // names no request: runs alone
  assert.equal(engineerCanJoin(going, { trigger: 'your message', task: 'hi' }), true); // a person never waits
  assert.equal(engineerCanJoin([engineerScope(null)], { trigger: 'request', task: task(crm) }), false); // nothing beside one that runs alone
});

test('a batch counts per record, not per word: labels, tags and recipients are one act', () => {
  assert.equal(actsIn({ title: 'Bug', labels: ['bug', 'billing', 'p1', 'auth', 'ui', 'api'] }), 1);
  assert.equal(actsIn({ rows: [['a', 1], ['b', 2], ['c', 3]] }), 3);
  assert.equal(actsIn({ leads: [{ company: 'A' }, { company: 'B' }] }), 2);
  assert.equal(actsIn({ to: ['a@x.com', 'b@x.com'], body: 'hi' }), 1);
});

test("a service's limit reached pauses its tools for every agent: not a failure, not a broken tool", async () => {
  let calls = 0;
  registerTools([
    { id: 'zzlimit.search', tier: 'T0', description: 'x', schema: { type: 'object' }, impl: async () => { calls++; throw new Error('Zoho CRM answered 429: Many requests fired than the allowed limit for the past 24 hours.'); } },
    { id: 'zzlimit.read', tier: 'T0', description: 'x', schema: { type: 'object' }, impl: async () => { calls++; return 'ok'; } },
  ]);
  const now = Date.now();
  const ctx = (a: string) => ({ agent: agent({ id: a, tiers: { 'zzlimit.search': 'T0', 'zzlimit.read': 'T0' } }), runId: `r_lim_${a}`, level: 0, now: () => now, fleet: async () => [], wake: () => {} });
  const ids = new Map([['zzlimit__search', 'zzlimit.search'], ['zzlimit__read', 'zzlimit.read']]);
  const first = await execute(ctx('zz-a'), { id: '1', name: 'zzlimit__search', args: {} }, ids);
  assert.equal(first.outcome, 'refused');
  assert.match(first.content, /paused for every agent/);
  // Another agent, another of its tools: not called at all.
  const other = await execute(ctx('zz-b'), { id: '2', name: 'zzlimit__read', args: {} }, ids);
  assert.equal(other.outcome, 'refused');
  assert.equal(calls, 1);
  assert.equal(all("SELECT 1 FROM requests WHERE what LIKE 'Fix the tool zzlimit%'").length, 0);
  assert.equal(all("SELECT 1 FROM tool_health WHERE tool LIKE 'zzlimit%' AND last_fail IS NOT NULL").length, 0);
});

test("a web tool's limit pauses only that tool: search out for the hour still reads pages", async () => {
  registerTools([
    { id: 'web.zz_search', tier: 'T0', description: 'x', schema: { type: 'object' }, impl: async () => { throw new Error('Tavily answered 429: its free no-key limit (shared, per hour) is used up for now.'); } },
    { id: 'web.zz_read', tier: 'T0', description: 'x', schema: { type: 'object' }, impl: async () => 'the page' },
  ]);
  const now = Date.now();
  const ctx = { agent: agent({ id: 'zz-web', tiers: { 'web.zz_search': 'T0', 'web.zz_read': 'T0' } }), runId: 'r_lim_web', level: 0, now: () => now, fleet: async () => [], wake: () => {} };
  const ids = new Map([['web__zz_search', 'web.zz_search'], ['web__zz_read', 'web.zz_read']]);
  assert.equal((await execute(ctx, { id: '1', name: 'web__zz_search', args: {} }, ids)).outcome, 'refused');
  const read = await execute(ctx, { id: '2', name: 'web__zz_read', args: {} }, ids);
  assert.equal(read.outcome, 'ok');
  assert.equal(read.content, 'the page');
});

test("with no AI connected, the person is told nothing can run - once, and it closes when one is connected", async () => {
  const { noAiRequest } = await import('./scheduler.js');
  const open = () => all<{ id: number }>("SELECT id FROM requests WHERE what LIKE 'Connect an AI model%' AND status = 'open'");
  exec("INSERT INTO agent_state (agent_id, state, updated_at) VALUES ('zz-noai', 'stopped', 0) ON CONFLICT(agent_id) DO NOTHING");
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES ('zz-noai', 'run now', NULL, 0, 0)");
  noAiRequest(false, Date.now());
  noAiRequest(false, Date.now());
  assert.equal(open().length, 1);
  // A Run now that can't start isn't left "Queued".
  assert.equal(all("SELECT id FROM bookings WHERE agent_id = 'zz-noai' AND trigger = 'run now'").length, 0);
  noAiRequest(true, Date.now());
  assert.equal(open().length, 0);
});

test("a new agent whose every connector was turned down isn't ready", async () => {
  const { setups } = await import('./setup.js');
  exec("INSERT INTO agent_state (agent_id, state, setup, updated_at) VALUES ('zz-refused', 'stopped', 1, 0)");
  exec("INSERT INTO requests (agent_id, what, why, status, created_at, setup, service) VALUES ('zz-refused', 'Set up a CRM', 'x', 'rejected', 0, 1, 'crm')");
  assert.equal((await setups())['zz-refused']?.ready ?? false, false);
  assert.equal(one<{ state: string }>("SELECT state FROM agent_state WHERE agent_id = 'zz-refused'")?.state, 'stopped');
});

test("a spending limit that stops everything is said once; a plan connected (or the limit raised) closes it", async () => {
  const { capRequest } = await import('./scheduler.js');
  const { setSetting } = await import('./db.js');
  const open = () => all("SELECT 1 FROM requests WHERE what LIKE 'This month''s AI spending limit%' AND status = 'open'");
  setSetting('spend_cap_org_usd', 0);
  capRequest(['mistral'], Date.now());
  capRequest(['mistral'], Date.now());
  assert.equal(open().length, 1);
  capRequest(['mistral', 'claude-code'], Date.now()); // a plan: agents still run on it
  assert.equal(open().length, 0);
  setSetting('spend_cap_org_usd', null);
});

test("the tunnel's address changing (a restart) tells the person which services to give the new one, once", async () => {
  const { hookAddressRequest } = await import('./scheduler.js');
  const reqs = () => all<{ why: string; status: string }>("SELECT why, status FROM requests WHERE what LIKE 'The address for your webhooks changed%' ORDER BY id");
  const hooks = [{ service: 'Stripe', id: 'stripe.payment_failed' }];
  hookAddressRequest('https://first-one.trycloudflare.com', hooks, Date.now()); // the first address: nothing to replace
  hookAddressRequest('https://first-one.trycloudflare.com', hooks, Date.now());
  assert.equal(reqs().length, 0);
  hookAddressRequest('https://second-one.trycloudflare.com', hooks, Date.now());
  hookAddressRequest('https://second-one.trycloudflare.com', hooks, Date.now());
  assert.equal(reqs().length, 1);
  assert.match(reqs()[0].why, /Stripe: https:\/\/second-one\.trycloudflare\.com\/hooks\//);
  hookAddressRequest('https://third-one.trycloudflare.com', hooks, Date.now()); // again before it was done: the newer one stands
  assert.deepEqual(reqs().map(r => r.status), ['done', 'open']);
  hookAddressRequest('http://127.0.0.1:5176', hooks, Date.now()); // the tunnel turned off: nothing to paste
  assert.equal(reqs().filter(r => r.status === 'open').length, 0);
});

test("'You' (no name given yet) isn't written about as a name", () => {
  assert.equal(realName('You'), null);
  assert.equal(realName(' you '), null);
  assert.equal(realName(''), null);
  assert.equal(realName('Max'), 'Max');
});

test('an agent with a pile of requests waiting on the person files no more until some are answered', () => {
  exec("DELETE FROM requests WHERE agent_id = 'zz-asker'");
  const add = (stage: string) => exec("INSERT INTO requests (agent_id, what, why, status, created_at, stage) VALUES ('zz-asker', 'q', 'x', 'open', 1, ?)", stage);
  for (let i = 0; i < MAX_WAITING_ON_PERSON - 1; i++) add(i % 2 ? 'person' : 'waiting_you');
  add('engineer'); // not in front of the person yet: doesn't count
  assert.equal(tooManyWaiting('zz-asker'), null);
  add('person');
  assert.match(tooManyWaiting('zz-asker') ?? '', /Not filed: 5 of your requests are already waiting on the person/);
  exec("DELETE FROM requests WHERE agent_id = 'zz-asker'");
});

test('a task handed over arrives whole, or is refused with why - never cut short in silence', async () => {
  const fleet = async () => [{ id: 'zz-other', name: 'Other' }] as never;
  const ctx = { agent: agent(), runId: 'r_handoff', level: 0, now: () => Date.now(), fleet, wake: () => {} };
  const ids = new Map([['tasks__delegate_task', 'tasks.delegate_task']]);
  const long = 'suburb, '.repeat(1500); // 12,000 characters: cut at 4,000 before
  const ok = await execute(ctx, { id: 'h1', name: 'tasks__delegate_task', args: { agent_id: 'zz-other', task: long } }, ids);
  assert.match(ok.content, /Handed to Other/);
  assert.equal(one<{ task: string }>("SELECT task FROM tasks WHERE agent_id = 'zz-other' ORDER BY id DESC LIMIT 1")!.task.length, long.length);
  const huge = await execute(ctx, { id: 'h2', name: 'tasks__delegate_task', args: { agent_id: 'zz-other', task: 'x'.repeat(40_000) } }, ids);
  assert.match(huge.content, /Too long \(40,000 characters; up to 30,000\): split the task/);
});
