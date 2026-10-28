import { EFFORTS, type Effort } from './choice.js';

// What a model can do (docs/model-connections.md). An agent needs a model
// that takes text, writes text and calls tools; anything else (embeddings,
// speech, images, moderation...) is dropped when a connection is made, so the
// picker and the builder never offer it. Where the provider reports a model's
// abilities we use that; where it doesn't, we go by known model names.
//
// efforts: the levels of ours the model honestly takes - empty when it has no
// effort setting, or only one (nothing to choose). native: what to send the
// provider for a level, where its name differs from ours - in practice our
// "max" sent as "xhigh". The runner sends native[level] ?? level.

export type Native = Partial<Record<Effort, string>>;
export type ModelInfo = { id: string; efforts: Effort[]; native?: Native };

// Model ids that aren't chat models, whichever provider lists them.
const NOT_CHAT =
  /embed|tts|whisper|transcri|speech|dall-e|gpt-image|imagen|image-gen|-image|veo|sora|moderation|realtime|audio|rerank|guard|ocr|aqa|search-preview|computer-use|davinci|babbage|gpt-3\.5-turbo-instruct|lyria|native-audio|-live/i;
export const isChatId = (id: string) => !NOT_CHAT.test(id);

// A provider's own level names, mapped onto ours. low/medium/high as named;
// our "max" is its "max", or "xhigh" when it has no max (levels above max,
// like "ultra", aren't offered). A single level is nothing to choose, so it
// counts as no effort setting.
export function fromLevels(levels: string[]): { efforts: Effort[]; native?: Native } {
  const has = new Set(levels.map(l => l.toLowerCase()));
  const efforts: Effort[] = (['low', 'medium', 'high'] as const).filter(e => has.has(e));
  let native: Native | undefined;
  if (has.has('max')) efforts.push('max');
  else if (has.has('xhigh')) {
    efforts.push('max');
    native = { max: 'xhigh' };
  }
  return efforts.length > 1 ? { efforts, native } : { efforts: [] };
}
const leveled = (id: string, levels: string[]): ModelInfo => ({ id, ...fromLevels(levels) });

// For providers that don't report it: the levels known model families take,
// in the provider's own names.
function knownLevels(provider: string, m: string): string[] {
  switch (provider) {
    case 'claude-code':
      return ['low', 'medium', 'high', 'xhigh', 'max']; // claude --effort
    case 'openai': {
      if (/chat-latest|-chat$/.test(m)) return [];
      if (/^o\d/.test(m)) return ['low', 'medium', 'high'];
      const v = m.match(/^gpt-(\d+)(?:\.(\d+))?/);
      if (!v) return /codex/.test(m) ? ['low', 'medium', 'high'] : [];
      const major = Number(v[1]);
      const minor = Number(v[2] ?? 0);
      if (major < 5) return [];
      return major > 5 || minor >= 2 || /-max/.test(m) ? ['low', 'medium', 'high', 'xhigh'] : ['low', 'medium', 'high'];
    }
    case 'xai':
      return /grok-3-mini/.test(m) ? ['low', 'high'] : [];
    case 'groq':
    case 'ollama':
      return /gpt-oss/.test(m) ? ['low', 'medium', 'high'] : [];
    default:
      return [];
  }
}
export const knownModel = (provider: string, id: string): ModelInfo => leveled(id, knownLevels(provider, id.toLowerCase()));
export const knownEfforts = (provider: string, id: string): Effort[] => knownModel(provider, id).efforts;

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
    return leveled(str(m.id), levels);
  });
}

// OpenRouter: architecture modalities, supported_parameters for tools, and
// reasoning.supported_efforts for the levels. A reasoning model that lists no
// levels thinks (or not) on its own: no effort setting.
export function openRouterModels(data: unknown): ModelInfo[] {
  return list(data)
    .filter(m => {
      const arch = (m.architecture ?? {}) as Json;
      const params = strs(m.supported_parameters);
      return strs(arch.input_modalities).includes('text') && strs(arch.output_modalities).includes('text') && params.includes('tools');
    })
    .map(m => leveled(str(m.id), strs(((m.reasoning ?? {}) as Json).supported_efforts)));
}

// Gemini: only models that generateContent; "thinking" ones take a level.
export function geminiModels(data: unknown): ModelInfo[] {
  return list(data)
    .filter(m => strs(m.supportedGenerationMethods).includes('generateContent'))
    .map(m => leveled(str(m.name).replace(/^models\//, ''), m.thinking === true ? ['low', 'medium', 'high'] : []));
}

// Sign in with ChatGPT: supported_reasoning_levels, and only listed models.
export function chatGptModels(data: unknown): ModelInfo[] {
  return list(data)
    .filter(m => !m.visibility || m.visibility === 'list')
    .map(m => leveled(str(m.slug) || str(m.id), list(m.supported_reasoning_levels).map(l => str(l.effort))));
}

// Ollama: /api/show capabilities; a model must have "tools".
export function ollamaModel(id: string, show: unknown): ModelInfo | null {
  const caps = strs((show as Json | undefined)?.capabilities);
  if (caps.length && !caps.includes('tools')) return null;
  return caps.includes('thinking') ? knownModel('ollama', id) : { id, efforts: [] };
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
