import { readMeta } from '../files.js';
import { availableModels } from '../models/connections.js';
import { allChecks, type Check } from '../models/check.js';
import { allChoices, cleanChoices, type ModelChoice } from '../models/choice.js';
import { brokenModel, choiceKey, isBenched, recordFailure, recordSuccess, type Health } from '../models/health.js';
import { one, run as exec } from './db.js';
import { pickDefaults, type Want } from './defaults.js';
import { harnessFor, type HarnessResult } from './harness.js';
import { costOf, isFree } from './pricing.js';
import { adapterFor, ModelError } from './providers.js';
import { getHealth, newRunId, overSpend, postRun, putHealth, stateOf, type Trigger } from './run.js';

// One quick model call with no tools, made by one of the agency's built-in
// helpers (helpers.ts) - the Agency Conductor routing a request, the Agency Reviewer
// reading a plugin. It runs on that agent's own models, in order, falling to
// the next when one fails, and is recorded as a run: on its card, in Usage, and
// as a post in its DMs saying what it decided.
//
// When none of its own models answers (one out of credit, say), it tries the
// other AIs that work, best for its job first, in the same call: a helper is a
// step in someone else's work (a plugin's review before its approval card), and
// its own model running dry must never become a request asking a person to pay.

export class HelperStopped extends Error {}

type Ask = {
  trigger: Trigger;
  task: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  // The kind of model its job wants, for picking another when its own fail.
  want?: Want;
  // What it decided, for its DMs.
  summary: (text: string) => string | Promise<string>;
};

async function call(c: ModelChoice, system: string, prompt: string, maxTokens: number): Promise<HarnessResult> {
  const adapter = adapterFor(c.connection);
  if (adapter) {
    const r = await adapter({ connection: c.connection, model: c.model, system, messages: [{ role: 'user', text: prompt }], tools: [], maxTokens });
    return { text: r.text, usage: r.usage };
  }
  const harness = harnessFor(c.connection);
  if (!harness) throw new Error(`Can't call ${c.connection}.`);
  return harness({ model: c.model, system, opening: prompt, tools: [], call: async () => ({ content: '', error: true }), next: () => null });
}

// The other AIs to try once its own have failed: working ones it doesn't
// already have, best for its job first.
export function fallbacks(
  tried: Pick<ModelChoice, 'connection' | 'model'>[],
  avail: { connection: string; models: string[] }[],
  works: (c: Pick<ModelChoice, 'connection' | 'model'>) => boolean,
  want: Want,
): ModelChoice[] {
  const done = new Set(tried.map(choiceKey));
  const working = avail
    .map(a => ({ ...a, models: a.models.filter(m => !done.has(choiceKey({ connection: a.connection, model: m })) && works({ connection: a.connection, model: m })) }))
    .filter(a => a.models.length);
  return pickDefaults(working, want);
}

export async function ask(agentId: string, a: Ask): Promise<string> {
  const name = (await readMeta(agentId))?.name ?? agentId;
  const startedAt = Date.now();
  if (stateOf(agentId, startedAt).state === 'stopped') throw new HelperStopped('The agency is stopped.');
  const avail = await availableModels().catch(() => []);
  const connected = new Set(avail.map(m => m.connection));
  const over = overSpend(agentId, startedAt);
  const health = getHealth();
  const usable = cleanChoices((await allChoices())[agentId] ?? []).filter(c => connected.has(c.connection) && (isFree(c.connection) || !over));
  // Its models in order, ones cooling down after a failure last.
  const order = [...usable.filter(c => !isBenched(health, c, startedAt)), ...usable.filter(c => isBenched(health, c, startedAt))];
  // Its person turned moving off on its card: its own models only.
  const auto = one<{ auto: number | null }>('SELECT auto_models AS auto FROM agent_state WHERE agent_id = ?', agentId)?.auto !== 0;
  const more = async (h: Health) => {
    if (!auto) return [];
    const checks = await allChecks().catch(() => ({}) as Record<string, Check>);
    const works = (c: Pick<ModelChoice, 'connection' | 'model'>) =>
      (isFree(c.connection) || !over) && checks[choiceKey(c)]?.ok !== false && !brokenModel(h, c) && !isBenched(h, { ...c, effort: 'high' }, startedAt);
    return fallbacks(usable, avail, works, a.want ?? 'careful');
  };
  if (!order.length) order.push(...(await more(health)));
  if (!order.length) throw new Error(`${name} has no model it can use. Connect one in Settings > Connectors, or pick some on its card.`);

  const id = newRunId();
  exec('INSERT INTO runs (id, agent_id, trigger, task, ferocity, status, started_at) VALUES (?, ?, ?, ?, 0, ?, ?)', id, agentId, a.trigger, a.task, 'running', startedAt);
  let error = '';
  let fellBack = !usable.length;
  for (let i = 0; i < order.length; i++) {
    const c = order[i];
    try {
      const r = await call(c, a.system, a.prompt, a.maxTokens ?? 2000);
      putHealth(recordSuccess(getHealth(), c));
      const cost = r.usd !== undefined ? r.usd : await costOf(c.connection, c.model, r.usage.input, r.usage.output);
      const summary = await Promise.resolve(a.summary(r.text)).catch(() => r.text.slice(0, 500));
      const endedAt = Date.now();
      exec(
        "UPDATE runs SET status = 'succeeded', ended_at = ?, connection = ?, model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, summary = ? WHERE id = ?",
        endedAt, c.connection, c.model, r.usage.input, r.usage.output, cost, summary, id,
      );
      postRun(agentId, id, a.trigger, 'succeeded', cost, endedAt - startedAt, summary);
      return r.text;
    } catch (e) {
      putHealth(recordFailure(getHealth(), c, Date.now(), e instanceof ModelError ? e.kind : undefined));
      error = `${c.connection}/${c.model}: ${(e as Error).message}`;
      // Its own all failed: on to the other AIs that work, once.
      if (i === order.length - 1 && !fellBack) {
        fellBack = true;
        order.push(...(await more(getHealth())));
      }
    }
  }
  const endedAt = Date.now();
  exec("UPDATE runs SET status = 'failed', ended_at = ?, error = ? WHERE id = ?", endedAt, error, id);
  postRun(agentId, id, a.trigger, 'failed', null, endedAt - startedAt, `Run failed: ${error}`);
  throw new Error(error);
}

// The JSON object in a model's answer (models sometimes wrap it in prose).
export const jsonIn = <T>(text: string): T => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as T;
