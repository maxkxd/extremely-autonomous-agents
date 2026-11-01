import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanKey } from './connections.js';

test('a key pasted with what was around it comes out clean', () => {
  const k = 'sk-ant-api03-abcDEF123';
  assert.equal(cleanKey(`  ${k}\n`), k);
  assert.equal(cleanKey(`"${k}"`), k);
  assert.equal(cleanKey(`ANTHROPIC_API_KEY=${k}`), k);
  assert.equal(cleanKey(`export OPENAI_API_KEY="${k}"`), k);
  assert.equal(cleanKey(`Bearer ${k}`), k);
  assert.equal(cleanKey('ABC:def'), 'ABC:def'); // not a NAME= line: left alone
});
