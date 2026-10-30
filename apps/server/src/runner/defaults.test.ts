import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickDefaults } from './defaults.js';

const picked = (avail: { connection: string; models: string[] }[], want: Parameters<typeof pickDefaults>[1]) =>
  pickDefaults(avail, want).map(c => `${c.connection}/${c.model}`);

test('built-in defaults: only DeepSeek connected, every built-in still gets a model', () => {
  const avail = [{ connection: 'deepseek', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] }];
  assert.deepEqual(picked(avail, 'strong'), ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash']);
  assert.deepEqual(picked(avail, 'cheap'), ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro']);
  assert.deepEqual(picked(avail, 'careful'), ['deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-flash']);
});

test('defaults: only Claude Code connected, still three - one falls to the next', () => {
  const avail = [{ connection: 'claude-code', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] }];
  assert.deepEqual(picked(avail, 'strong'), ['claude-code/claude-opus-5-5', 'claude-code/claude-sonnet-5-5', 'claude-code/claude-haiku-5-5']);
  assert.deepEqual(picked(avail, 'cheap'), ['claude-code/claude-haiku-5-5', 'claude-code/claude-sonnet-5-5', 'claude-code/claude-opus-5-5']);
  assert.deepEqual(picked(avail, 'careful'), ['claude-code/claude-sonnet-5-5', 'claude-code/claude-opus-5-5', 'claude-code/claude-haiku-5-5']);
});

test("defaults: a builder's one model is kept first and topped up to three", () => {
  const avail = [
    { connection: 'claude-code', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
    { connection: 'openai', models: ['gpt-5.5', 'gpt-5.5-mini'] },
  ];
  const got = pickDefaults(avail, 'strong', [{ connection: 'openai', model: 'gpt-5.5-mini', effort: 'medium' }]);
  assert.deepEqual(got.map(c => `${c.connection}/${c.model}`), ['openai/gpt-5.5-mini', 'claude-code/claude-opus-5-5', 'openai/gpt-5.5']);
  assert.ok(got.every(c => c.effort === 'medium'));
});

test('built-in defaults: plans first, then the job\'s preference, then anything connected, three at most', () => {
  const avail = [
    { connection: 'anthropic', models: ['claude-haiku-5-5', 'claude-sonnet-5-5'] },
    { connection: 'claude-code', models: ['opus', 'sonnet', 'haiku'] },
    { connection: 'mycustom', models: ['house-model'] },
    { connection: 'ollama', models: ['llama4'] },
  ];
  assert.deepEqual(picked(avail, 'strong'), ['claude-code/opus', 'anthropic/claude-sonnet-5-5', 'ollama/llama4']);
  assert.deepEqual(picked(avail, 'cheap'), ['claude-code/haiku', 'ollama/llama4', 'anthropic/claude-haiku-5-5']);
  assert.deepEqual(picked([{ connection: 'mycustom', models: ['house-model'] }], 'careful'), ['mycustom/house-model']);
  assert.deepEqual(picked([], 'strong'), []);
});
