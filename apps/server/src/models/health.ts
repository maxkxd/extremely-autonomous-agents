import type { ModelChoice } from './choice.js';

// Falling back between an agent's models (docs/model-connections.md).
//
// When a model fails to run (plan limit hit, key broken, provider down), it's
// benched for a while and the agent uses its next choice. Each failure in a
// row doubles the bench time - 2, 4, 8, 16, 32 minutes, then an hour at most -
// and one success clears it. Pure functions over a plain record, so the
// runner can keep the record wherever it likes and these stay easy to test.

export const FIRST_BENCH_MS = 2 * 60_000;
export const MAX_BENCH_MS = 60 * 60_000;

export type Health = Record<string, { failures: number; benchedUntil: number }>;

export const choiceKey = (c: Pick<ModelChoice, 'connection' | 'model'>) => `${c.connection}/${c.model}`;

export function benchFor(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(FIRST_BENCH_MS * 2 ** (failures - 1), MAX_BENCH_MS);
}

export function recordFailure(h: Health, c: ModelChoice, now = Date.now()): Health {
  const key = choiceKey(c);
  const failures = (h[key]?.failures ?? 0) + 1;
  return { ...h, [key]: { failures, benchedUntil: now + benchFor(failures) } };
}

export function recordSuccess(h: Health, c: ModelChoice): Health {
  const key = choiceKey(c);
  if (!h[key]) return h;
  const next = { ...h };
  delete next[key];
  return next;
}

export const isBenched = (h: Health, c: ModelChoice, now = Date.now()) => (h[choiceKey(c)]?.benchedUntil ?? 0) > now;

// The model to run now: the first choice that's connected and not benched.
// If every connected choice is benched, the one that comes back soonest -
// better to try than to stop. Null only when none of them is connected.
export function pickModel(
  choices: ModelChoice[],
  h: Health,
  isConnected: (connection: string) => boolean,
  now = Date.now(),
): { choice: ModelChoice; rank: number } | null {
  const usable = choices.map((choice, rank) => ({ choice, rank })).filter(x => isConnected(x.choice.connection));
  if (!usable.length) return null;
  const ready = usable.find(x => !isBenched(h, x.choice, now));
  if (ready) return ready;
  return usable.reduce((a, b) => ((h[choiceKey(a.choice)]?.benchedUntil ?? 0) <= (h[choiceKey(b.choice)]?.benchedUntil ?? 0) ? a : b));
}
