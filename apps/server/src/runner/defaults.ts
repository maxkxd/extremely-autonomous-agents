import { availableModels, type Available } from '../models/connections.js';
import type { ModelChoice } from '../models/choice.js';

// The models an agent starts with: three, from what's connected, so when one
// fails it falls to the next. The person's plans first - they cost nothing per
// run - then their preference for the job, then anything at all that's
// connected (DeepSeek, Mistral, Ollama, a custom one), one per connection; then,
// to make three, other models of the same connections (only Claude connected:
// Opus, Sonnet and Haiku). Changed on its card like any.

export type Want = 'strong' | 'cheap' | 'careful';

const PREFER: Record<Want, [string, RegExp][]> = {
  // Long runs that write and debug integrations.
  strong: [
    ['claude-code', /opus/],
    ['chatgpt', /./],
    ['copilot', /./],
    ['anthropic', /sonnet-5/],
    ['openai', /^gpt-5\.\d+$/],
    ['google', /pro/],
    ['openrouter', /anthropic\/claude-sonnet|openai\/gpt-5/],
    ['xai', /grok-4/],
    ['deepseek', /pro|reasoner/],
    ['mistral', /large|medium/],
  ],
  // One quick judgement (routing a request).
  cheap: [
    ['claude-code', /haiku/],
    ['chatgpt', /luna|mini/],
    ['copilot', /./],
    ['ollama', /./],
    ['anthropic', /haiku/],
    ['openai', /mini|nano/],
    ['google', /flash/],
    ['groq', /./],
    ['deepseek', /flash|chat/],
    ['xai', /mini|fast/],
    ['mistral', /small/],
    ['openrouter', /haiku|mini|flash/],
  ],
  // Reading code for what could go wrong.
  careful: [
    ['claude-code', /sonnet/],
    ['chatgpt', /./],
    ['copilot', /./],
    ['anthropic', /sonnet/],
    ['openai', /^gpt-5\.\d+$/],
    ['google', /pro/],
    ['openrouter', /anthropic\/claude-sonnet|openai\/gpt-5/],
    ['deepseek', /pro|reasoner/],
    ['xai', /grok-4/],
    ['mistral', /large|medium/],
  ],
};

// Within anything-connected: free ones first, then the likely-cheap ones for a quick job.
const FREE = new Set(['claude-code', 'chatgpt', 'copilot', 'ollama']);
const CHEAPISH = /mini|nano|flash|haiku|small|lite|fast|chat/i;

export const defaultModels = async (want: Want) => pickDefaults(await availableModels().catch(() => []), want);

// start: models it already has (from its builder), kept first; the rest fill up to three.
export function pickDefaults(avail: Pick<Available, 'connection' | 'models'>[], want: Want, start: ModelChoice[] = []): ModelChoice[] {
  const out: ModelChoice[] = start.slice(0, 3);
  const effort = out[0]?.effort ?? (want === 'cheap' ? 'low' : 'high');
  const add = (connection: string, model: string, spread: boolean) => {
    if (out.length >= 3 || out.some(c => c.connection === connection && (spread || c.model === model))) return;
    out.push({ connection, model, effort });
  };
  for (const [connection, re] of PREFER[want]) {
    const m = avail.find(a => a.connection === connection)?.models.find(x => re.test(x));
    if (m) add(connection, m, true);
  }
  // Anything else connected, so there is always something.
  const rest = avail
    .filter(a => a.models.length && !out.some(c => c.connection === a.connection))
    .sort((a, b) => Number(FREE.has(b.connection)) - Number(FREE.has(a.connection)));
  for (const a of rest) add(a.connection, (want === 'cheap' ? a.models.find(m => CHEAPISH.test(m)) : undefined) ?? a.models[0], true);
  // Still short of three: more from the same connections, the job's kind first,
  // then the other jobs' (a strong job's fallbacks: the careful one, then the cheap one).
  const order: Want[] = [want, ...(['careful', 'strong', 'cheap'] as Want[]).filter(w => w !== want)];
  for (const w of order)
    for (const [connection, re] of PREFER[w])
      for (const m of avail.find(a => a.connection === connection)?.models.filter(x => re.test(x)) ?? []) add(connection, m, false);
  for (const a of avail) for (const m of a.models) add(a.connection, m, false);
  return out;
}

// An agent's models topped up to three from what's connected (its own first).
export const topUpModels = async (start: ModelChoice[], want: Want = 'strong') =>
  pickDefaults(await availableModels().catch(() => []), want, start);
