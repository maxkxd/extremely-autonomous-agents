// The AI model providers an agent can run on (docs/model-connections.md).
//
// Three kinds of connection:
//   plan   - a subscription the person already pays for, connected through
//            that provider's own sanctioned route (Claude Code, Sign in with
//            ChatGPT, GitHub Copilot)
//   key    - an API key, checked live against the provider before it's saved
//   local  - a model server on this machine (no key)

export type ProviderKind = 'plan' | 'key' | 'local';

export type Provider = {
  id: string;
  name: string;
  kind: ProviderKind;
  what: string; // one line for the row
  keyUrl?: string; // where to get a key
  keyPrefix?: string; // placeholder hint
  baseUrl?: string; // default, for providers whose base URL can be set
  editableBaseUrl?: boolean;
  oneClick?: boolean; // also offers a sign-in that fetches a key (OpenRouter)
};

export const PROVIDERS: Provider[] = [
  // --- Plans you already pay for ---
  { id: 'claude-code', name: 'Claude', kind: 'plan', what: 'Your Claude plan, through Claude Code on this computer' },
  { id: 'chatgpt', name: 'ChatGPT', kind: 'plan', what: 'Your ChatGPT Go, Plus or Pro plan' },
  { id: 'copilot', name: 'GitHub Copilot', kind: 'plan', what: 'Your Copilot plan - Claude, GPT and Gemini models' },

  // --- API keys ---
  { id: 'anthropic', name: 'Anthropic', kind: 'key', what: 'Claude models', keyUrl: 'https://platform.claude.com/settings/keys', keyPrefix: 'sk-ant-' },
  { id: 'openai', name: 'OpenAI', kind: 'key', what: 'GPT and o-series models', keyUrl: 'https://platform.openai.com/api-keys', keyPrefix: 'sk-' },
  { id: 'google', name: 'Google Gemini', kind: 'key', what: 'Gemini models, from Google AI Studio', keyUrl: 'https://aistudio.google.com/apikey', keyPrefix: 'AQ.' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'key', what: 'Hundreds of models from every provider, one key', keyUrl: 'https://openrouter.ai/settings/keys', keyPrefix: 'sk-or-', oneClick: true },
  { id: 'xai', name: 'xAI', kind: 'key', what: 'Grok models', keyUrl: 'https://console.x.ai', keyPrefix: 'xai-' },
  { id: 'mistral', name: 'Mistral', kind: 'key', what: 'Mistral and Codestral models', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'key', what: 'DeepSeek models', keyUrl: 'https://platform.deepseek.com/api_keys', keyPrefix: 'sk-' },
  { id: 'groq', name: 'Groq', kind: 'key', what: 'Fast open models', keyUrl: 'https://console.groq.com/keys', keyPrefix: 'gsk_' },
  {
    id: 'custom',
    name: 'Other (OpenAI-compatible)',
    kind: 'key',
    what: 'Any OpenAI-compatible API: Azure, Together, Fireworks, a gateway...',
    editableBaseUrl: true,
    baseUrl: '',
  },

  // --- On this machine ---
  { id: 'ollama', name: 'Ollama', kind: 'local', what: 'Models running on this computer', baseUrl: 'http://localhost:11434', editableBaseUrl: true },
];

import {
  anthropicModels,
  deepseekModels,
  geminiModels,
  groqModels,
  keepChat,
  knownModel,
  mistralModels,
  ollamaModel,
  openAiModels,
  openRouterModels,
  xaiModels,
  type ModelInfo,
} from './caps.js';

export const provider = (id: string) => PROVIDERS.find(p => p.id === id);

export class ConnectError extends Error {}

async function getJson(url: string, headers: Record<string, string> = {}) {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  } catch {
    throw new ConnectError(`Couldn't reach ${new URL(url).host}.`);
  }
  // Some providers answer a bad key with 400 rather than 401.
  if (res.status === 400 || res.status === 401 || res.status === 403)
    throw new ConnectError("That key wasn't accepted - it may be incomplete, revoked or for a different account.");
  if (res.status === 429) throw new ConnectError('The provider is busy right now (429). Try again in a minute.');
  if (!res.ok) throw new ConnectError(`The provider had a problem (${res.status}). Try again later.`);
  return res.json() as Promise<Record<string, unknown>>;
}

const ids = (list: unknown, field = 'id') =>
  Array.isArray(list) ? list.map(m => String((m as Record<string, unknown>)[field] ?? '')).filter(Boolean) : [];
// Providers that only list ids: effort from what's known about each family.
const named = (id: string, list: string[]): ModelInfo[] => list.map(m => knownModel(id, m));

const trimSlash = (u: string) => u.replace(/\/+$/, '');

// Checks a key (or local server) and returns the models it can run agents on.
export async function verify(id: string, key: string, baseUrl?: string): Promise<ModelInfo[]> {
  return keepChat(await listModels(id, key, baseUrl));
}

async function listModels(id: string, key: string, baseUrl?: string): Promise<ModelInfo[]> {
  const bearer = { authorization: `Bearer ${key}` };
  switch (id) {
    case 'anthropic':
      return anthropicModels((await getJson('https://api.anthropic.com/v1/models?limit=1000', { 'x-api-key': key, 'anthropic-version': '2023-06-01' })).data);
    case 'openai':
      return openAiModels((await getJson('https://api.openai.com/v1/models', bearer)).data);
    case 'google':
      // In a header, as Google documents it - never in the URL. Works for both
      // key formats: older "AIza..." keys and the "AQ." auth keys AI Studio
      // has issued since May 2026.
      return geminiModels((await getJson('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', { 'x-goog-api-key': key })).models);
    case 'openrouter': {
      // The key itself is checked; the model list is public.
      await getJson('https://openrouter.ai/api/v1/key', bearer);
      return openRouterModels((await getJson('https://openrouter.ai/api/v1/models')).data);
    }
    case 'xai':
      return xaiModels((await getJson('https://api.x.ai/v1/models', bearer)).data);
    case 'mistral':
      return mistralModels((await getJson('https://api.mistral.ai/v1/models', bearer)).data);
    case 'deepseek':
      return deepseekModels((await getJson('https://api.deepseek.com/models', bearer)).data);
    case 'groq':
      return groqModels((await getJson('https://api.groq.com/openai/v1/models', bearer)).data);
    case 'custom': {
      if (!baseUrl) throw new ConnectError('Add the API base URL (ending in /v1).');
      return named(id, ids((await getJson(`${trimSlash(baseUrl)}/models`, bearer)).data));
    }
    case 'ollama': {
      // Each model says what it can do; one that won't say is kept.
      const base = trimSlash(baseUrl || 'http://localhost:11434');
      const names = ids((await getJson(`${base}/api/tags`)).models, 'name');
      const shown = await Promise.all(
        names.map(async name => {
          try {
            // "name" for older Ollama versions, "model" for newer ones.
            const res = await fetch(`${base}/api/show`, { method: 'POST', body: JSON.stringify({ model: name, name }), signal: AbortSignal.timeout(10000) });
            return ollamaModel(name, res.ok ? await res.json() : null);
          } catch {
            return ollamaModel(name, null);
          }
        }),
      );
      return shown.filter((m): m is ModelInfo => !!m);
    }
    default:
      throw new ConnectError('Unknown provider.');
  }
}
