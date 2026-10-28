import { EFFORTS, type Effort } from './choice.js';

// What a model can do (docs/model-connections.md). An agent needs a model
// that takes text, writes text and calls tools; anything else (embeddings,
// speech, images, moderation...) is dropped when a connection is made, so the
// picker and the builder never offer it. Where the provider reports a model's
// abilities we use that; where it doesn't, we go by known model names.
//
// efforts: the levels of ours the model honestly takes - empty when it has no
// effort setting. The runner maps them onto each provider's own scale.

export type ModelInfo = { id: string; efforts: Effort[] };

// Model ids that aren't chat models, whichever provider lists them.
const NOT_CHAT =
  /embed|tts|whisper|transcri|speech|dall-e|gpt-image|imagen|image-gen|-image|veo|sora|moderation|realtime|audio|rerank|guard|ocr|aqa|search-preview|computer-use|davinci|babbage|gpt-3\.5-turbo-instruct|lyria|native-audio|-live/i;
export const isChatId = (id: string) => !NOT_CHAT.test(id);

const ALL: Effort[] = [...EFFORTS];
const NO_MAX: Effort[] = ['low', 'medium', 'high'];

// A provider's own level names, mapped onto ours. Our "max" is its top level
// above "high" (xhigh or max), if it has one.
export function fromLevels(levels: string[]): Effort[] {
  const has = new Set(levels.map(l => l.toLowerCase()));
  const out: Effort[] = [];
  for (const e of ['low', 'medium', 'high'] as const) if (has.has(e)) out.push(e);
  if (has.has('max') || has.has('xhigh')) out.push('max');
  return out;
}

// For providers that don't report it: the effort levels known model families take.
export function knownEfforts(provider: string, id: string): Effort[] {
  const m = id.toLowerCase();
  switch (provider) {
    case 'claude-code':
      return ALL; // claude --effort low|medium|high|xhigh|max
    case 'openai': {
      if (/chat-latest/.test(m)) return [];
      if (/^o\d/.test(m)) return NO_MAX;
      const v = m.match(/^gpt-(\d+)(?:\.(\d+))?/);
      if (!v) return /codex/.test(m) ? NO_MAX : [];
      const major = Number(v[1]);
      const minor = Number(v[2] ?? 0);
      if (major < 5) return [];
      return major > 5 || minor >= 2 || /-max/.test(m) ? ALL : NO_MAX;
    }
    case 'xai':
      return /grok-3-mini/.test(m) ? ['low', 'high'] : [];
    case 'groq':
    case 'ollama':
      return /gpt-oss/.test(m) ? NO_MAX : [];
    default:
      return [];
  }
}

// --- What each provider reports ----------------------------------------------

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
const supported = (v: unknown) => !!v && (v as Json).supported === true;

// Anthropic: capabilities.effort.{low,medium,high,xhigh,max}.supported.
export function anthropicModels(data: unknown): ModelInfo[] {
  return list(data).map(m => {
    const effort = (m.capabilities as Json | undefined)?.effort as Json | undefined;
    const levels = supported(effort) ? Object.keys(effort!).filter(k => supported(effort![k])) : [];
    return { id: str(m.id), efforts: fromLevels(levels) };
  });
}

// OpenRouter: architecture modalities, and supported_parameters for tools
// and reasoning (it takes low/medium/high/xhigh for any reasoning model).
export function openRouterModels(data: unknown): ModelInfo[] {
  return list(data)
    .filter(m => {
      const arch = (m.architecture ?? {}) as Json;
      const params = strs(m.supported_parameters);
      return strs(arch.input_modalities).includes('text') && strs(arch.output_modalities).includes('text') && params.includes('tools');
    })
    .map(m => {
      const params = strs(m.supported_parameters);
      return { id: str(m.id), efforts: params.includes('reasoning') || params.includes('reasoning_effort') ? ALL : [] };
    });
}

// Gemini: only models that generateContent; "thinking" ones take a level.
export function geminiModels(data: unknown): ModelInfo[] {
  return list(data)
    .filter(m => strs(m.supportedGenerationMethods).includes('generateContent'))
    .map(m => ({ id: str(m.name).replace(/^models\//, ''), efforts: m.thinking === true ? NO_MAX : [] }));
}

// Sign in with ChatGPT: supported_reasoning_levels, and only listed models.
export function chatGptModels(data: unknown): ModelInfo[] {
  return list(data)
    .filter(m => !m.visibility || m.visibility === 'list')
    .map(m => ({
      id: str(m.slug) || str(m.id),
      efforts: fromLevels(list(m.supported_reasoning_levels).map(l => str(l.effort))),
    }));
}

// Ollama: /api/show capabilities; a model must have "tools".
export function ollamaModel(id: string, show: unknown): ModelInfo | null {
  const caps = strs((show as Json | undefined)?.capabilities);
  if (caps.length && !caps.includes('tools')) return null;
  return { id, efforts: caps.includes('thinking') ? knownEfforts('ollama', id) : [] };
}

const list = (v: unknown): Json[] => (Array.isArray(v) ? (v.filter(x => x && typeof x === 'object') as Json[]) : []);

// The last pass for every provider: real ids, chat models only, no repeats.
export function keepChat(models: ModelInfo[]): ModelInfo[] {
  const seen = new Set<string>();
  return models.filter(m => m.id && isChatId(m.id) && !seen.has(m.id) && seen.add(m.id));
}

// The closest level a model takes to the one asked for (medium when it has none).
export function fitEffort(want: Effort, efforts: Effort[]): Effort {
  if (!efforts.length) return want;
  if (efforts.includes(want)) return want;
  const at = EFFORTS.indexOf(want);
  return [...efforts].sort((a, b) => Math.abs(EFFORTS.indexOf(a) - at) - Math.abs(EFFORTS.indexOf(b) - at) || EFFORTS.indexOf(a) - EFFORTS.indexOf(b))[0];
}
