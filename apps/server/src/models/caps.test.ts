import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicModels, chatGptModels, fitEffort, fromLevels, geminiModels, isChatId, keepChat, knownEfforts, ollamaModel, openRouterModels } from './caps.js';

const yes = { supported: true };
const no = { supported: false };

test('drops models that are not chat models', () => {
  for (const id of ['text-embedding-3-large', 'tts-1', 'whisper-1', 'dall-e-3', 'gpt-image-1', 'omni-moderation-latest', 'gpt-4o-realtime-preview', 'gpt-4o-audio-preview', 'gpt-4o-mini-transcribe', 'gemini-2.5-flash-image', 'imagen-4.0-generate-001', 'veo-3.0-generate-001', 'llama-guard-4-12b', 'mistral-ocr-latest', 'gpt-4o-mini-search-preview', 'gpt-3.5-turbo-instruct'])
    assert.equal(isChatId(id), false, id);
  for (const id of ['gpt-5.6-terra', 'claude-opus-5-5', 'gemini-3-pro-preview', 'meta-llama/llama-4-scout-17b-16e-instruct', 'mistral-large-latest', 'deepseek-chat', 'grok-4'])
    assert.equal(isChatId(id), true, id);
});

test('maps provider levels onto ours: max is anything above high', () => {
  assert.deepEqual(fromLevels(['low', 'medium', 'high', 'xhigh', 'max']), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(fromLevels(['low', 'medium', 'high', 'xhigh']), ['low', 'medium', 'high', 'max']);
  assert.deepEqual(fromLevels(['minimal', 'low', 'high']), ['low', 'high']);
  assert.deepEqual(fromLevels([]), []);
});

test('Anthropic: effort from capabilities', () => {
  const out = anthropicModels([
    { id: 'claude-opus-5-5', capabilities: { effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: yes, max: yes } } },
    { id: 'claude-opus-4-5-20251101', capabilities: { effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: no, max: no } } },
    { id: 'claude-haiku-4-5-20251001', capabilities: { effort: { supported: false, low: no } } },
  ]);
  assert.deepEqual(out.map(m => m.efforts), [['low', 'medium', 'high', 'max'], ['low', 'medium', 'high'], []]);
});

test('OpenRouter: needs text in and out and tools; reasoning takes effort', () => {
  const m = (id: string, out: string[], params: string[]) => ({ id, architecture: { input_modalities: ['text'], output_modalities: out }, supported_parameters: params });
  const got = openRouterModels([
    m('liquid/lfm-2.5-24b-a2b', ['text'], ['tools', 'reasoning']),
    m('x/plain', ['text'], ['tools']),
    m('x/no-tools', ['text'], ['temperature']),
    m('x/audio', ['audio'], ['tools']),
  ]);
  assert.deepEqual(got, [
    { id: 'liquid/lfm-2.5-24b-a2b', efforts: ['low', 'medium', 'high', 'max'] },
    { id: 'x/plain', efforts: [] },
  ]);
});

test('Gemini: generateContent only; thinking models take effort', () => {
  const got = geminiModels([
    { name: 'models/gemini-3-pro-preview', supportedGenerationMethods: ['generateContent', 'countTokens'], thinking: true },
    { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
  ]);
  assert.deepEqual(got, [
    { id: 'gemini-3-pro-preview', efforts: ['low', 'medium', 'high'] },
    { id: 'gemini-2.0-flash', efforts: [] },
  ]);
});

test('ChatGPT plan: listed models and their reasoning levels', () => {
  const got = chatGptModels([
    { slug: 'gpt-6-luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, { effort: 'xhigh' }] },
    { slug: 'gpt-reserve', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
  ]);
  assert.deepEqual(got, [{ id: 'gpt-6-luna', efforts: ['low', 'medium', 'high', 'max'] }]);
});

test('Ollama: a model without tools is dropped; one that says nothing is kept', () => {
  assert.equal(ollamaModel('gemma3', { capabilities: ['completion', 'vision'] }), null);
  assert.deepEqual(ollamaModel('gpt-oss:20b', { capabilities: ['completion', 'tools', 'thinking'] }), { id: 'gpt-oss:20b', efforts: ['low', 'medium', 'high'] });
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
