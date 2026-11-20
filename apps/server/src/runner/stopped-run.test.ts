import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { DEFAULT_PLAN, type AgentDef } from './agent.js';
import { all, one, resetDbForTests, run as exec, setSetting } from './db.js';
import { ModelError, type Adapter } from './providers.js';
import { runAgent, stateOf, type RunDeps, type Trigger } from './run.js';
import { nextRun } from './scheduler.js';
import { WORKSPACES } from './tools.js';

// A person stops an agent (or the whole agency) part-way through a run that was
// carrying news - a rejection, a lost page, a request answered. The news isn't lost:
// the run's message waits for it to be turned back on, and what it was shown counts
// as not yet told.

const ID = 'zz-stopped-run-test';
const agent: AgentDef = {
  id: ID,
  name: 'Stopped Run Test',
  department: 'research',
  owner: null,
  org: null,
  charter: '# CHARTER\nWrite ideas.',
  models: [{ connection: 'a', model: 'm1', effort: 'medium' }],
  tiers: {},
  approvalHours: {},
  newTools: [],
  events: [],
  newEvents: [],
  output: [{ action: 'zz.made_thing', label: 'things made', amount: 1 }], // a goal: an agent with none does not run
  maxRunsPerDay: 24,
  ferocity: { ...DEFAULT_PLAN, counts: [] },
  limits: [],
};
const deps = (adapter: Adapter): RunDeps => ({
  now: () => Date.now(),
  adapter: () => adapter,
  harness: () => null,
  modelInfo: () => ({ usable: true, efforts: [] }),
  cost: async () => 0.001,
  wake: () => {},
  compact: false,
});

// The model's first call: the person presses Stop (the agent, or everything) while it runs.
async function stoppedRun(trigger: Trigger, task: string | null, stop: () => void = () => exec("UPDATE agent_state SET state = 'stopped' WHERE agent_id = ?", ID)) {
  const controller = new AbortController();
  const adapter: Adapter = async () => {
    stop();
    controller.abort();
    throw new ModelError('aborted', 'network');
  };
  return runAgent(agent, trigger, task, deps(adapter), controller.signal);
}

const REJECTED = 'A person REJECTED your queued mail.send (apv_1). It did not happen.';
const bookings = () => all<{ trigger: string; task: string | null; resume_from: string | null }>('SELECT trigger, task, resume_from FROM bookings WHERE agent_id = ?', ID);

beforeEach(() => {
  resetDbForTests();
  stateOf(ID);
});
after(async () => {
  setSetting('agency_state', 'active');
  await rm(join(WORKSPACES, ID), { recursive: true, force: true });
});

test('a rejection being told when the agent is stopped waits for it, and runs when it is back on', async () => {
  const r = await stoppedRun('approval', REJECTED);
  assert.equal(r.status, 'stopped');
  const b = bookings();
  assert.equal(b.length, 1);
  assert.equal(b[0].trigger, 'approval');
  assert.equal(b[0].task, REJECTED);
  assert.equal(b[0].resume_from, r.id, 'told what the cut run already did');
  assert.equal(nextRun(agent, stateOf(ID), Date.now()), null, 'nothing runs while it is stopped');
  exec("UPDATE agent_state SET state = 'active' WHERE agent_id = ?", ID);
  const next = nextRun(agent, stateOf(ID), Date.now() + 1);
  assert.equal(next?.trigger, 'approval');
  assert.equal(next?.task, REJECTED);
});

test('news shown to a run that was stopped counts as not yet told', async () => {
  const now = Date.now();
  exec("INSERT INTO requests (agent_id, what, why, status, answer, created_at, answered_at) VALUES (?, 'A key for X', 'needed', 'rejected', 'No', ?, ?)", ID, now, now);
  exec("INSERT INTO requests (agent_id, what, why, status, answer, created_at, answered_at) VALUES (?, 'Sign in to Y', 'needed', 'done', 'Done', ?, ?)", ID, now, now);
  await stoppedRun('request done', 'Your request #1 was answered.');
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM requests WHERE agent_id = ? AND delivered_at IS NULL', ID)!.n, 2);
});

test('the same when the whole agency is stopped', async () => {
  await stoppedRun('request done', 'Your request #7 was closed by the agency.', () => setSetting('agency_state', 'stopped'));
  setSetting('agency_state', 'active');
  assert.equal(bookings().length, 1);
});

test('a scheduled run, or a Run now, stopped part-way is not booked again', async () => {
  await stoppedRun('scheduled', null);
  await stoppedRun('run now', null);
  assert.equal(bookings().length, 0);
});

test('a run cut short without the agent being stopped (it was deleted) leaves nothing behind', async () => {
  const now = Date.now();
  exec("INSERT INTO requests (agent_id, what, why, status, answer, created_at, answered_at) VALUES (?, 'A key for X', 'needed', 'done', 'Here', ?, ?)", ID, now, now);
  await stoppedRun('approval', REJECTED, () => {});
  assert.equal(bookings().length, 0);
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM requests WHERE agent_id = ? AND delivered_at IS NULL', ID)!.n, 0);
});

test('a run that finishes normally marks its news told and books nothing', async () => {
  const now = Date.now();
  exec("INSERT INTO requests (agent_id, what, why, status, answer, created_at, answered_at) VALUES (?, 'A key for X', 'needed', 'done', 'Here', ?, ?)", ID, now, now);
  const r = await runAgent(agent, 'approval', REJECTED, deps(async () => ({ text: 'Noted.', calls: [], usage: { input: 1, output: 1 } })));
  assert.equal(r.status, 'succeeded');
  assert.equal(bookings().length, 0);
  assert.equal(one<{ n: number }>('SELECT COUNT(*) AS n FROM requests WHERE agent_id = ? AND delivered_at IS NULL', ID)!.n, 0);
});
