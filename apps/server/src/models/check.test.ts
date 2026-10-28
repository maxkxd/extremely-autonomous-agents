import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, levelsFromError } from './check.js';

// Real error messages each provider returned on 2026-10-28.
const reason = (status: number, message: string, headers?: Record<string, string>) => classify({ status, message, headers: headers && new Headers(headers) });

test('reads why a model is out, in plain words', () => {
  assert.equal(reason(404, 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code').reason, 'No longer available');
  assert.equal(reason(404, 'The model `gpt-3.5-turbo-16k` does not exist or you do not have access to it.').reason, 'No longer available');
  assert.equal(reason(400, 'Function calling is not enabled for models/antigravity-preview-latest').reason, "Can't use tools");
  assert.equal(reason(400, '`tool calling` is not supported with this model').reason, "Can't use tools");
  assert.equal(reason(400, '"Multi Agent requests are not allowed on chat completions"').reason, "Can't run agents");
  assert.equal(reason(400, "The requested model 'gpt-5-search-api' is not supported with the Responses API.").reason, "Can't run agents");
  assert.equal(reason(400, 'The model `canopylabs/orpheus-v1-english` requires terms acceptance. Please have the org admin accept the terms').reason, "Needs the provider's terms accepted first");
  assert.equal(reason(400, 'Model labs-leanstral-1-5 is a Labs model. To use Labs models, an admin must enable them').reason, 'Not enabled for this account');
  assert.equal(reason(402, 'Insufficient Balance').reason, 'No credit left on this account');
  assert.equal(reason(401, 'Invalid API key').reason, "The key wasn't accepted");
});

test('a plan with no allowance is flagged; a busy provider is not', () => {
  const gemini = 'You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro';
  assert.deepEqual(reason(429, gemini), { reason: 'Not available on your plan' });
  assert.deepEqual(reason(429, 'Rate limit exceeded', { 'x-ratelimit-limit-req-minute': '0' }), { reason: 'Not available on your plan' });
  assert.equal(reason(429, 'You exceeded your current quota, please check your plan and billing details. limit: 15').unsure, true);
  assert.equal(reason(429, 'Rate limit exceeded', { 'x-ratelimit-limit-req-minute': '60' }).unsure, true);
  assert.equal(reason(503, 'Service unavailable').unsure, true);
  assert.equal(reason(0, 'The operation was aborted due to timeout').unsure, true);
});

test("reads OpenAI's list of the levels a model takes", () => {
  assert.deepEqual(levelsFromError("Unsupported value: 'none' is not supported with the 'gpt-5.5-pro' model. Supported values are: 'medium', 'high', and 'xhigh'."), ['medium', 'high', 'xhigh']);
  assert.deepEqual(levelsFromError("Unsupported value: 'none' is not supported with the 'gpt-5-pro' model. Supported values are: 'high'."), ['high']);
  assert.equal(levelsFromError("Unsupported parameter: 'reasoning.effort' is not supported with this model."), null);
});
