import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanKey, connectKey } from './connections.js';

test('a key pasted with what was around it comes out clean', () => {
  const k = 'sk-ant-api03-abcDEF123';
  assert.equal(cleanKey(`  ${k}\n`), k);
  assert.equal(cleanKey(`"${k}"`), k);
  assert.equal(cleanKey(`ANTHROPIC_API_KEY=${k}`), k);
  assert.equal(cleanKey(`export OPENAI_API_KEY="${k}"`), k);
  assert.equal(cleanKey(`Bearer ${k}`), k);
  assert.equal(cleanKey('ABC:def'), 'ABC:def'); // not a NAME= line: left alone
});

test("another provider's key is turned away before anything is saved", async () => {
  await assert.rejects(connectKey('anthropic', 'sk-proj-abc123'), /OpenAI key, not an Anthropic one - add it under OpenAI/);
  await assert.rejects(connectKey('openai', 'AQ.abc123'), /Google Gemini key/);
});
