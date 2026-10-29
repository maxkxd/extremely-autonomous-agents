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
import { nextRun } from './scheduler.js';
import { registerTools, WORKSPACES } from './tools.js';

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
  setSetting('agency_stopped', true);
  assert.equal(stateOf(ID).state, 'stopped');
  assert.equal(nextRun(a, stateOf(ID), now), null);
  setSetting('agency_stopped', false);
  assert.equal(nextRun(a, stateOf(ID), now)?.trigger, 'your message');
});

test('a run a restart cut short carries on, told what it already did', async () => {
  exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, at) VALUES ('r_cut', ?, 'files.write_file', '[]', 'T0', 'ok', ?)", ID, Date.now());
  let opening = '';
  const adapter: Adapter = async req => {
    opening ||= req.messages[0].text ?? '';
    return { text: 'Done.', calls: [], usage: { input: 1, output: 1 } };
  };
  await runAgent(agent(), 'run now', null, deps(adapter), undefined, 'r_cut');
  assert.match(opening, /restarted part-way.*files\.write_file \(ok\)/);
});
