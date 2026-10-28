import { one } from './db.js';

// What a run cost (docs/runner.md, "Money and limits"). Plans and local
// models cost nothing per run. For pay-per-use keys, OpenRouter's public model
// list is the price book: it prices most providers' models under their own
// names. A price we can't find is recorded as unknown, never as zero.

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
  openai: 'openai',
  google: 'google',
  xai: 'x-ai',
  mistral: 'mistralai',
  deepseek: 'deepseek',
};
const FREE = new Set(['claude-code', 'chatgpt', 'copilot', 'ollama']);

export const isFree = (connection: string) => FREE.has(connection);

// Candidate OpenRouter ids for a model: exact, with dots for version dashes
// (claude-opus-5-5 -> claude-opus-5.5), and without a date suffix.
function candidates(connection: string, model: string): string[] {
  if (connection === 'openrouter') return [model];
  const prefix = PREFIX[connection];
  if (!prefix) return [];
  const bare = model.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const dotted = bare.replace(/-(\d+)-(\d+)$/, '-$1.$2');
  return [...new Set([model, bare, dotted].map(m => `${prefix}/${m}`))];
}

// Dollars for one model call; null when the price isn't known.
export async function costOf(connection: string, model: string, input: number, output: number): Promise<number | null> {
  if (FREE.has(connection)) return 0;
  const prices = await loadBook();
  for (const id of candidates(connection, model)) {
    const p = prices.get(id);
    if (p) return input * p.input + output * p.output;
  }
  return null;
}

// --- Spend caps (Settings -> Usage) ------------------------------------------

export const startOfDay = (now: number) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export function spentToday(now: number, agentId?: string): number {
  const since = startOfDay(now);
  const row = agentId
    ? one<{ s: number | null }>('SELECT SUM(cost_usd) AS s FROM runs WHERE agent_id = ? AND started_at >= ?', agentId, since)
    : one<{ s: number | null }>('SELECT SUM(cost_usd) AS s FROM runs WHERE started_at >= ?', since);
  return row?.s ?? 0;
}
