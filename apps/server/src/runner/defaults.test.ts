import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pickDefaults } from './defaults.js';

const picked = (avail: { connection: string; models: string[] }[], want: Parameters<typeof pickDefaults>[1]) =>
  pickDefaults(avail, want).map(c => `${c.connection}/${c.model}`);

test('built-in defaults: only DeepSeek connected, every built-in still gets a model', () => {
  const avail = [{ connection: 'deepseek', models: ['deepseek-v4-pro', 'deepseek-v4-flash'] }];
  assert.deepEqual(picked(avail, 'strong'), ['deepseek/deepseek-v4-pro']);
  assert.deepEqual(picked(avail, 'cheap'), ['deepseek/deepseek-v4-flash']);
  assert.deepEqual(picked(avail, 'careful'), ['deepseek/deepseek-v4-pro']);
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
