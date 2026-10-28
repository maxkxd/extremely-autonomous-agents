import { availableModels } from '../models/connections.js';
import { harnessFor } from './harness.js';
import { adapterFor } from './providers.js';

// One quick model call with no tools - for small judgements the agency makes
// itself (the Conductor routing a request, the security review of a plugin).
// It picks from what the person has connected, in the order given: plans first
// where they'll do, so most of these cost nothing.

export type Prefer = [connection: string, model: RegExp][];

// Cheap and quick: routing.
export const CHEAP: Prefer = [
  ['claude-code', /haiku/],
  ['chatgpt', /luna|mini/],
  ['copilot', /./],
  ['anthropic', /haiku/],
  ['openai', /mini|nano/],
  ['google', /flash/],
  ['groq', /./],
  ['openrouter', /haiku|mini|flash/],
];

// Careful: reading code for what could go wrong.
export const CAREFUL: Prefer = [
  ['anthropic', /sonnet-5/],
  ['anthropic', /sonnet/],
  ['chatgpt', /./],
  ['openai', /^gpt-5\.\d+$|^gpt-5\.\d+-20/],
  ['google', /pro|flash/],
  ['openrouter', /anthropic\/claude-sonnet|openai\/gpt-5/],
  ['claude-code', /sonnet/],
  ['copilot', /./],
];

async function pick(prefer: Prefer): Promise<{ connection: string; model: string } | null> {
  const avail = await availableModels().catch(() => []);
  for (const [connection, re] of prefer) {
    const model = avail.find(a => a.connection === connection)?.models.find(m => re.test(m));
    if (model) return { connection, model };
  }
  return null;
}

export async function ask(prefer: Prefer, system: string, prompt: string, maxTokens = 2000): Promise<string> {
  const who = await pick(prefer);
  if (!who) throw new Error('No model is connected for this.');
  const adapter = adapterFor(who.connection);
  if (adapter) return (await adapter({ connection: who.connection, model: who.model, system, messages: [{ role: 'user', text: prompt }], tools: [], maxTokens })).text;
  const harness = harnessFor(who.connection);
  if (!harness) throw new Error(`Can't call ${who.connection}.`);
  return (await harness({ model: who.model, system, opening: prompt, tools: [], call: async () => ({ content: '', error: true }), next: () => null })).text;
}

// The JSON object in a model's answer (models sometimes wrap it in prose).
export const jsonIn = <T>(text: string): T => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as T;
