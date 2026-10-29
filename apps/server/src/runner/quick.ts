import { readMeta } from '../files.js';
import { availableModels } from '../models/connections.js';
import { allChoices, cleanChoices, type ModelChoice } from '../models/choice.js';
import { isBenched, recordFailure, recordSuccess } from '../models/health.js';
import { run as exec } from './db.js';
import { harnessFor } from './harness.js';
import { costOf, isFree } from './pricing.js';
import { adapterFor } from './providers.js';
import { getHealth, newRunId, overSpend, postRun, putHealth, stateOf, type Trigger } from './run.js';

// One quick model call with no tools, made by one of the agency's built-in
// helpers (helpers.ts) - the Agency Conductor routing a request, the Agency Reviewer
// reading a plugin. It runs on that agent's own models, in order, falling to
// the next when one fails, and is recorded as a run: on its card, in Usage, and
// as a post in its DMs saying what it decided.

export class HelperStopped extends Error {}

type Ask = {
  trigger: Trigger;
  task: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  // What it decided, for its DMs.
  summary: (text: string) => string | Promise<string>;
};

async function call(c: ModelChoice, system: string, prompt: string, maxTokens: number) {
  const adapter = adapterFor(c.connection);
  if (adapter) {
    const r = await adapter({ connection: c.connection, model: c.model, system, messages: [{ role: 'user', text: prompt }], tools: [], maxTokens });
    return { text: r.text, usage: r.usage };
  }
  const harness = harnessFor(c.connection);
  if (!harness) throw new Error(`Can't call ${c.connection}.`);
  return harness({ model: c.model, system, opening: prompt, tools: [], call: async () => ({ content: '', error: true }), next: () => null });
}

export async function ask(agentId: string, a: Ask): Promise<string> {
  const name = (await readMeta(agentId))?.name ?? agentId;
  const startedAt = Date.now();
  if (stateOf(agentId, startedAt).state === 'stopped') throw new HelperStopped('The agency is stopped.');
  const connected = new Set((await availableModels().catch(() => [])).map(m => m.connection));
  const over = overSpend(agentId, startedAt);
  const health = getHealth();
  const usable = cleanChoices((await allChoices())[agentId] ?? []).filter(c => connected.has(c.connection) && (isFree(c.connection) || !over));
  // Its models in order, ones cooling down after a failure last.
  const order = [...usable.filter(c => !isBenched(health, c, startedAt)), ...usable.filter(c => isBenched(health, c, startedAt))];
  if (!order.length) throw new Error(`${name} has no model it can use. Connect one in Settings -> Connectors, or pick some on its card.`);

  const id = newRunId();
  exec('INSERT INTO runs (id, agent_id, trigger, task, ferocity, status, started_at) VALUES (?, ?, ?, ?, 0, ?, ?)', id, agentId, a.trigger, a.task, 'running', startedAt);
  let error = '';
  for (const c of order) {
    try {
      const r = await call(c, a.system, a.prompt, a.maxTokens ?? 2000);
      putHealth(recordSuccess(getHealth(), c));
      const cost = await costOf(c.connection, c.model, r.usage.input, r.usage.output);
      const summary = await Promise.resolve(a.summary(r.text)).catch(() => r.text.slice(0, 500));
      const endedAt = Date.now();
      exec(
        "UPDATE runs SET status = 'succeeded', ended_at = ?, connection = ?, model = ?, input_tokens = ?, output_tokens = ?, cost_usd = ?, summary = ? WHERE id = ?",
        endedAt, c.connection, c.model, r.usage.input, r.usage.output, cost, summary, id,
      );
      postRun(agentId, id, a.trigger, 'succeeded', cost, endedAt - startedAt, summary);
      return r.text;
    } catch (e) {
      putHealth(recordFailure(getHealth(), c));
      error = (e as Error).message;
    }
  }
  const endedAt = Date.now();
  exec("UPDATE runs SET status = 'failed', ended_at = ?, error = ? WHERE id = ?", endedAt, error, id);
  postRun(agentId, id, a.trigger, 'failed', null, endedAt - startedAt, `Run failed: ${error}`);
  throw new Error(error);
}

// The JSON object in a model's answer (models sometimes wrap it in prose).
export const jsonIn = <T>(text: string): T => JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as T;
