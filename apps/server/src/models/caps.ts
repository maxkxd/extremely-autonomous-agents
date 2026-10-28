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

// Model ids that can't run an agent, whichever provider lists them: not chat
// models (embeddings, speech, images, video, moderation...), or chat models
// that can't take our tools - search-only models, computer-use and multi-agent
// ones, and models that are agents themselves (deep research). Checked against
// live lists and requests on 2026-10-28; "-search-" so "research" isn't caught.
const NOT_CHAT =
  /embed|tts|whisper|transcri|speech|dall-e|gpt-image|imagen|image-gen|-image|nano-banana|imagine|veo|sora|moderation|realtime|audio|rerank|guard|ocr|aqa|-search-(preview|api)|computer-use|multi-agent|deep-research|antigravity|davinci|babbage|gpt-3\.5|lyria|native-audio|-live/i;
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
// in the provider's own names. OpenAI's table matches what each model
// accepted in live requests on 2026-10-28 (its model list says nothing).
function knownLevels(provider: string, m: string): string[] {
  switch (provider) {
    case 'claude-code':
      return ['low', 'medium', 'high', 'xhigh', 'max']; // claude --effort
    case 'openai': {
      if (/chat-latest|-chat$/.test(m)) return []; // "medium" only
      if (/^o\d/.test(m)) return ['low', 'medium', 'high'];
      const v = m.match(/^gpt-(\d+)(?:\.(\d+))?/);
      if (!v) return [];
      const version = Number(v[1]) + Number(v[2] ?? 0) / 10;
      if (version < 5) return [];
      if (/-pro\b/.test(m)) return version < 5.2 ? [] : ['medium', 'high', 'xhigh']; // gpt-5-pro: "high" only
      if (version < 5.2) return ['low', 'medium', 'high'];
      if (version < 5.6) return ['low', 'medium', 'high', 'xhigh'];
      return ['low', 'medium', 'high', 'xhigh', 'max'];
    }
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

// A date the model stops working, if any, has passed. `now` for tests.
const gone = (date: unknown, now: number) => typeof date === 'string' && !!date && Date.parse(date) <= now;

// OpenRouter: architecture modalities, supported_parameters for tools, and
// reasoning.supported_efforts for the levels. A reasoning model that lists no
// levels thinks (or not) on its own: no effort setting. Expired ones go.
export function openRouterModels(data: unknown, now = Date.now()): ModelInfo[] {
  return list(data)
    .filter(m => {
      const arch = (m.architecture ?? {}) as Json;
      const params = strs(m.supported_parameters);
      return (
        strs(arch.input_modalities).includes('text') &&
        strs(arch.output_modalities).includes('text') &&
        params.includes('tools') &&
        !gone(m.expiration_date, now)
      );
    })
    .map(m => leveled(str(m.id), strs(((m.reasoning ?? {}) as Json).supported_efforts)));
}

// Gemini: only models that generateContent. Gemini models that think take
// low/medium/high (tested); Gemma's "thinking" takes only "high", so no setting.
export function geminiModels(data: unknown): ModelInfo[] {
  return list(data)
    .filter(m => strs(m.supportedGenerationMethods).includes('generateContent'))
    .map(m => {
      const id = str(m.name).replace(/^models\//, '');
      return leveled(id, m.thinking === true && !/^gemma/.test(id) ? ['low', 'medium', 'high'] : []);
    });
}

// OpenAI: ids only, plus shutdown_date - a model past it still shows in the
// list but answers "does not exist". Levels from the known table.
export function openAiModels(data: unknown, now = Date.now()): ModelInfo[] {
  return list(data)
    .filter(m => !gone(m.shutdown_date, now))
    .map(m => knownModel('openai', str(m.id)));
}

// xAI: capabilities.reasoning_effort on the models that take one.
export function xaiModels(data: unknown): ModelInfo[] {
  return list(data).map(m => leveled(str(m.id), strs(((m.capabilities ?? {}) as Json).reasoning_effort)));
}

// Groq: modalities, supported_features ("tools", "reasoning") and active.
// Its reasoning models (gpt-oss, Qwen) take low/medium/high (tested).
export function groqModels(data: unknown): ModelInfo[] {
  return list(data)
    .filter(m => {
      const features = strs(m.supported_features);
      return (
        m.active !== false &&
        strs(m.input_modalities).includes('text') &&
        strs(m.output_modalities).includes('text') &&
        features.includes('tools')
      );
    })
    .map(m => leveled(str(m.id), strs(m.supported_features).includes('reasoning') ? ['low', 'medium', 'high'] : []));
}

// Mistral: capabilities.completion_chat and function_calling, and not past a
// deprecation date. Its reasoning models' effort isn't confirmed (the free
// plan allows them no requests), so none is offered.
export function mistralModels(data: unknown, now = Date.now()): ModelInfo[] {
  return list(data)
    .filter(m => {
      const caps = (m.capabilities ?? {}) as Json;
      return caps.completion_chat === true && caps.function_calling === true && !gone(m.deprecation, now);
    })
    .map(m => ({ id: str(m.id), efforts: [] }));
}

// DeepSeek: effort.supported_levels, and text output.
export function deepseekModels(data: unknown): ModelInfo[] {
  return list(data)
    .filter(m => !Array.isArray(m.output_modalities) || strs(m.output_modalities).includes('text'))
    .map(m => leveled(str(m.id), strs(((m.effort ?? {}) as Json).supported_levels)));
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
