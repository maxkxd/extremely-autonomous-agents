import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteClaudeCodeTooOld } from './connections.js';

// A Claude Code too old for a model: the version it needs, from the run's error.

test('reads the version Claude Code needs from the error', () => {
  const error = "API Error: 400 Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
  assert.equal(noteClaudeCodeTooOld(error), '2.1.280');
  assert.equal(noteClaudeCodeTooOld('Claude Code: rate limited'), null, 'other errors are left alone');
});
