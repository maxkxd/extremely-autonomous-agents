import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelChoice } from '../models/choice.js';
import type { Check } from '../models/check.js';
import type { Health } from '../models/health.js';

const NOW = 100 * 3_600_000;
type C = Pick<ModelChoice, 'connection' | 'model'>;
const key = (c: C) => `${c.connection}/${c.model}`;
const mine: ModelChoice[] = [{ connection: 'claude-code', model: 'claude-opus-5-5', effort: 'high' }];
const avail = [
  { connection: 'anthropic', models: ['claude-sonnet-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6'] },
  { connection: 'chatgpt', models: ['gpt-6-luna', 'gpt-5.6-luna'] },
];
// What fillBuiltInModels hands moveTo: the agent's own model is broken, a failed check rules a model out.
const move = async (checks: Record<string, Check>) => {
  const { moveTo } = await import('./helpers.js');
  const works = (c: C) => c.connection !== 'claude-code' && checks[key(c)]?.ok !== false;
  const working = avail.map(a => ({ ...a, models: a.models.filter(model => works({ connection: a.connection, model })) })).filter(a => a.models.length);
  return moveTo(mine, working, works, 'strong', checks, NOW);
};
const fail: Check = { ok: false, reason: 'x', at: NOW };

test('every AI failing at once: models are asked, and the agent is never moved', async () => {
  const checks: Record<string, Check> = {};
  let m = await move(checks);
  assert.equal(m.next, null);
  assert.ok(m.ask.length > 0, 'models nothing has checked are asked first');
  for (let round = 0; m.ask.length && round < 10; round++) {
    for (const c of m.ask) checks[key(c)] = fail;
    m = await move(checks);
    assert.equal(m.next, null);
  }
  assert.deepEqual(m, { next: null, ask: [] });
});

test('moved once another AI has answered, not held up by the rest of a failing one', async () => {
  const checks: Record<string, Check> = {};
  for (const c of (await move(checks)).ask) checks[key(c)] = c.connection === 'chatgpt' ? { ok: true, at: NOW } : fail;
  const m = await move(checks);
  assert.deepEqual(m.next!.map(key), ['chatgpt/gpt-6-luna', 'chatgpt/gpt-5.6-luna', 'claude-code/claude-opus-5-5']);
});

test('waits for an AI that has not been asked yet, even when another has answered', async () => {
  const m = await move({ 'chatgpt/gpt-6-luna': { ok: true, at: NOW }, 'chatgpt/gpt-5.6-luna': { ok: true, at: NOW } });
  assert.equal(m.next, null);
  assert.deepEqual(m.ask.map(key), ['anthropic/claude-sonnet-5']);
});

test('a pass over an hour old is asked again; one with no answer is passed over for a while', async () => {
  const first = await move({ 'chatgpt/gpt-6-luna': { ok: true, at: NOW - 2 * 3_600_000 } });
  assert.equal(first.next, null);
  assert.ok(first.ask.map(key).includes('chatgpt/gpt-6-luna'));
  const second = await move({ 'chatgpt/gpt-6-luna': { ok: true, unsure: true, at: NOW - 60_000 } });
  assert.equal(second.next, null);
  assert.ok(!second.ask.map(key).includes('chatgpt/gpt-6-luna'));
  assert.ok(second.ask.map(key).includes('chatgpt/gpt-5.6-luna'));
});

test('the log says why a model does not work, with keys taken out', async () => {
  const { forLog, whyNot } = await import('./helpers.js');
  const c = { connection: 'anthropic', model: 'claude-opus-5' };
  const none = new Set<string>();
  assert.equal(whyNot(c, [], none, {}, {}), 'not connected');
  assert.equal(whyNot({ ...c, model: 'gone' }, avail, none, {}, {}), "not in the connection's models");
  assert.equal(whyNot(c, avail, new Set(['anthropic']), {}, {}), 'out of allowance');
  assert.equal(whyNot(c, avail, none, { [key(c)]: { ok: false, reason: 'No credit left on this account', at: NOW } }, {}), 'check failed: No credit left on this account');
  const health: Health = { [key(c)]: { failures: 3, benchedUntil: NOW, kind: 'server' } };
  assert.equal(whyNot(c, avail, none, {}, health, 'ENOSPC: no space left\non device'), '3 failures in a row, kind server: ENOSPC: no space left on device');
  assert.equal(forLog('Incorrect API key provided: sk-example-not-a-real-key.'), 'Incorrect API key provided: [key]');
  assert.equal(forLog('a task-runner failed'), 'a task-runner failed');
  assert.equal(forLog('x'.repeat(500)).length, 200);
});
