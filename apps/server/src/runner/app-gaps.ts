import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listIds, readMeta } from '../files.js';
import { providedByIntegration } from '../integrations/index.js';
import { sendReport } from '../integrations/report.js';
import { DATA_DIR } from '../paths.js';
import { all, one, run as exec } from './db.js';
import { servedHere, type ToolDef } from './tools.js';

// Gaps in the app itself (docs/requests.md, "When the app itself falls short").
// An agent that hits a limit of a built-in tool or of the runner - the browser
// can't pick from a dropdown, a cap stops real work, a run is scheduled wrong -
// dead-ended at "ask a person", and nobody babysits a customer's agency. The
// Agency Engineer or Doctor files it here instead: kept in full on this computer,
// and sent to our backend - which files it as an issue on the product's public
// repository - with only what is safe to make public. A fix the Engineer built
// here to get round it (an extension, a plugin) is reported too, so the official
// build gets it and every agency has it.

export const AREAS = ['browser', 'computer', 'web', 'runner', 'scheduler', 'caps', 'approvals', 'requests', 'connections', 'other'] as const;
export type Area = (typeof AREAS)[number];

type Row = {
  id: number;
  key: string;
  area: string;
  title: string;
  failed: string;
  fix: string;
  tools: string;
  fixed_here: string | null;
  agents: string;
  runs: string;
  request_id: number | null;
  seen: number;
  sent_at: number | null;
  created_at: number;
};

// The names this agency's own things go by - its agents, its organization, its
// people and their emails - so none of them ends up in a public issue.
export async function privateWords(): Promise<string[]> {
  const words = new Set<string>();
  for (const id of await listIds()) {
    const meta = await readMeta(id);
    if (meta && !meta.builtIn && !meta.service) words.add(meta.name);
  }
  for (const dir of ['orgs', 'people'])
    for (const f of await readdir(join(DATA_DIR, dir)).catch(() => [] as string[])) {
      if (!f.endsWith('.json')) continue;
      const d = JSON.parse(await readFile(join(DATA_DIR, dir, f), 'utf8').catch(() => '{}')) as Record<string, unknown>;
      for (const v of [d.name, d.full_name, d.email, ...(Array.isArray(d.people) ? (d.people as { name?: string }[]).map(p => p.name) : [])])
        if (typeof v === 'string' && v.trim()) words.add(v.trim());
    }
  // A full name's parts too ("Jane Doe": "Jane", "Doe"), when long enough to mean someone.
  for (const w of [...words]) for (const part of w.split(/\s+/)) if (part.length >= 4 && /^[A-Z]/.test(part)) words.add(part);
  return [...words].filter(w => w.length >= 3);
}

// What in a text can't go public: anything that could identify the organization,
// a person, an account or a key. Empty when it's safe. Refused rather than
// cleaned up - the Engineer rewrites it in general terms, so the report still reads.
export function problemsIn(text: string, words: string[]): string[] {
  const out: string[] = [];
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) out.push('an email address');
  else if (text.includes('@')) out.push('an @ (it would mention someone on the public issue)');
  if (text.includes('\\')) out.push('a backslash (a file path?)');
  if (/\b[a-z][a-z0-9+.-]*:\/\/\S+/i.test(text)) out.push('a web address (say what kind of site: "a directory\'s sign-up form")');
  if (/\b(?:www\.)?[a-z0-9-]+\.(?:com|net|org|io|ai|co|app|dev|agency|au|uk|de|eu)\b/i.test(text)) out.push('a site\'s name or domain');
  if (/[A-Za-z]:\\|(?:^|\s)~?\/(?:Users|home|var|tmp)\//.test(text)) out.push('a file path');
  if (/\b[A-Za-z0-9_-]{24,}\b/.test(text)) out.push('a long code (a key, an id or a token)');
  if (/\+?\d[\d ()-]{7,}\d/.test(text)) out.push('a phone or account number');
  const lower = text.toLowerCase();
  for (const w of words) {
    const re = new RegExp(`(^|[^a-z0-9])${w.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`);
    if (re.test(lower)) out.push(`"${w}" (this agency's own name for something, or someone's)`);
  }
  return [...new Set(out)];
}

// One per problem: the area and the app's tools involved, else its title.
const keyOf = (area: string, tools: string[], title: string) =>
  tools.length ? `${area}:${[...tools].sort().join(',')}` : `${area}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}`;

