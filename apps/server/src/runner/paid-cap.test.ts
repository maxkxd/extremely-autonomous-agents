import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULT_PLAN, type AgentDef } from './agent.js';
import { all, one, resetDbForTests, run as exec, setSetting } from './db.js';
import { eligibleModels, noModelReason, runAgent, stateOf, type RunDeps } from './run.js';
import { paidAllowed, paidSpentToday, PAID_DAILY_CAP } from './pricing.js';
import { paidCapRequest } from './scheduler.js';
import type { Adapter } from './providers.js';

// The organization's pay-per-use AI limit per day (pricing.ts): only runs on
// pay-per-use connections count; reached, model choice skips them.

const ID = 'zz-paid-cap';
const agent = (models: AgentDef['models']): AgentDef => ({
  id: ID,
  name: 'Paid Cap Agent',
  department: 'research',
  owner: null,
  org: null,
  charter: '# CHARTER - Paid Cap Agent\nDo things.',
  models,
  tiers: {},
  approvalHours: {},
  newTools: [],
  events: [],
  newEvents: [],
  output: [],
  maxRunsPerDay: 24,
  ferocity: { ...DEFAULT_PLAN, counts: [] },
  limits: [],
});
const KEY = { connection: 'anthropic', model: 'claude-x', effort: 'medium' as const };
const PLAN = { connection: 'claude-code', model: 'claude-x', effort: 'medium' as const };
const deps = (adapter: Adapter, over: Partial<RunDeps> = {}): RunDeps => ({
  now: () => Date.now(),
  adapter: () => adapter,
  harness: () => null,
  modelInfo: () => ({ usable: true, efforts: [] }),
  cost: async () => 0.01,
  wake: () => {},
  compact: false,
  ...over,
});
const idle: Adapter = async () => ({ text: 'Done.', calls: [], usage: { input: 1, output: 1 } });
let n = 0;
const ran = (connection: string, cost: number, paid: number | null = null, at = Date.now()) =>
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, connection, cost_usd, paid_usd) VALUES (?, 'x', 'scheduled', 0, 'succeeded', ?, ?, ?, ?)", `r_p${n++}`, at, connection, cost, paid);

beforeEach(() => {
  resetDbForTests();
  stateOf(ID);
});

test("only pay-per-use spend counts toward it: plans and local models don't, nor yesterday", () => {
  ran('anthropic', 3);
  ran('claude-code', 10); // a plan, priced as its API would be
  ran('ollama', 0);
  ran('openai', 2, 0.5); // a run that moved between connections: only its paid part
  ran('anthropic', 100, null, Date.now() - 2 * 86_400_000);
  assert.equal(paidSpentToday(Date.now()), 3.5);
});

test('no limit, under it: every model; reached or 0: plans only', () => {
  const a = agent([KEY, PLAN]);
  const d = deps(idle);
  const picks = () => eligibleModels(a, d).map(c => c.connection);
  assert.deepEqual(picks(), ['anthropic', 'claude-code']); // no limit (the default)
  setSetting(PAID_DAILY_CAP, 5);
  ran('anthropic', 3);
  assert.deepEqual(picks(), ['anthropic', 'claude-code']);
  ran('anthropic', 2);
  assert.equal(paidAllowed(Date.now()), false);
  assert.deepEqual(picks(), ['claude-code']);
  // Without the limit, it could: that's what the scheduler tells "waiting on the limit" by.
  assert.deepEqual(eligibleModels(a, d, false).map(c => c.connection), ['anthropic', 'claude-code']);
  setSetting(PAID_DAILY_CAP, 0);
  exec('DELETE FROM runs');
  assert.deepEqual(picks(), ['claude-code'], '0: never pay-per-use');
});

test('an agent with only pay-per-use models waits, and says why', () => {
  const a = agent([KEY]);
  setSetting(PAID_DAILY_CAP, 1);
  ran('anthropic', 1);
  assert.deepEqual(eligibleModels(a, deps(idle)), []);
  assert.match(noModelReason(a, deps(idle)), /Today's \$1\.00 pay-per-use AI limit is reached/);
  setSetting(PAID_DAILY_CAP, 0);
  assert.match(noModelReason(a, deps(idle)), /Pay-per-use AI is off/);
});

test('one request while agents wait on it, closed when the day turns', () => {
  const what = () => all<{ status: string }>("SELECT status FROM requests WHERE what LIKE 'Today''s pay-per-use AI limit%'");
  const now = Date.now();
  paidCapRequest(true, now);
  assert.equal(what().length, 0, 'no limit set: nothing');
  setSetting(PAID_DAILY_CAP, 2);
  ran('anthropic', 2, null, now);
  paidCapRequest(false, now);
  assert.equal(what().length, 0, 'reached, but nobody waits on it: nothing');
  paidCapRequest(true, now);
  paidCapRequest(true, now);
  assert.deepEqual(what().map(r => r.status), ['open'], 'once');
  paidCapRequest(true, now + 86_400_000 + 1);
  assert.deepEqual(what().map(r => r.status), ['done'], 'a new day: closed');
});

test('crossed mid-run: the run moves to its plan for the rest', async () => {
  setSetting(PAID_DAILY_CAP, 0.01);
  const seen: string[] = [];
  let turns = 0;
  const adapter: Adapter = async req => {
    seen.push(req.connection);
    if (++turns < 3) return { text: '', calls: [{ id: `c${turns}`, name: 'tasks__list_my_tasks', args: {} }], usage: { input: 1, output: 1 } };
    return { text: 'Done.', calls: [], usage: { input: 1, output: 1 } };
  };
  const r = await runAgent(agent([KEY, PLAN]), 'run now', null, deps(adapter));
  assert.equal(r.status, 'succeeded', r.error ?? '');
  assert.deepEqual(seen, ['anthropic', 'claude-code', 'claude-code']);
  const row = one<{ paid_usd: number; cost_usd: number }>('SELECT paid_usd, cost_usd FROM runs WHERE id = ?', r.id)!;
  assert.equal(row.paid_usd, 0.01);
  assert.ok(Math.abs(row.cost_usd - 0.03) < 1e-9);
  assert.equal(paidSpentToday(Date.now()), 0.01);
});

test('crossed mid-run with only pay-per-use models: the run ends there, saying why', async () => {
  setSetting(PAID_DAILY_CAP, 0.01);
  let turns = 0;
  const adapter: Adapter = async () => ({ text: '', calls: [{ id: `c${++turns}`, name: 'tasks__list_my_tasks', args: {} }], usage: { input: 1, output: 1 } });
  const r = await runAgent(agent([KEY]), 'run now', null, deps(adapter));
  assert.equal(r.status, 'failed');
  assert.match(r.error ?? '', /pay-per-use AI limit is reached/);
  assert.equal(turns, 1);
});
