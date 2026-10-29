import { availableModels, type Available } from '../models/connections.js';
import type { ModelChoice } from '../models/choice.js';

// The models a built-in agent starts with (the Fleet Engineer, the Conductor,
// the Security Reviewer): three, from what's connected. The person's plans
// first - they cost nothing per run - then their preference for the job, then
// anything at all that's connected (DeepSeek, Mistral, Ollama, a custom one),
// so a built-in never sits there with no model. Changed on its card like any.

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

export function pickDefaults(avail: Pick<Available, 'connection' | 'models'>[], want: Want): ModelChoice[] {
  const out: ModelChoice[] = [];
  const add = (connection: string, model: string) => {
    if (out.length < 3 && !out.some(c => c.connection === connection)) out.push({ connection, model, effort: want === 'cheap' ? 'low' : 'high' });
  };
  for (const [connection, re] of PREFER[want]) {
    const m = avail.find(a => a.connection === connection)?.models.find(x => re.test(x));
    if (m) add(connection, m);
  }
  // Anything else connected, so there is always something.
  const rest = avail
    .filter(a => a.models.length && !out.some(c => c.connection === a.connection))
    .sort((a, b) => Number(FREE.has(b.connection)) - Number(FREE.has(a.connection)));
  for (const a of rest) add(a.connection, (want === 'cheap' ? a.models.find(m => CHEAPISH.test(m)) : undefined) ?? a.models[0]);
  return out;
}
