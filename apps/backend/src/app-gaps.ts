import type { Db } from './db.js';

// Gaps in the app itself, from anyone's agency (apps/server runner/app-gaps.ts):
// one of its built-in tools or the runner falling short of real work, found by
// the Agency Engineer or Doctor - or a fix it built there to get round one. Each
// is kept here and filed as an issue on the product's repository, so the official
// build gets fixed. The app sends only general terms and counts, and this checks
// again: anyone may post, and what's posted becomes public.

export const AREAS = ['browser', 'computer', 'web', 'runner', 'scheduler', 'caps', 'approvals', 'requests', 'connections', 'other'];

export type Gap = { id: string; area: string; title: string; failed: string; fix: string; tools: string[]; fixed_here: string | null; seen: number; agents: number; runs: number };

// No email, address, path, @mention or long code; plain short text.
const safeText = (v: unknown, max: number) => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/@|:\/\/|\\|[A-Za-z0-9_-]{24,}/.test(v);
const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;

export function checkGap(b: Record<string, unknown>): Gap | string {
  if (typeof b.id !== 'string' || !/^[0-9a-f]{16}$/.test(b.id)) return 'id';
  if (typeof b.area !== 'string' || !AREAS.includes(b.area)) return 'area';
  for (const [k, max] of [['title', 120], ['failed', 1500], ['fix', 1500]] as const) if (!safeText(b[k], max)) return k;
  if (b.fixed_here != null && !safeText(b.fixed_here, 1500)) return 'fixed_here';
  if (!Array.isArray(b.tools) || b.tools.length > 10 || !b.tools.every(t => typeof t === 'string' && /^[a-z_]{1,30}\.[a-z_]{1,40}$/.test(t))) return 'tools';
  for (const k of ['seen', 'agents', 'runs']) if (!count(b[k])) return k;
  return { id: b.id, area: b.area, title: b.title as string, failed: b.failed as string, fix: b.fix as string, tools: b.tools as string[], fixed_here: (b.fixed_here as string | null) ?? null, seen: b.seen as number, agents: b.agents as number, runs: b.runs as number };
}

// Where issues go: the product's repository, with a token that may open issues on it.
// No token (development, or not set up yet): kept here only.
type GitHub = { token: string; repo: string; fetch: typeof fetch };
let github: () => GitHub | null = () => {
  const token = process.env.GITHUB_ISSUES_TOKEN?.trim();
  return token ? { token, repo: process.env.GITHUB_ISSUES_REPO?.trim() || 'maxkxd/extremely-autonomous-agents', fetch } : null;
};
export const setGitHubForTests = (g: GitHub | null) => void (github = () => g);

async function gh(g: GitHub, method: string, path: string, body: unknown): Promise<Record<string, unknown> | null> {
  try {
    const r = await g.fetch(`https://api.github.com/repos/${g.repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${g.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'extremely-agency-backend' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    return r.ok ? ((await r.json()) as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const issueBody = (g: Gap, reports: number) =>
  [
    `**Area:** ${g.area}${g.tools.length ? ` · **Tools:** ${g.tools.map(t => `\`${t}\``).join(', ')}` : ''}`,
    `### What failed\n${g.failed}`,
    `### Fix the app needs\n${g.fix}`,
    g.fixed_here && `### Fixed in an agency (take it into the official build)\n${g.fixed_here}`,
    `_Reported by the Agency Engineer or Doctor in ${reports === 1 ? 'one agency' : `${reports} reports`}; seen ${g.seen}x there, across ${g.agents} agent(s) and ${g.runs} run(s). Filed automatically (docs/requests.md, "When the app itself falls short")._`,
  ]
    .filter(Boolean)
    .join('\n\n');

// Comments on an issue only when it's news: fixed somewhere, or reported again at 2, 5, 10, 25, then every 50.
const milestone = (n: number) => [2, 5, 10, 25].includes(n) || n % 50 === 0;

export async function takeGap(db: Db, g: Gap, now = Date.now()): Promise<{ issue: number | null }> {
  const was = (await db.query<{ reports: number; issue: number | null; fixed_here: string | null }>('SELECT reports, issue, fixed_here FROM app_gaps WHERE id = $1', [g.id])).rows[0];
  const reports = (was?.reports ?? 0) + 1;
  if (was)
    await db.query('UPDATE app_gaps SET reports = $2, failed = $3, fix = $4, fixed_here = COALESCE($5, fixed_here), last_at = $6 WHERE id = $1', [g.id, reports, g.failed, g.fix, g.fixed_here, now]);
  else
    await db.query('INSERT INTO app_gaps (id, area, title, failed, fix, tools, fixed_here, reports, first_at, last_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $8)', [g.id, g.area, g.title, g.failed, g.fix, JSON.stringify(g.tools), g.fixed_here, now]);
  const hub = github();
  let issue = was?.issue ?? null;
  if (!hub) return { issue };
  if (!issue) {
    const made = await gh(hub, 'POST', '/issues', { title: `App gap: ${g.title}`, body: issueBody(g, reports), labels: ['app-gap', `area:${g.area}`] });
    issue = typeof made?.number === 'number' ? made.number : null;
    if (issue) await db.query('UPDATE app_gaps SET issue = $2 WHERE id = $1', [g.id, issue]);
    return { issue };
  }
  const newlyFixed = !!g.fixed_here && g.fixed_here !== was?.fixed_here;
  if (newlyFixed) await gh(hub, 'POST', `/issues/${issue}/comments`, { body: `**Fixed in an agency - take it into the official build:**\n\n${g.fixed_here}` });
  else if (milestone(reports)) await gh(hub, 'POST', `/issues/${issue}/comments`, { body: `Reported again (${reports} reports so far).` });
  return { issue };
}
