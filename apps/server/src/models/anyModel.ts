import * as z from 'zod/v4';
import { availableModels } from './connections.js';
import { allChecks, checkModel, classify } from './check.js';
import { choiceKey, isBenched } from './health.js';
import { adapterFor, type Msg } from '../runner/providers.js';
import { harnessFor } from '../runner/harness.js';
import { pickDefaults } from '../runner/defaults.js';
import { getHealth } from '../runner/run.js';

// One structured answer from whatever AI is connected - the agent builder's
// route when there's no working Anthropic key. A packaged app has no .env key,
// so someone on their Claude plan, Copilot or Mistral couldn't build an agent at
// all ("Add ANTHROPIC_API_KEY to apps/server/.env").
//
// The JSON Schema goes in the instructions; the answer is checked against it,
// and a model that gets it wrong is told what and asked once more. A model that
// fails to answer: the next one tries. Its health (the agents' benching) is read,
// never written - a 3 MB paste failing on every model isn't the models failing.

export type Said = { role: 'user' | 'assistant'; text: string };

export class NoModelError extends Error {}

// The models to try: the strongest working ones, spread across connections,
// then the cheap ones - a free Gemini key has no quota for any Pro model, and
// the first "pro" it lists (gemini-2.5-pro) is retired for new keys, so three
// strong picks all failed while Flash would have answered.
export async function workingChoices(skip: (connection: string) => boolean = () => false) {
  const avail = (await availableModels().catch(() => [])).filter(a => !skip(a.connection));
  const checks = await allChecks().catch(() => ({}) as Record<string, { ok: boolean }>);
  const health = getHealth();
  const ok = avail.map(a => ({ ...a, models: a.models.filter(m => checks[`${a.connection}/${m}`]?.ok !== false) })).filter(a => a.models.length);
  const strong = pickDefaults(ok, 'strong');
  const picks = [...strong, ...pickDefaults(ok, 'cheap').filter(c => !strong.some(s => choiceKey(s) === choiceKey(c)))];
  // Benched ones last: better to try than to stop.
  return [...picks.filter(c => !isBenched(health, c)), ...picks.filter(c => isBenched(health, c))];
}

function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = (fenced ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in the answer');
  return JSON.parse(body.slice(start, end + 1));
}

async function say(connection: string, model: string, system: string, said: Said[]): Promise<string> {
  const adapter = adapterFor(connection);
  if (adapter) {
    const messages: Msg[] = said.map(s => (s.role === 'user' ? { role: 'user', text: s.text } : { role: 'assistant', text: s.text, calls: [] }));
    return (await adapter({ connection, model, system, messages, tools: [], maxTokens: 16_000 })).text;
  }
  const harness = harnessFor(connection);
  if (!harness) throw new Error(`${connection} can't be used here`);
  // A plan's own loop starts from one message: the conversation so far, then what's asked.
  const opening = said.length === 1 ? said[0].text : said.map(s => `${s.role === 'user' ? 'Them' : 'You'}: ${s.text}`).join('\n\n');
  return (await harness({ model, system, opening, tools: [], call: async () => ({ content: '', error: true }), next: () => null })).text;
}

export async function jsonFromAnyModel<T extends z.ZodType>(schema: T, system: string, said: Said[], skip?: (connection: string) => boolean): Promise<z.infer<T>> {
  const choices = await workingChoices(skip);
  if (!choices.length) throw new NoModelError('No AI model is connected and working. Connect one in Settings > Connectors.');
  const shape = JSON.stringify(z.toJSONSchema(schema));
  const sys = `${system}\n\nAnswer with one JSON object and nothing else - no code fence, no words before or after - matching this JSON Schema:\n${shape}`;
  const failed: string[] = [];
  for (const c of choices) {
    let convo = said.length ? said : [{ role: 'user' as const, text: 'Go ahead.' }];
    let problem = '';
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const text = await say(c.connection, c.model, sys, convo);
        try {
          const r = schema.safeParse(jsonIn(text));
          if (r.success) return r.data;
          problem = r.error.issues.slice(0, 5).map(i => `${i.path.join('.') || '(top)'}: ${i.message}`).join('; ');
        } catch (e) {
          problem = (e as Error).message;
        }
        convo = [...convo, { role: 'assistant', text }, { role: 'user', text: `That didn't fit the schema (${problem}). Answer again with the corrected JSON object only.` }];
      }
      failed.push(`its answer didn't fit, twice: ${problem.slice(0, 200)}`);
    } catch (e) {
      const message = (e as Error).message;
      failed.push(message.slice(0, 160));
      // Gone for good (retired, not on this plan): checked again, so it's skipped next time.
      if (!classify({ status: 400, message }).unsure) void checkModel(c.connection, c.model, true).catch(() => {});
    }
  }
  // Said once, plainly: every model usually fails the same way (one per line read as noise).
  console.error(`builder: no model answered: ${choices.map((c, i) => `${choiceKey(c)}: ${failed[i]}`).join(' | ')}`);
  throw new Error(`Your AI didn't answer (${failed[0]}). Try again in a moment, or connect another AI in Settings > Connectors.`);
}
