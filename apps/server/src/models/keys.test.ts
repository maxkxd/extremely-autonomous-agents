import '../test-data-dir.js';
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

test('a key copied from a web page loses its zero-width characters', async () => {
  const { cleanKey, dropInvisible } = await import('./connections.js');
  assert.equal(cleanKey('\u200bsk-test-\u200d123\ufeff'), 'sk-test-123');
  assert.equal(dropInvisible('acme\u2060-team'), 'acme-team');
  // Unchanged: what's left goes into a request header without failing.
  assert.doesNotThrow(() => new Headers({ 'x-api-key': cleanKey('abc\u200bdef') }));
});
