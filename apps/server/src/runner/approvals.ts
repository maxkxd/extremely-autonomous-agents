import { toolsForPeople } from '../catalog.js';
import { nameNow } from '../access.js';
import { readMeta } from '../files.js';
import { approvalCardOf, discardDraft } from '../integrations/index.js';
import type { ApprovalCardDef } from '../integrations/schema.js';
import { FLEET_ENGINEER, loadAgent } from './agent.js';
import { DOCTOR } from './doctor.js';
import { all, one, run as exec } from './db.js';
import { agencyStopped, stateOf } from './run.js';
import { approvalSettled, runApproved } from './tools.js';
import { keptPageAlive } from './kept-pages.js';

// Approvals (docs/runner.md): a T2 call is queued with the exact arguments
// the agent gave and the run carries on. A person approves or rejects it on
// the Approvals page; approved, it runs then and there. Either way, or when
// nobody decides in time, the agent gets a run to hear the outcome.

// Books a run (the scheduler's book): the agent hearing an outcome, or work a
// tool that ran sets off (the Agency Engineer picking a request back up).
type Wake = (agentId: string, trigger: 'approval' | 'request', task: string) => void;

// Cards for the built-in agents' own tools that the app's Approvals page has no
// card for: the page draws these as it draws an integration's (no new UI).
export const BUILT_IN_CARDS: Record<string, ApprovalCardDef> = {
  'engineer.install_program': {
    wants_to: 'install {program} on {where}',
    headers: [
      { label: 'For', value: '{for_agent_name}' },
      { label: 'From', value: '{source_line}' },
      { label: 'Checked', value: '{checked}', optional: true },
      { label: 'Heads-up', value: '{heads_up}' },
    ],
    body: '{why}',
    expires_after_hours: 168,
  },
};

export type ApprovalRow = { id: string; agent_id: string; run_id: string; tool: string; args: string; status: string; created_at: number; expires_at: number };

export async function pendingApprovals(now = Date.now()) {
  const rows = all<ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' AND expires_at > ? ORDER BY created_at", now);
  const names = new Map<string, string>();
  for (const r of rows) if (!names.has(r.agent_id)) names.set(r.agent_id, (await readMeta(r.agent_id))?.name ?? r.agent_id);
  // Whose decision it is: the owner of the agent it's for - for the Fleet
  // Engineer (owned by no one), the agent it's building for, whose owner is the
  // person who built that agent.
  const ownerOf = async (r: ApprovalRow) => {
    const forAgent = (JSON.parse(r.args) as { for_agent?: unknown }).for_agent;
    // The Agency Doctor's: about one agent (agent_id).
    const about = (JSON.parse(r.args) as { agent_id?: unknown }).agent_id;
    const id = r.agent_id === FLEET_ENGINEER && typeof forAgent === 'string' ? forAgent : r.agent_id === DOCTOR && typeof about === 'string' ? about : r.agent_id;
    const meta = await readMeta(id);
    return nameNow(meta?.ownerId, meta?.owner);
  };
  const owners = await Promise.all(rows.map(ownerOf));
  // A stopped agent's approvals stay (their clock keeps running) but wait for it to be turned back on.
  // Tools listed by name and plain level, also on cards queued before they were.
  const argsOf = (r: ApprovalRow) => {
    const args = JSON.parse(r.args) as Record<string, unknown>;
    return Array.isArray(args.tools) && typeof args.tools_list === 'string' ? { ...args, tools_list: toolsForPeople(args.tools as { id: string; tier: string }[]) } : args;
  };
  return rows.map((r, i) => ({ id: r.id, agentId: r.agent_id, agentName: names.get(r.agent_id)!, owner: owners[i], agentStopped: stateOf(r.agent_id, now).state === 'stopped', agencyStopped: agencyStopped(), tool: r.tool, args: argsOf(r), card: approvalCardOf(r.tool) ?? BUILT_IN_CARDS[r.tool] ?? null, createdAt: r.created_at, expiresAt: r.expires_at }));
}