// What the agency's records show, for this computer only: how the tools did,
// and what the runs said.
function evidenceOf(tools: string[], agents: string[], runs: string[]): string {
  const lines: string[] = [];
  for (const h of all<{ agent_id: string; tool: string; last_ok: number | null; last_fail: number | null; last_error: string | null }>('SELECT * FROM tool_health'))
    if (tools.includes(h.tool) && (!agents.length || agents.includes(h.agent_id)))
      lines.push(`${h.tool} (${h.agent_id}): last ok ${h.last_ok ? new Date(h.last_ok).toISOString() : 'never'}; last failure ${h.last_fail ? new Date(h.last_fail).toISOString() : 'none'}${h.last_error ? `: ${h.last_error.slice(0, 300)}` : ''}`);
  for (const id of runs.slice(0, 10)) {
    const r = one<{ agent_id: string; status: string; summary: string | null; error: string | null }>('SELECT agent_id, status, summary, error FROM runs WHERE id = ?', id);
    if (r) lines.push(`run ${id} (${r.agent_id}, ${r.status}): ${(r.error || r.summary || '').replace(/\s+/g, ' ').slice(0, 400)}`);
  }
  return lines.join('\n');
}

// Only what's safe: the counts of agents and runs, never which.
const publicOf = (r: Row) => ({
  id: createHash('sha256').update(r.key).digest('hex').slice(0, 16),
  area: r.area,
  title: r.title,
  failed: r.failed,
  fix: r.fix,
  tools: JSON.parse(r.tools) as string[],
  fixed_here: r.fixed_here,
  seen: r.seen,
  agents: (JSON.parse(r.agents) as string[]).length,
  runs: (JSON.parse(r.runs) as string[]).length,
});

let backend: string | null | undefined; // tests: a stand-in for our backend
export const setBackendForTests = (url: string | null) => void (backend = url);
async function send(r: Row): Promise<boolean> {
  const ok = await (backend === undefined ? sendReport('/reports/app-gap', publicOf(r)) : sendReport('/reports/app-gap', publicOf(r), backend));
  if (ok) exec('UPDATE app_gaps SET sent_at = ? WHERE id = ?', Date.now(), r.id);
  return ok;
}

export type GapInput = {
  by: string;
  area: string;
  title: string;
  failed: string;
  fix: string;
  tools?: string[];
  fixedHere?: string | null;
  agents?: string[];
  runs?: string[];
  requestId?: number | null;
};

export async function fileGap(g: GapInput, now = Date.now()): Promise<{ id: number; repeat: boolean; sent: boolean; seen: number }> {
  const area = AREAS.includes(g.area as Area) ? g.area : 'other';
  const tools = [...new Set((g.tools ?? []).map(String))];
  const notOurs = tools.filter(t => !servedHere(t) || providedByIntegration(t));
  if (notOurs.length)
    throw new Error(`${notOurs.join(', ')} ${notOurs.length > 1 ? "aren't" : "isn't"} one of the app's own tools - a connection's tool failing is yours to fix (When a tool is failing), not the app's. Leave ${notOurs.length > 1 ? 'them' : 'it'} out.`);
  const title = g.title.trim().slice(0, 120);
  const failed = g.failed.trim().slice(0, 1500);
  const fix = g.fix.trim().slice(0, 1500);
  const fixedHere = g.fixedHere?.trim().slice(0, 1500) || null;
  if (!title || !failed || !fix) throw new Error('title, failed and fix are all needed.');
  const problems = problemsIn([title, failed, fix, fixedHere ?? ''].join('\n'), await privateWords());
  if (problems.length)
    throw new Error(
      `Not filed: this goes to the app's public issue list, and it has ${problems.join('; ')}. Say it in general terms - what kind of page, tool or job ("a directory's sign-up form with a native dropdown"), never whose - and file it again.`,
    );
  const key = keyOf(area, tools, title);
  const was = one<Row>('SELECT * FROM app_gaps WHERE key = ?', key);
  const agents = [...new Set([...(was ? (JSON.parse(was.agents) as string[]) : []), ...(g.agents ?? [])])];
  const runs = [...new Set([...(was ? (JSON.parse(was.runs) as string[]) : []), ...(g.runs ?? [])])];
  const evidence = evidenceOf(tools, agents, runs);
  if (was)
    exec(
      'UPDATE app_gaps SET seen = seen + 1, failed = ?, fix = ?, fixed_here = COALESCE(?, fixed_here), agents = ?, runs = ?, evidence = ?, request_id = COALESCE(?, request_id), updated_at = ? WHERE id = ?',
      failed,
      fix,
      fixedHere,
      JSON.stringify(agents),
      JSON.stringify(runs),
      evidence,
      g.requestId ?? null,
      now,
      was.id,
    );
  else
    exec(
      'INSERT INTO app_gaps (key, area, title, failed, fix, tools, fixed_here, evidence, agents, runs, request_id, by_agent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      key,
      area,
      title,
      failed,
      fix,
      JSON.stringify(tools),
      fixedHere,
      evidence,
      JSON.stringify(agents),
      JSON.stringify(runs),
      g.requestId ?? null,
      g.by,
      now,
      now,
    );
  const row = one<Row>('SELECT * FROM app_gaps WHERE key = ?', key)!;
  return { id: row.id, repeat: !!was, sent: await send(row), seen: row.seen };
}

