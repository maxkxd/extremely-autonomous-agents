import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicModels, chatGptModels, fitEffort, fromLevels, geminiModels, isChatId, keepChat, knownEfforts, knownModel, ollamaModel, openRouterModels } from './caps.js';

const yes = { supported: true };
const no = { supported: false };

test('drops models that are not chat models', () => {
  for (const id of ['text-embedding-3-large', 'tts-1', 'whisper-1', 'dall-e-3', 'gpt-image-1', 'omni-moderation-latest', 'gpt-4o-realtime-preview', 'gpt-4o-audio-preview', 'gpt-4o-mini-transcribe', 'gemini-2.5-flash-image', 'imagen-4.0-generate-001', 'veo-3.0-generate-001', 'llama-guard-4-12b', 'mistral-ocr-latest', 'gpt-4o-mini-search-preview', 'gpt-3.5-turbo-instruct'])
    assert.equal(isChatId(id), false, id);
  for (const id of ['gpt-5.6-terra', 'claude-opus-5-5', 'gemini-3-pro-preview', 'meta-llama/llama-4-scout-17b-16e-instruct', 'mistral-large-latest', 'deepseek-chat', 'grok-4'])
    assert.equal(isChatId(id), true, id);
});

test('maps provider levels onto ours: max is its max, else its xhigh', () => {
  assert.deepEqual(fromLevels(['low', 'medium', 'high', 'xhigh', 'max']), { efforts: ['low', 'medium', 'high', 'max'], native: undefined });
  assert.deepEqual(fromLevels(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).efforts, ['low', 'medium', 'high', 'max']);
  assert.deepEqual(fromLevels(['xhigh', 'high', 'medium', 'low']), { efforts: ['low', 'medium', 'high', 'max'], native: { max: 'xhigh' } });
  assert.deepEqual(fromLevels(['minimal', 'low', 'high', 'none']).efforts, ['low', 'high']);
  assert.deepEqual(fromLevels(['high']), { efforts: [] }); // nothing to choose
  assert.deepEqual(fromLevels(['high', 'none']), { efforts: [] });
  assert.deepEqual(fromLevels([]), { efforts: [] });
});

test('Anthropic: effort from capabilities', () => {
  const out = anthropicModels([
    { id: 'claude-opus-5-5', capabilities: { effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: yes, max: yes } } },
    { id: 'claude-opus-4-5-20251101', capabilities: { effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: no, max: no } } },
    { id: 'claude-haiku-4-5-20251001', capabilities: { effort: { supported: false, low: no } } },
  ]);
  assert.deepEqual(out.map(m => m.efforts), [['low', 'medium', 'high', 'max'], ['low', 'medium', 'high'], []]);
});

test('OpenRouter: needs text in and out and tools; effort from reasoning.supported_efforts', () => {
  const m = (id: string, out: string[], params: string[], reasoning?: object) => ({
    id,
    architecture: { input_modalities: ['text'], output_modalities: out },
    supported_parameters: params,
    reasoning,
  });
  const got = openRouterModels([
    m('google/gemini-4-argon', ['text'], ['tools', 'reasoning'], { mandatory: true, supported_efforts: ['high', 'medium', 'low'] }),
    m('x/xhigh-top', ['text'], ['tools', 'reasoning'], { supported_efforts: ['xhigh', 'high', 'medium', 'low', 'none'] }),
    m('liquid/lfm-2.5-24b-a2b', ['text'], ['tools', 'reasoning'], { mandatory: true }),
    m('x/plain', ['text'], ['tools']),
    m('x/no-tools', ['text'], ['temperature']),
    m('x/audio', ['audio'], ['tools']),
  ]);
  assert.deepEqual(got, [
    { id: 'google/gemini-4-argon', efforts: ['low', 'medium', 'high'], native: undefined },
    { id: 'x/xhigh-top', efforts: ['low', 'medium', 'high', 'max'], native: { max: 'xhigh' } },
    { id: 'liquid/lfm-2.5-24b-a2b', efforts: [] },
    { id: 'x/plain', efforts: [] },
  ]);
});

test('Gemini: generateContent only; thinking models take effort', () => {
  const got = geminiModels([
    { name: 'models/gemini-3-pro-preview', supportedGenerationMethods: ['generateContent', 'countTokens'], thinking: true },
    { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
  ]);
  assert.deepEqual(got.map(m => [m.id, m.efforts]), [
    ['gemini-3-pro-preview', ['low', 'medium', 'high']],
    ['gemini-2.0-flash', []],
  ]);
});

test('ChatGPT plan: listed models and their reasoning levels', () => {
  const got = chatGptModels([
    { slug: 'gpt-6-luna', visibility: 'list', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map(effort => ({ effort })) },
    { slug: 'gpt-5.6-terra', visibility: 'list', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh'].map(effort => ({ effort })) },
    { slug: 'gpt-reserve', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
  ]);
  assert.deepEqual(got, [
    { id: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'max'], native: undefined },
    { id: 'gpt-5.6-terra', efforts: ['low', 'medium', 'high', 'max'], native: { max: 'xhigh' } },
  ]);
});

test('Ollama: a model without tools is dropped; one that says nothing is kept', () => {
  assert.equal(ollamaModel('gemma3', { capabilities: ['completion', 'vision'] }), null);
  assert.deepEqual(ollamaModel('gpt-oss:20b', { capabilities: ['completion', 'tools', 'thinking'] })?.efforts, ['low', 'medium', 'high']);
  assert.deepEqual(ollamaModel('qwen3', { capabilities: ['completion', 'tools', 'thinking'] }), { id: 'qwen3', efforts: [] });
  assert.deepEqual(ollamaModel('mystery', null), { id: 'mystery', efforts: [] });
});

test('known effort for providers that only list ids', () => {
  assert.deepEqual(knownEfforts('openai', 'gpt-4.1'), []);
  assert.deepEqual(knownEfforts('openai', 'o3'), ['low', 'medium', 'high']);
  assert.deepEqual(knownEfforts('openai', 'gpt-5'), ['low', 'medium', 'high']);
  assert.deepEqual(knownEfforts('openai', 'gpt-5.2'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(knownEfforts('openai', 'gpt-5-chat-latest'), []);
  assert.deepEqual(knownEfforts('xai', 'grok-3-mini'), ['low', 'high']);
  assert.deepEqual(knownEfforts('deepseek', 'deepseek-reasoner'), []);
  assert.deepEqual(knownEfforts('claude-code', 'claude-haiku-5-5'), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(knownModel('claude-code', 'claude-opus-5-5').native, undefined); // claude --effort max
  assert.deepEqual(knownModel('openai', 'gpt-5.2').native, { max: 'xhigh' });
});

test('keepChat drops blanks, non-chat models and repeats', () => {
  assert.deepEqual(
    keepChat([{ id: 'a', efforts: [] }, { id: '', efforts: [] }, { id: 'tts-1', efforts: [] }, { id: 'a', efforts: ['low'] }]).map(m => m.id),
    ['a'],
  );
});

test('fitEffort picks the nearest level the model takes', () => {
  assert.equal(fitEffort('max', ['low', 'medium', 'high']), 'high');
  assert.equal(fitEffort('medium', ['low', 'high']), 'low');
  assert.equal(fitEffort('high', ['low', 'medium', 'high', 'max']), 'high');
  assert.equal(fitEffort('medium', []), 'medium');
});
