import { all, one, run } from './db.js';

// An agent's own memory between runs (docs/runner.md, "Agent memory").
// Separate from the person and organisation profiles (org.ts).
//   - kept as written, given newest first with each one's age
//   - tool status never comes from memory: notes that a tool is broken are
//     refused, because the runner's live record says whether it works
//   - past a cap, the oldest notes are compacted into a dated summary that
//     ranks below everything recent

export const CAP_NOTES = 120; // compact once there are more notes than this
export const KEEP_NOTES = 80; // ...down to this many newest ones
const PROMPT_CHARS = 8_000; // most of the memory a run is given

type Row = { id: number; text: string; kind: 'note' | 'compacted'; from_at: number | null; to_at: number | null; created_at: number };

const FAILURE = /\b(doesn'?t|does not|didn'?t|did not|won'?t|isn'?t|is not|not)\s+(work|working|available|connected)|\b(broken|fail(s|ed|ing|ure)?|errors?|erroring|unavailable|unusable|can'?t use|cannot use|no access)\b/i;

// A note claiming one of its tools doesn't work. tools: the agent's tool ids.
export function isToolFailureNote(text: string, tools: string[]): boolean {
  if (!FAILURE.test(text)) return false;
  const t = text.toLowerCase();
  return /\btool\b/.test(t) || tools.some(id => t.includes(id.toLowerCase()) || t.includes(id.split('.').pop()!.toLowerCase()));
}

export function remember(agentId: string, text: string, tools: string[], now = Date.now()): { ok: boolean; message: string } {
  const note = text.trim();
  if (!note) return { ok: false, message: 'Nothing to remember.' };
  if (isToolFailureNote(note, tools))
    return {
      ok: false,
      message:
        "Not saved: don't record whether a tool works. The runner tracks every tool's real status and gives it to you at the start of each run, so a note like this would only go stale once the tool is fixed. If a tool is blocking you, file a request (requests.request_resource) instead.",
    };
  run('INSERT INTO memories (agent_id, text, kind, created_at) VALUES (?, ?, ?, ?)', agentId, note.slice(0, 2000), 'note', now);
  return { ok: true, message: 'Remembered.' };
}

export function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d} day${d === 1 ? '' : 's'} ago`;
  return `${Math.round(d / 30)} months ago`;
}

const date = (t: number) => new Date(t).toISOString().slice(0, 10);

// The memory a run is given: newest notes first with their ages, then the
// compacted summaries of older ones.
export function memoryForPrompt(agentId: string, now = Date.now()): string {
  const notes = all<Row>("SELECT * FROM memories WHERE agent_id = ? AND kind = 'note' ORDER BY created_at DESC, id DESC", agentId);
  const older = all<Row>("SELECT * FROM memories WHERE agent_id = ? AND kind = 'compacted' ORDER BY to_at DESC", agentId);
  if (!notes.length && !older.length) return 'Nothing yet.';
  const lines: string[] = [];
  let used = 0;
  for (const n of notes) {
    const line = `- (${ago(now - n.created_at)}) ${n.text}`;
    if (used + line.length > PROMPT_CHARS) break;
    lines.push(line);
    used += line.length;
  }
  for (const c of older) lines.push(`- Earlier, ${date(c.from_at ?? c.created_at)} to ${date(c.to_at ?? c.created_at)} (summary, ranks below everything above): ${c.text}`);
  return lines.join('\n');
}

// Compacts the oldest notes once there are more than CAP_NOTES. summarize is
// given the old notes and the newer ones (so it can leave out anything a
// newer note contradicts) and returns the summary text.
export async function compactIfNeeded(
  agentId: string,
  summarize: (oldNotes: string[], newer: string[]) => Promise<string>,
  now = Date.now(),
): Promise<boolean> {
  const notes = all<Row>("SELECT * FROM memories WHERE agent_id = ? AND kind = 'note' ORDER BY created_at ASC, id ASC", agentId);
  if (notes.length <= CAP_NOTES) return false;
  const old = notes.slice(0, notes.length - KEEP_NOTES);
  const newer = notes.slice(notes.length - KEEP_NOTES);
  const summary = (await summarize(
    old.map(n => `(${date(n.created_at)}) ${n.text}`),
    newer.map(n => `(${date(n.created_at)}) ${n.text}`),
  )).trim();
  if (!summary) return false;
  run(
    'INSERT INTO memories (agent_id, text, kind, from_at, to_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    agentId,
    summary.slice(0, 6000),
    'compacted',
    old[0].created_at,
    old[old.length - 1].created_at,
    now,
  );
  run(`DELETE FROM memories WHERE id IN (${old.map(() => '?').join(',')})`, ...old.map(n => n.id));
  return true;
}

export const COMPACT_PROMPT = `You compact an AI agent's oldest memory notes into one short summary it will read at the start of future runs.
Keep what is still useful for doing its job: facts about the work, people and preferences, what has been done (so it isn't redone), and lessons about how to do the job well.
Leave out anything a NEWER note contradicts - newer notes are true. Leave out claims that a tool doesn't work. Leave out runs that found nothing to do.
Plain sentences, no headings, under 250 words.`;

export const noteCount = (agentId: string) =>
  one<{ n: number }>("SELECT COUNT(*) AS n FROM memories WHERE agent_id = ? AND kind = 'note'", agentId)?.n ?? 0;
