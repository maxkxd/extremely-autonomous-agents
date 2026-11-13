import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fallbacks } from './quick.js';

const keys = (cs: { connection: string; model: string }[]) => cs.map(c => `${c.connection}/${c.model}`);
const avail = [
  { connection: 'google', models: ['gemini-3-pro', 'gemini-3-flash'] },
  { connection: 'claude-code', models: ['opus', 'sonnet', 'haiku'] },
];

test('a helper whose only AI ran out of credit tries the other AIs that work', () => {
  const tried = [{ connection: 'google', model: 'gemini-3-pro' }];
  const out = keys(fallbacks(tried, avail, c => c.connection !== 'google', 'careful'));
  assert.ok(out.length > 0);
  assert.ok(out.every(k => k.startsWith('claude-code/')), out.join(', '));
});

test('fallbacks never repeat a model the helper already tried', () => {
  const tried = [{ connection: 'claude-code', model: 'opus' }];
  const out = keys(fallbacks(tried, avail, () => true, 'careful'));
  assert.ok(!out.includes('claude-code/opus'));
});

test('no other AI works: nothing to fall back to', () => {
  assert.deepEqual(fallbacks([], avail, () => false, 'cheap'), []);
});