// A fix built here for a reported gap went live (publish_integration): the report
// says so, so the official build takes it up. Said in general terms - the
// connection's own name may be this agency's.
export async function fixedHereFor(requestId: number, what: string): Promise<number[]> {
  const rows = all<Row>('SELECT * FROM app_gaps WHERE request_id = ? AND fixed_here IS NULL', requestId);
  const safe = problemsIn(what, await privateWords()).length ? 'A connection the Agency Engineer built here gets round it; it is live and working.' : what.slice(0, 1500);
  for (const r of rows) {
    exec('UPDATE app_gaps SET fixed_here = ?, updated_at = ? WHERE id = ?', safe, Date.now(), r.id);
    await send({ ...r, fixed_here: safe });
  }
  return rows.map(r => r.id);
}

// The gaps filed here, newest first, for the Engineer and Doctor to see before filing again.
export function gapsForPrompt(limit = 15): string {
  const rows = all<Row>('SELECT * FROM app_gaps ORDER BY updated_at DESC LIMIT ?', limit);
  return rows
    .map(r => `- gap #${r.id} [${r.area}] ${r.title} (seen ${r.seen}x${r.fixed_here ? '; fixed here' : ''}${r.sent_at ? '' : '; not sent yet'})${JSON.parse(r.tools).length ? ` tools: ${(JSON.parse(r.tools) as string[]).join(', ')}` : ''}`)
    .join('\n');
}

// Ones that didn't reach our backend (offline, or before it took them): again, now and then.
export async function resendUnsent(): Promise<number> {
  let n = 0;
  for (const r of all<Row>('SELECT * FROM app_gaps WHERE sent_at IS NULL OR sent_at < updated_at')) if (await send(r)) n++;
  return n;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'number', description });

// Reporting a gap in the app itself (app-gaps.ts) - the Engineer's, and the Doctor's under its own name.
export function appGapTool(id: string): ToolDef {
  return {
    id,
    tier: 'T1',
    description:
      "Report a gap in this app itself - one of its own tools, or the runner, falling short of real work - to the app's makers, so the official build is fixed for everyone. Also for a fix you built here to get round one (fixed_here), so the official build takes it up. Write it as a neutral bug report for an open-source project: it becomes an issue on the app's public GitHub repository, which anyone in the world can read. Describe only the app - which tool or part, what it does, what it should do, how to reproduce it with a made-up example - never this organization or its work: no names of the business, its people, customers or agents, no sites, accounts, emails, addresses, file paths, numbers or content from their work, and nothing about what they sell or who they contact - text that could identify anyone is refused. The same gap again is counted, not duplicated. Lists what's been filed.",
    schema: obj(
      {
        area: { type: 'string', enum: [...AREAS], description: 'Which part of the app' },
        title: str('One line: what the app can\'t do ("The browser can\'t pick from a native dropdown")'),
        failed: str('What failed and how often, as the records show it - in general terms'),
        fix: str('The fix the app needs, as precisely as you can (what the tool or the runner should do)'),
        tools: { type: 'array', items: { type: 'string' }, description: "The app's own tool ids involved (signed_in_browser.click), if any" },
        fixed_here: str('Optional: what you built or changed here to get round it, and how it works'),
        agents: { type: 'array', items: { type: 'string' }, description: 'The agents it hit (kept here, never sent)' },
        runs: { type: 'array', items: { type: 'string' }, description: 'Run ids that show it (kept here, never sent)' },
        request_id: int('The request it came from, if any: the report updates itself when your way round it goes live'),
      },
      ['area', 'title', 'failed', 'fix'],
    ),
    impl: async (a, ctx) => {
      const r = await fileGap({
        by: ctx.agent.id,
        area: String(a.area ?? ''),
        title: String(a.title ?? ''),
        failed: String(a.failed ?? ''),
        fix: String(a.fix ?? ''),
        tools: Array.isArray(a.tools) ? a.tools.map(String) : [],
        fixedHere: a.fixed_here ? String(a.fixed_here) : null,
        agents: Array.isArray(a.agents) ? a.agents.map(String) : [],
        runs: [...(Array.isArray(a.runs) ? a.runs.map(String) : []), ctx.runId],
        requestId: a.request_id ? Number(a.request_id) : null,
      });
      const sent = r.sent ? "sent to the app's makers" : "kept here; it goes to the app's makers when this copy can reach them";
      return `${r.repeat ? `Gap #${r.id} was filed already - counted again (seen ${r.seen}x) and` : `Filed gap #${r.id},`} ${sent}. Now get the agent working with a way round it.\nFiled so far:\n${gapsForPrompt()}`;
    },
  };
}
