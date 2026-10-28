import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanChoices, type ModelChoice } from './choice.js';
import { benchFor, FIRST_BENCH_MS, MAX_BENCH_MS, pickModel, recordFailure, recordSuccess, type Health } from './health.js';

const a: ModelChoice = { connection: 'claude-code', model: 'claude-sonnet-5-5', effort: 'medium' };
const b: ModelChoice = { connection: 'chatgpt', model: 'gpt-6-luna', effort: 'high' };
const c: ModelChoice = { connection: 'openrouter', model: 'x/y', effort: 'low' };
const all = () => true;

test('bench time doubles per failure and caps at an hour', () => {
  assert.equal(benchFor(0), 0);
  assert.equal(benchFor(1), FIRST_BENCH_MS);
  assert.equal(benchFor(2), FIRST_BENCH_MS * 2);
  assert.equal(benchFor(3), FIRST_BENCH_MS * 4);
  assert.equal(benchFor(20), MAX_BENCH_MS);
});

test('uses the first choice when nothing has failed', () => {
  assert.deepEqual(pickModel([a, b, c], {}, all), { choice: a, rank: 0 });
});

test('falls back to 2, then 3, while earlier ones are benched', () => {
  const now = 1_000_000;
  let h: Health = recordFailure({}, a, now);
  assert.equal(pickModel([a, b, c], h, all, now)?.rank, 1);
  h = recordFailure(h, b, now);
  assert.equal(pickModel([a, b, c], h, all, now)?.rank, 2);
});

test('comes back to 1 once its bench time is over', () => {
  const now = 1_000_000;
  const h = recordFailure({}, a, now);
  assert.equal(pickModel([a, b], h, all, now + FIRST_BENCH_MS + 1)?.rank, 0);
});

test('a success clears the bench', () => {
  const now = 1_000_000;
  let h = recordFailure(recordFailure({}, a, now), a, now);
  h = recordSuccess(h, a);
  assert.equal(pickModel([a, b], h, all, now)?.rank, 0);
  assert.equal(benchFor((h['claude-code/claude-sonnet-5-5']?.failures ?? 0) + 1), FIRST_BENCH_MS);
});

test('skips choices whose connection is gone', () => {
  assert.equal(pickModel([a, b], {}, conn => conn !== 'claude-code')?.rank, 1);
  assert.equal(pickModel([a], {}, () => false), null);
});

test('everything benched: tries the one that comes back soonest', () => {
  const now = 1_000_000;
  let h = recordFailure(recordFailure({}, a, now), a, now); // 4 min
  h = recordFailure(h, b, now); // 2 min
  assert.equal(pickModel([a, b], h, all, now)?.rank, 1);
});

test('cleanChoices drops junk and duplicates, keeps at most three', () => {
  const out = cleanChoices([a, a, { connection: '', model: 'm' }, null, b, { ...c, effort: 'bogus' }, { connection: 'z', model: 'z' }]);
  assert.deepEqual(out.map(x => x.model), ['claude-sonnet-5-5', 'gpt-6-luna', 'x/y']);
  assert.equal(out[2].effort, 'medium');
});
