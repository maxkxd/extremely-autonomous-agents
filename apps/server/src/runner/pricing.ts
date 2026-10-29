import { startOfDay } from './clock.js';
import { one } from './db.js';

// What a run cost (docs/runner.md, "Money and limits"). OpenRouter's public
// model list is the price book: it prices most providers' models under their
// own names. A plan's run (Claude Code, ChatGPT) is priced as the same model on
// an API would be - more than it really costs, but it shows what the plan is
// worth and keeps spend limits on the safe side. Local models cost nothing. A
// price we can't find is recorded as unknown, never as zero.

type Price = { input: number; output: number }; // dollars per token
let book: Map<string, Price> | null = null;
let fetchedAt = 0;
const DAY = 86_400_000;

async function loadBook(): Promise<Map<string, Price>> {
  if (book && Date.now() - fetchedAt < DAY) return book;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(20_000) });
    const j = (await res.json()) as { data?: { id: string; pricing?: { prompt?: string; completion?: string } }[] };
    const next = new Map<string, Price>();
    for (const m of j.data ?? []) {
      const input = Number(m.pricing?.prompt);
      const output = Number(m.pricing?.completion);
      if (Number.isFinite(input) && Number.isFinite(output) && input >= 0 && output >= 0) next.set(m.id.replace(/^~/, ''), { input, output });
    }
    if (next.size) {
      book = next;
      fetchedAt = Date.now();
    }
  } catch {
    // Offline: keep the last book (or none).
  }
  return book ?? new Map();
}

// The provider prefix OpenRouter files each connection's models under.
const PREFIX: Record<string, string> = {
  anthropic: 'anthropic',
  'claude-code': 'anthropic',
  openai: 'openai',
  chatgpt: 'openai',
  google: 'google',
  xai: 'x-ai',
  mistral: 'mistralai',
  deepseek: 'deepseek',
};
// Not paid per call: they run past a spend limit.
const FREE = new Set(['claude-code', 'chatgpt', 'copilot', 'ollama']);

export const isFree = (connection: string) => FREE.has(connection);

// Candidate OpenRouter ids for a model: exact, with dots for version dashes
// (claude-opus-5-5 -> claude-opus-5.5), and without a date suffix.
// A model the provider names by its family alone (deepseek-flash) is filed
// as the family's "-latest" (deepseek/deepseek-flash-latest).
function candidates(connection: string, model: string): string[] {
  // OpenRouter's own ids; Groq names its models the same way (openai/gpt-oss-120b) - its own
  // prices are close to OpenRouter's, near enough for a spend estimate.
  // (The book drops the "~" OpenRouter puts on its moving aliases, like ~anthropic/claude-opus-latest.)
  if (connection === 'openrouter' || connection === 'groq') return [model.replace(/^~/, '')];
  const prefix = PREFIX[connection];
  if (!prefix) return [];
  const bare = model.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const dotted = bare.replace(/-(\d+)-(\d+)$/, '-$1.$2');
  const unaliased = bare.replace(/-latest$/, '');
  return [...new Set([model, bare, dotted, `${bare}-latest`, unaliased].map(m => `${prefix}/${m}`))];
}

// Dollars for one model call; null when the price isn't known.
export async function costOf(connection: string, model: string, input: number, output: number): Promise<number | null> {
  if (connection === 'ollama') return 0;
  const prices = await loadBook();
  for (const id of candidates(connection, model)) {
    const p = prices.get(id);
    if (p) return input * p.input + output * p.output;
  }
  return null;
}

// --- Spend caps (Settings -> Usage) ------------------------------------------

// Days start at the host's midnight (clock.ts).
export { startOfDay };

export function spentToday(now: number, agentId?: string): number {
  const since = startOfDay(now);
  const row = agentId
    ? one<{ s: number | null }>('SELECT SUM(cost_usd) AS s FROM runs WHERE agent_id = ? AND started_at >= ?', agentId, since)
    : one<{ s: number | null }>('SELECT SUM(cost_usd) AS s FROM runs WHERE started_at >= ?', since);
  return row?.s ?? 0;
}
