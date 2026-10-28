import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  anthropicModels,
  chatGptModels,
  deepseekModels,
  fitEffort,
  fromLevels,
  geminiModels,
  groqModels,
  isChatId,
  keepChat,
  knownEfforts,
  knownModel,
  mistralModels,
  ollamaModel,
  openAiModels,
  openRouterModels,
  xaiModels,
} from './caps.js';

const yes = { supported: true };
const no = { supported: false };

test('drops models that are not chat models', () => {
  for (const id of ['text-embedding-3-large', 'tts-1', 'whisper-1', 'dall-e-3', 'gpt-image-1', 'omni-moderation-latest', 'gpt-4o-realtime-preview', 'gpt-4o-audio-preview', 'gpt-4o-mini-transcribe', 'gemini-2.5-flash-image', 'imagen-4.0-generate-001', 'veo-3.0-generate-001', 'llama-guard-4-12b', 'mistral-ocr-latest', 'gpt-4o-mini-search-preview', 'gpt-3.5-turbo-instruct'])
    assert.equal(isChatId(id), false, id);
  for (const id of ['gpt-5.6-terra', 'claude-opus-5-5', 'gemini-3-pro-preview', 'meta-llama/llama-4-scout-17b-16e-instruct', 'mistral-large-latest', 'deepseek-chat', 'grok-4'])
    assert.equal(isChatId(id), true, id);
  // Chat models that can't take our tools, found live on 2026-10-28.
  for (const id of ['gpt-5-search-api', 'gpt-3.5-turbo-16k', 'nano-banana-pro-preview', 'gemini-nano-banana-2.1', 'grok-imagine-video-1.5', 'grok-4.20-multi-agent-0309', 'antigravity-preview-latest', 'deep-research-preview-04-2026', 'deep-research-max-preview-04-2026'])
    assert.equal(isChatId(id), false, id);
});

test('OpenAI: models past their shutdown date are gone', () => {
  const now = Date.parse('2026-10-28');
  const got = openAiModels([{ id: 'o4-mini', shutdown_date: '2026-10-23' }, { id: 'o3', shutdown_date: '2026-12-11' }, { id: 'gpt-6-sol' }], now);
  assert.deepEqual(got.map(m => m.id), ['o3', 'gpt-6-sol']);
});

test('xAI: effort from capabilities.reasoning_effort', () => {
  const got = xaiModels([
    { id: 'grok-4.3', capabilities: { reasoning_effort: ['none', 'low', 'medium', 'high', 'xhigh'] } },
    { id: 'grok-4.20-0309-reasoning' },
  ]);
  assert.deepEqual(got, [
    { id: 'grok-4.3', efforts: ['low', 'medium', 'high', 'max'], native: { max: 'xhigh' } },
    { id: 'grok-4.20-0309-reasoning', efforts: [] },
  ]);
});

test('Groq: text in and out, tools, active; reasoning takes effort', () => {
  const got = groqModels([
    { id: 'openai/gpt-oss-20b', input_modalities: ['text'], output_modalities: ['text'], supported_features: ['tools', 'reasoning'], active: true },
    { id: 'allam-2-7b', input_modalities: ['text'], output_modalities: ['text'], supported_features: ['json_mode'], active: true },
    { id: 'canopylabs/orpheus-v1-english', input_modalities: ['text'], output_modalities: ['speech'], active: true },
    { id: 'old/model', input_modalities: ['text'], output_modalities: ['text'], supported_features: ['tools'], active: false },
  ]);
  assert.deepEqual(got.map(m => [m.id, m.efforts]), [['openai/gpt-oss-20b', ['low', 'medium', 'high']]]);
});

test('Mistral: chat and function calling, not deprecated; no effort', () => {
  const now = Date.parse('2026-10-28');
  const caps = (chat: boolean, tools: boolean) => ({ completion_chat: chat, function_calling: tools });
  const got = mistralModels(
    [
      { id: 'mistral-small-latest', capabilities: caps(true, true), deprecation: null },
      { id: 'mistral-ocr-latest', capabilities: caps(false, true) },
      { id: 'mistral-embed', capabilities: caps(false, false) },
      { id: 'old-mistral', capabilities: caps(true, true), deprecation: '2026-01-01' },
    ],
    now,
  );
  assert.deepEqual(got, [{ id: 'mistral-small-latest', efforts: [] }]);
});

test('DeepSeek: effort.supported_levels', () => {
  assert.deepEqual(deepseekModels([{ id: 'deepseek-flash', effort: { supported_levels: ['low', 'high', 'max'] }, output_modalities: ['text'] }]), [
    { id: 'deepseek-flash', efforts: ['low', 'high', 'max'], native: undefined },
  ]);
});

test('OpenRouter: expired models are gone', () => {
  const now = Date.parse('2026-10-28');
  const m = (id: string, expiration_date?: string) => ({ id, expiration_date, architecture: { input_modalities: ['text'], output_modalities: ['text'] }, supported_parameters: ['tools'] });
  assert.deepEqual(openRouterModels([m('a/old', '2026-09-01'), m('a/soon', '2026-12-01'), m('a/none')], now).map(x => x.id), ['a/soon', 'a/none']);
});

test('Gemini: Gemma thinks but takes no effort setting', () => {
  const got = geminiModels([{ name: 'models/gemma-4-31b-it', supportedGenerationMethods: ['generateContent'], thinking: true }]);
  assert.deepEqual(got, [{ id: 'gemma-4-31b-it', efforts: [] }]);
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
  assert.deepEqual(knownEfforts('openai', 'chat-latest'), []);
  // As each model answered live on 2026-10-28.
  assert.deepEqual(knownEfforts('openai', 'gpt-5-pro'), []); // "high" only
  assert.deepEqual(knownModel('openai', 'gpt-5.5-pro'), { id: 'gpt-5.5-pro', efforts: ['medium', 'high', 'max'], native: { max: 'xhigh' } });
  assert.deepEqual(knownModel('openai', 'gpt-5.4-mini').native, { max: 'xhigh' });
  assert.deepEqual(knownModel('openai', 'gpt-5.6-terra'), { id: 'gpt-5.6-terra', efforts: ['low', 'medium', 'high', 'max'], native: undefined });
  assert.deepEqual(knownModel('openai', 'gpt-6-astra').native, undefined);
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
