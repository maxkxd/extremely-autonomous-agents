import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { DATA, readMeta, slug, writeMeta } from '../files.js';
import { countsAsOutput } from './agent.js';
import { servedHere } from './tools.js';

// A connection's own tools replace the names an agent was built with (a catalogue
// stand-in, crm.create_record, or the builder's guess). The call then succeeds
// and counts for nothing, because output is an exact tool id. This points the
// KPI and the ferocity counts at the real ids when they are the same action.
// An MCP server names its own tools; they are not renamed back.

export type OutputMove = { from: string; to: string[]; label?: string };

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// The action, without its server and without that server's name repeated on
// the tool (zoho-crm.zohocrm_createrecords and crm.create_record are both
// "createrecord(s)").
export function actionStem(id: string): string {
  const dot = id.indexOf('.');
  const server = dot < 0 ? '' : id.slice(0, dot);
  const action = dot < 0 ? id : id.slice(dot + 1);
  let stem = compact(action);
  const prefix = compact(server);
  if (prefix && stem.startsWith(prefix) && stem.length > prefix.length) stem = stem.slice(prefix.length);
  return stem;
}

// Same action, including the batch form (create_record and createrecords).
// A longer different word is not the same (get_record and get_record_count).
export function sameAction(a: string, b: string): boolean {
  const x = actionStem(a);
  const y = actionStem(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return long === `${short}s` || long === `${short}es`;
}

type Row = { action: string; label: string };

// Which real tools do the job of each name the agent is counted on but doesn't hold.
export function movesFor(orphans: string[], candidates: string[]): OutputMove[] {
  const moves: OutputMove[] = [];
  for (const from of orphans) {
    const to = [...new Set(candidates.filter(id => id !== from && sameAction(from, id)))].sort((a, b) => {
      const ae = actionStem(a) === actionStem(from) ? 0 : 1;
      const be = actionStem(b) === actionStem(from) ? 0 : 1;
      return ae - be || a.localeCompare(b);
    });
    if (to.length) moves.push({ from, to });
  }
  return moves;
}

async function readCounted(agentId: string): Promise<{ output: Row[]; counts: string[]; held: Set<string> }> {
  const dir = join(DATA, slug(agentId));
  const kpiDoc = parseDocument(await readFile(join(dir, 'KPI.yaml'), 'utf8'));
  const toolsDoc = parseDocument(await readFile(join(dir, 'TOOLS.yaml'), 'utf8'));
  const output = ((kpiDoc.get('output') as { toJSON(): Row[] } | undefined)?.toJSON() ?? []) as Row[];
  const counts = ((toolsDoc.getIn(['ferocity', 'counts']) as { toJSON(): string[] } | undefined)?.toJSON() ?? []) as string[];
  const tiers = ((toolsDoc.get('tool_tiers') as { toJSON(): Record<string, string> } | undefined)?.toJSON() ?? {}) as Record<string, string>;
  const allowed = ((toolsDoc.get('tools_allowed') as { toJSON(): string[] } | undefined)?.toJSON() ?? []) as string[];
  return { output, counts, held: new Set([...Object.keys(tiers), ...allowed]) };
}

function apply(output: Row[], counts: string[], moves: OutputMove[]): { output: Row[]; counts: string[] } {
  const byFrom = new Map(moves.map(m => [m.from, m]));
  const nextOutput = output.flatMap(row => {
    const m = byFrom.get(row.action);
    if (!m) return [row];
    const label = m.label?.trim() || row.label;
    return m.to.map(action => ({ action, label }));
  });
  const seen = new Set<string>();
  const rows = nextOutput.filter(r => (seen.has(r.action) ? false : (seen.add(r.action), true)));
  const nextCounts = [
    ...new Set(
      counts.flatMap(c => {
        const m = byFrom.get(c);
        return m ? m.to : [c];
      }),
    ),
  ];
  return { output: rows, counts: nextCounts };
}

// Writes the moves. Refuses a destination that isn't output, or that this agent
// doesn't hold (a built-in it can call is held by the app). The old id has to
// be one it is actually counted on.
export async function applyOutputMoves(agentId: string, moves: OutputMove[]): Promise<void> {
  if (!moves.length) return;
  const dir = join(DATA, slug(agentId));
  const { output, counts, held } = await readCounted(agentId);
  const present = new Set([...output.map(o => o.action), ...counts]);
  for (const m of moves) {
    if (!present.has(m.from)) throw new Error(`${m.from} isn't what ${agentId} is counted on.`);
    if (!m.to.length) throw new Error(`${m.from}: name the real tool.`);
    for (const id of m.to) {
      if (!countsAsOutput(id)) throw new Error(`${id} isn't output. Workspace files, memory and plumbing don't count.`);
      if (!held.has(id) && !servedHere(id)) throw new Error(`${id} isn't a tool ${agentId} holds.`);
    }
  }
  const next = apply(output, counts, moves);
  const kpiDoc = parseDocument(await readFile(join(dir, 'KPI.yaml'), 'utf8'));
  kpiDoc.set('output', next.output);
  await writeFile(join(dir, 'KPI.yaml'), kpiDoc.toString());
  const toolsDoc = parseDocument(await readFile(join(dir, 'TOOLS.yaml'), 'utf8'));
  if (toolsDoc.get('ferocity')) toolsDoc.setIn(['ferocity', 'counts'], next.counts);
  await writeFile(join(dir, 'TOOLS.yaml'), toolsDoc.toString());
  const meta = await readMeta(agentId);
  if (meta) await writeMeta(agentId, { ...meta, output: [...new Set(next.output.map(o => o.label))] });
}

// After a connection's real tools are given and its stand-in names dropped:
// move the count onto the real tools that are the same action. Names with no
// match are left, for the Agency Engineer (engineer.retarget_output). Past
// calls stay as they were recorded: a call's arguments aren't kept, so a batch
// from before this can't be recounted from the ledger.
export async function retargetOutput(agentId: string, candidates: string[]): Promise<{ moves: OutputMove[]; unmatched: string[] }> {
  const { output, counts, held } = await readCounted(agentId);
  const named = [...new Set([...output.map(o => o.action), ...counts])];
  const orphans = named.filter(id => id && !held.has(id) && !servedHere(id));
  const moves = movesFor(orphans, candidates);
  const unmatched = orphans.filter(id => !moves.some(m => m.from === id));
  if (moves.length) await applyOutputMoves(agentId, moves);
  return { moves, unmatched };
}