const argsLine = (args: Record<string, unknown>) =>
  Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? (v.length > 80 ? `${v.slice(0, 80)}…` : v) : JSON.stringify(v)}`)
    .join('; ')
    .replace(/\s+/g, ' ');

// by: who decided (access.ts); recorded with the decision.
export async function decideApproval(id: string, decision: 'approved' | 'rejected', note: string | null, wake: Wake, now = Date.now(), load = loadAgent, by?: { id: string; name: string }) {
  const a = one<ApprovalRow>('SELECT * FROM approvals WHERE id = ?', id);
  if (!a) throw new Error('That approval no longer exists.');
  if (a.status !== 'pending') throw new Error(`Already ${a.status}.`);
  if (stateOf(a.agent_id, now).state === 'stopped') throw new Error(agencyStopped() ? 'The agency is stopped. Resume it to decide this.' : 'Its agent is stopped. Resume it to decide this.');
  if (a.expires_at <= now) {
    expireApprovals(now, wake);
    throw new Error('It expired before you decided, so it did not happen.');
  }
  // Claim it first, so a double click can't run it twice.
  const claimed = exec(
    "UPDATE approvals SET status = ?, decided_at = ?, note = ?, decided_by = ?, decided_by_id = ? WHERE id = ? AND status = 'pending'",
    decision,
    now,
    note,
    by?.name ?? null,
    by?.id ?? null,
    id,
  );
  if (!claimed.changes) throw new Error('Already decided.');
  // The agent's reason (_why) is for the card, not the tool.
  const { _why: _reason, ...args } = JSON.parse(a.args) as Record<string, unknown>;
  const what = `${a.tool} (${argsLine(args)})`;
  const why = note?.trim() ? ` Their note: "${note.trim()}"` : '';
  if (decision === 'rejected') {
    settleAction(id, 'refused');
    // A go-live turned down: its draft goes too.
    const gone = a.tool === 'engineer.publish_integration' && (await discardDraft(String(args.integration_id)).catch(() => false));
    void approvalSettled(a.run_id);
    // Others it queued alongside may share what was wrong: it may take those back
    // (approvals.withdraw_mine) - its call, when it's confident.
    const others = one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE agent_id = ? AND status = 'pending' AND id != ?", a.agent_id, id)?.n ?? 0;
    const batch = others
      ? ` You have ${others} other action${others === 1 ? '' : 's'} still waiting for approval. If the person's note asks for the change on them too, or they plainly have exactly the problem rejected here, withdraw them (approvals.withdraw_mine) and queue fixed versions. If you're not sure, leave them: the person may want to see them as they are.`
      : '';
    wake(a.agent_id, 'approval', `A person REJECTED your queued ${what} (${id}). It did not happen.${gone ? ' Its draft was discarded (if a version of it was live before, that one is back).' : ''}${why} Take that into account - don't queue the same thing again unchanged.${batch}`);
    return { ok: true, ran: false, result: null };
  }
  const agent = await load(a.agent_id);
  let result: string;
  let ok = true;
  try {
    if (!agent) throw new Error('The agent no longer exists.');
    result = await runApproved({ agent, runId: a.run_id, level: 0, now: () => Date.now(), fleet: async () => [], wake: (id, t, task) => wake(id, t as 'request', task), approved: true }, a.tool, args);
  } catch (e) {
    ok = false;
    result = `Approved, but it failed: ${(e as Error).message}`;
  }
  await approvalSettled(a.run_id);
  exec('UPDATE approvals SET result = ? WHERE id = ?', result.slice(0, 2000), id);
  settleAction(id, ok ? 'ok' : 'failed');
  wake(
    a.agent_id,
    'approval',
    ok
      ? `A person APPROVED your queued ${what}, and it ran: ${result}${why} Carry on from there.`
      : `A person APPROVED your queued ${what}, but running it failed: ${result.replace(/^Approved, but it failed: /, '')}${why} Work out what to do about it.`,
  );
  return { ok, ran: true, result };
}

// The action that waited on it says how it ended, not "queued" for good: the tool
// history (and the Agency Engineer reading it) sees an approved one succeed.
const settleAction = (approvalId: string, outcome: 'ok' | 'failed' | 'refused') =>
  exec("UPDATE actions SET outcome = ? WHERE approval_id = ? AND outcome = 'queued'", outcome, approvalId);

// A browser click waits on the page kept for it (browser.ts). Once that page is gone -
// the agency restarted, or more clicks were waiting than it keeps open - approving it
// could only fail ("The page this click was on closed"), so it's withdrawn and its agent
// told, instead of waiting on the person's Approvals page to fail when they press it.
function withdrawClosedPages(now: number, wake: Wake) {
  const waiting = all<ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' AND tool LIKE 'signed_in_browser.click_to_%' AND json_extract(args, '$._page') IS NOT NULL");
  const gone = waiting.filter(a => keptPageAlive(String(JSON.parse(a.args)._page)) === false);
  for (const a of gone) {
    exec("UPDATE approvals SET status = 'expired', decided_at = ?, note = ? WHERE id = ? AND status = 'pending'", now, 'Its page closed before anyone decided.', a.id);
    settleAction(a.id, 'refused');
    void approvalSettled(a.run_id);
    wake(a.agent_id, 'approval', `Your queued ${a.tool} (${argsLine(JSON.parse(a.args))}) was WITHDRAWN: the page it was waiting on closed (the agency restarted, or more clicks were waiting than it keeps open), so it could never run. If it still matters, open the page again, redo the steps and queue it once more.`);
  }
  return gone.length;
}

// Taken back by their own agent a moment ago (approvals.withdraw_mine): the app
// plays them leaving instead of having them blink out.
export const recentlyWithdrawn = (now = Date.now()) =>
  all<{ id: string }>("SELECT id FROM approvals WHERE status = 'withdrawn' AND decided_at > ?", now - 120_000).map(r => r.id);

// Anything nobody decided in time doesn't happen; its agent hears so.
export function expireApprovals(now: number, wake: Wake) {
  const withdrawn = withdrawClosedPages(now, wake);
  const due = all<ApprovalRow>("SELECT * FROM approvals WHERE status = 'pending' AND expires_at <= ?", now);
  for (const a of due) {
    exec("UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'", now, a.id);
    settleAction(a.id, 'refused');
    void approvalSettled(a.run_id);
    wake(a.agent_id, 'approval', `Your queued ${a.tool} (${argsLine(JSON.parse(a.args))}) EXPIRED: nobody decided in time, so it did not happen. Queue it again only if it still matters.`);
  }
  return due.length + withdrawn;
}
