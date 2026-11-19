import { accountOf } from './action-queue.js';
import { hostZone, startOfMonth } from './clock.js';
import { all } from './db.js';

// What the agency MCP's tools show, kept small enough for an AI app to read
// (decided 2026-11-19, after read_agent returned 80,000 characters for one agent
// and overflowed the app): sections of a file on request, one short line per
// approval, and spend from the same rows Settings > Usage adds up.

// --- Size ---------------------------------------------------------------------

// No answer longer than this; a longer one is cut, and says exactly how to get the rest.
export const MAX_RESULT_CHARS = 20_000;
// Long by nature, and read whole by whoever asks (the builder's brief, a plugin's code).
const UNCAPPED = new Set(['builder_guide', 'read_integration']);
const HOW_MORE: Record<string, string> = {
  read_agent: 'ask for one section (section: charter | tools | kpi | runs | memory), a Charter heading (heading), or the next window (offset)',
  agent_activity: 'pass a smaller limit, include_tools: false, or until (older posts)',
  list_approvals: 'pass a smaller limit, the next offset, or filter by agent_id / tool / account; detail: false keeps it to one line each',
  list_requests: 'filter by agent_id or pass a smaller limit',
  agency_today: 'pass a later since',
  list_queue: 'filter by agent_id, tool or account',
};
export function capResult(tool: string, text: string): string {
  if (UNCAPPED.has(tool) || text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n[Cut at ${MAX_RESULT_CHARS.toLocaleString('en')} of ${text.length.toLocaleString('en')} characters. For the rest, ${HOW_MORE[tool] ?? 'narrow the call'}.]`;
}

// --- Markdown sections ----------------------------------------------------------

export type Heading = { level: number; text: string; start: number; end: number };

// Every heading of a Markdown file (not ones inside code fences), with where its
// section starts (its heading line) and ends (the next heading at its level or above).
export function headingsOf(md: string): Heading[] {
  const out: Heading[] = [];
  let fenced = false;
  let at = 0;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const m = !fenced && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], start: at, end: md.length });
    at += line.length + 1;
  }
  for (let i = 0; i < out.length; i++) {
    const next = out.slice(i + 1).find(h => h.level <= out[i].level);
    if (next) out[i].end = next.start;
  }
  return out;
}

// The one heading meant: an exact match (any case), else the only one containing it.
export function findHeading(md: string, wanted: string): Heading {
  const hs = headingsOf(md);
  const w = wanted.trim().replace(/^#+\s*/, '').toLowerCase();
  const exact = hs.filter(h => h.text.toLowerCase() === w);
  if (exact.length === 1) return exact[0];
  const near = exact.length ? exact : hs.filter(h => h.text.toLowerCase().includes(w));
  if (near.length === 1) return near[0];
  if (!near.length) throw new Error(`No heading "${wanted}". Its headings: ${hs.map(h => h.text).join(' | ') || 'none'}.`);
  throw new Error(`"${wanted}" matches ${near.length} headings: ${near.map(h => `${'#'.repeat(h.level)} ${h.text}`).join(' | ')}. Use the whole heading.`);
}

export const outlineOf = (md: string) => headingsOf(md).map(h => `${'  '.repeat(h.level - 1)}${'#'.repeat(h.level)} ${h.text} (${(h.end - h.start).toLocaleString('en')} chars)`);

// A window of a long text, saying where it sits and how to get the next one.
export function windowOf(text: string, offset: unknown, limit: unknown, what: string): string {
  const from = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.max(500, Math.min(MAX_RESULT_CHARS - 500, Math.floor(Number(limit) || 15_000)));
  if (from >= text.length && text.length) throw new Error(`${what} is ${text.length.toLocaleString('en')} characters; offset ${from} is past the end.`);
  const part = text.slice(from, from + size);
  const end = from + part.length;
  return end < text.length || from > 0
    ? `${part}\n\n[${what}: characters ${from}-${end} of ${text.length}.${end < text.length ? ` Next: offset ${end}.` : ' That is the end.'}]`
    : part;
}

// --- Edits to a file --------------------------------------------------------------

export type Edit = { old: string; new: string };
export function applyEdits(text: string, edits: Edit[]): string {
  let out = text;
  edits.forEach((e, i) => {
    const old = String(e.old ?? '');
    if (!old) throw new Error(`Edit ${i + 1}: old is empty.`);
    const n = out.split(old).length - 1;
    if (n !== 1) throw new Error(`Edit ${i + 1}: old text ${n ? `matches ${n} places` : 'isn’t in the file'} - it must match exactly once. Nothing was saved.`);
    out = out.replace(old, () => String(e.new ?? ''));
  });
  return out;
}

export type SectionMode = 'replace' | 'append' | 'insert_after' | 'delete';
// replace: the section's body (its heading line stays); append: at its end;
// insert_after: a new section (content carries its own heading) after it;
// delete: the section, heading and all. No heading: append adds to the end of the file.
export function editSection(md: string, heading: string | null, content: string, mode: SectionMode): string {
  const body = content.replace(/\s+$/, '');
  if (!heading) {
    if (mode !== 'append') throw new Error('Without a heading, only mode: append (to the end of the file).');
    return `${md.replace(/\s+$/, '')}\n\n${body}\n`;
  }
  const h = findHeading(md, heading);
  const headLine = md.slice(h.start, md.indexOf('\n', h.start) === -1 ? md.length : md.indexOf('\n', h.start) + 1);
  const section = md.slice(h.start, h.end);
  const tail = section.match(/\s*$/)?.[0] || '\n';
  const sep = tail.includes('\n\n') ? tail : '\n\n';
  const before = md.slice(0, h.start);
  const after = md.slice(h.end);
  if (mode === 'delete') return before + after;
  if (mode === 'replace') return `${before}${headLine.replace(/\n?$/, '\n')}\n${body}${sep}${after}`;
  if (mode === 'append') return `${before}${section.replace(/\s+$/, '')}\n\n${body}${sep}${after}`;
  if (mode === 'insert_after') return `${before}${section.replace(/\s+$/, '')}\n\n${body}${sep}${after}`;
  throw new Error('mode is replace, append, insert_after or delete.');
}

// What changed, in a line: how many lines went and came.
export function diffLine(before: string, after: string): string {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const gone = a.length - s - e;
  const came = b.length - s - e;
  if (!gone && !came) return 'No change.';
  return `Changed from line ${s + 1}: ${gone} line${gone === 1 ? '' : 's'} out, ${came} in (${before.length.toLocaleString('en')} → ${after.length.toLocaleString('en')} characters).`;
}

// --- Approvals, one line each -------------------------------------------------------

export type PendingRow = { id: string; agent_id: string; tool: string; args: string; expires_at: number };
const firstString = (o: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string') return v.join(', ');
  }
  return null;
};
// The args an approval acts on: a send's body is often nested under "body".
export function flatArgs(args: Record<string, unknown>): Record<string, unknown> {
  const inner = args.body && typeof args.body === 'object' && !Array.isArray(args.body) ? (args.body as Record<string, unknown>) : {};
  return { ...args, ...inner };
}
// The account the runner paces and queues it under - exactly as approvals.ts works
// it out (top-level arguments only), so a pace set here is the one it follows. A
// send whose sender sits deeper (Zoho's body.fromAddress) is its tool's one account:
// right for a rate limit, as those mailboxes are aliases of one sending account.
export const approvalAccount = (args: Record<string, unknown>) => {
  const { _why: _w, ...rest } = args;
  return accountOf(rest);
};
// Who it's sent as, for people to read (wherever it sits).
export const senderOf = (args: Record<string, unknown>) => {
  const { _why: _w, ...rest } = flatArgs(args);
  return accountOf(rest).replace(/^.*<([^>]+)>.*$/, '$1') || null;
};
// An account filter as a person types it: the runner's account, or the sender.
export const matchesAccount = (args: Record<string, unknown>, wanted: string | null) => !wanted || approvalAccount(args) === wanted || senderOf(args) === wanted;
export function approvalLine(r: PendingRow, agentName: string) {
  const args = JSON.parse(r.args) as Record<string, unknown>;
  const f = flatArgs(args);
  const to = firstString(f, ['toAddress', 'to', 'to_address', 'recipient', 'email', 'channel', 'channel_id', 'company', 'name']);
  const what = firstString(f, ['subject', 'title', 'text', 'content', 'message', 'body']);
  const why = typeof args._why === 'string' ? args._why : null;
  return {
    id: r.id,
    agent: `${agentName} (${r.agent_id})`,
    tool: r.tool,
    from: senderOf(args),
    queue_account: approvalAccount(args) || '(its one account)',
    to,
    what: what ? (what.length > 100 ? `${what.slice(0, 100)}…` : what).replace(/\s+/g, ' ') : null,
    why: why ? (why.length > 160 ? `${why.slice(0, 160)}…` : why) : null,
    expires: new Date(r.expires_at).toISOString(),
  };
}

// --- Spend ----------------------------------------------------------------------------

export const COST_NOTE =
  "Costs are what each run recorded (runs.cost_usd). A run on a Claude, ChatGPT or Copilot plan is priced as the same model on its API, and counts toward the limits; Ollama is $0. unpriced_runs are runs whose model has no known price: their cost is missing, not zero. Limits are monthly, from the 1st on the agency's clock.";

export type RunCost = { agent_id: string; started_at: number; cost_usd: number | null; input_tokens: number; output_tokens: number; model: string | null; connection: string | null; trigger: string };
export const GROUPS = ['agent', 'day', 'model', 'connection', 'trigger'] as const;
export type Group = (typeof GROUPS)[number];

export function spendRows(since: number, until: number, agentId?: string | null) {
  return all<RunCost>(
    `SELECT agent_id, started_at, cost_usd, input_tokens, output_tokens, model, connection, trigger FROM runs WHERE started_at >= ? AND started_at < ?${agentId ? ' AND agent_id = ?' : ''}`,
    ...(agentId ? [since, until, agentId] : [since, until]),
  );
}

export type SpendTotal = { cost_usd: number; runs: number; unpriced_runs: number; input_tokens: number; output_tokens: number };
const blank = (): SpendTotal => ({ cost_usd: 0, runs: 0, unpriced_runs: 0, input_tokens: 0, output_tokens: 0 });
const add = (t: SpendTotal, r: RunCost) => {
  t.runs++;
  if (r.cost_usd == null) t.unpriced_runs++;
  else t.cost_usd += r.cost_usd;
  t.input_tokens += r.input_tokens;
  t.output_tokens += r.output_tokens;
};
export const roundUsd = (n: number) => Math.round(n * 10_000) / 10_000;
const tidy = (t: SpendTotal): SpendTotal => ({ ...t, cost_usd: roundUsd(t.cost_usd) });

export function spendBy(rows: RunCost[], group: Group) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: hostZone(), year: 'numeric', month: '2-digit', day: '2-digit' });
  const keyOf = (r: RunCost) =>
    group === 'agent' ? r.agent_id : group === 'day' ? day.format(new Date(r.started_at)) : group === 'model' ? (r.model ?? 'unknown') : group === 'connection' ? (r.connection ?? 'unknown') : r.trigger;
  const total = blank();
  const by = new Map<string, SpendTotal>();
  for (const r of rows) {
    add(total, r);
    const k = keyOf(r);
    if (!by.has(k)) by.set(k, blank());
    add(by.get(k)!, r);
  }
  const groups = [...by.entries()].map(([key, t]) => ({ key, ...tidy(t) }));
  groups.sort((a, b) => (group === 'day' ? a.key.localeCompare(b.key) : b.cost_usd - a.cost_usd || b.runs - a.runs));
  return { total: tidy(total), groups };
}

// Per agent, this calendar month: what its limit is measured against.
export function monthSpendByAgent(now: number) {
  const out = new Map<string, SpendTotal>();
  for (const r of spendRows(startOfMonth(now), now + 1)) {
    if (!out.has(r.agent_id)) out.set(r.agent_id, blank());
    add(out.get(r.agent_id)!, r);
  }
  return new Map([...out.entries()].map(([k, t]) => [k, tidy(t)]));
}
