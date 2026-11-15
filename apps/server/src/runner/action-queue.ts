import { all, one, run as exec } from './db.js';

// When approved actions run (decided 2026-11-15). A person approving 56 pitch emails
// had them all sent through one Zoho mailbox about a second apart; Zoho blocked the
// mailbox for "Mail rate exceeded limit", every send after that returned a 500, and
// the agent was told the tool was failing "for any input". There is no pace the
// system forces (an agency may send from 100 mailboxes, and each should go at full
// speed): an approved action runs as soon as it's approved, unless its own agent
// chose otherwise, for a reason it gives:
//   - before they're approved: a pace for a tool on one account (approvals.pace_mine,
//     "cold email from one mailbox, one every 3 minutes for today"); approvals that come in
//     while it lasts are spaced that far apart, per account
//   - once approved and not run yet: run them now, later, or spread over a time, per
//     account (approvals.schedule_mine), or cancel them
// Each approved action is a row in approvals with its due time (due_at), so it survives
// a restart. The runner runs what's due (approvals.ts), one at a time per agent, tool
// and account, every account at once. One that fails pauses the rest of that agent's
// for the same tool and account, and holds new ones for it, until the agent (woken
// once, with the error) decides: a burst isn't a broken tool.
//
// exec_state on an approved row: queued (runs at due_at) | running | done | failed |
// paused (held after a failure, until its agent or a person says) | cancelled (by its
// agent) | interrupted (the agency stopped while it ran: it may or may not have happened).
// Rows approved before this existed have none.

// Who an action is sent as, so actions on different accounts never wait on each other:
// the mailbox it's sent from, the account it's on. None named: the tool's one account.
const ACCOUNT_KEYS = ['from', 'fromaddress', 'from_address', 'from_email', 'fromemail', 'sender', 'sender_email', 'mailbox', 'account', 'account_id', 'accountid', 'inbox', 'inbox_id'];
export function accountOf(args: Record<string, unknown>): string {
  for (const [k, v] of Object.entries(args)) {
    if (!ACCOUNT_KEYS.includes(k.toLowerCase())) continue;
    if (typeof v === 'string' && v.trim()) return v.trim().toLowerCase().slice(0, 200);
    if (typeof v === 'number') return String(v);
  }
  return '';
}

export type QueuedRow = {
  id: string;
  agent_id: string;
  run_id: string;
  tool: string;
  args: string;
  status: string;
  account: string;
  exec_state: string | null;
  due_at: number | null;
  decided_at: number | null;
  deferred: number | null;
  plan: string | null;
  result: string | null;
  ran_at: number | null;
  created_at: number;
};

// Its agent's standing choices for one tool on one account (account '*': every
// account of the tool): a pace (every_ms, until), and a hold after a failure.
type Pace = { agent_id: string; tool: string; account: string; every_ms: number | null; until: number | null; held_since: number | null; held_error: string | null; why: string | null };
const paceOf = (agentId: string, tool: string, account: string) =>
  one<Pace>('SELECT * FROM action_pace WHERE agent_id = ? AND tool = ? AND account = ?', agentId, tool, account) ??
  one<Pace>("SELECT * FROM action_pace WHERE agent_id = ? AND tool = ? AND account = '*'", agentId, tool);
const heldFor = (agentId: string, tool: string, account: string) =>
  !!one<{ held_since: number | null }>('SELECT held_since FROM action_pace WHERE agent_id = ? AND tool = ? AND account = ? AND held_since IS NOT NULL', agentId, tool, account) ||
  !!one("SELECT 1 FROM approvals WHERE agent_id = ? AND tool = ? AND account = ? AND exec_state = 'paused'", agentId, tool, account);

export const clock = (t: number) => new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
const mins = (ms: number) => (ms >= 2 * 3_600_000 ? `${Math.round(ms / 360_000) / 10} hours` : `${Math.max(1, Math.round(ms / 60_000))} minute${Math.round(ms / 60_000) > 1 ? 's' : ''}`);

// When a just-approved action runs: now, unless its agent paced the tool on that
// account, or a failure is holding it.
export function planFor(agentId: string, tool: string, account: string, now: number): { state: 'queued' | 'paused'; due: number; deferred: boolean; plan: string | null } {
  if (heldFor(agentId, tool, account)) return { state: 'paused', due: now, deferred: true, plan: 'Held: the last one on this account failed, and its agent is deciding when to go on.' };
  const p = paceOf(agentId, tool, account);
  if (p?.every_ms && p.until && p.until > now) {
    const lastDue = one<{ t: number | null }>("SELECT MAX(due_at) AS t FROM approvals WHERE agent_id = ? AND tool = ? AND account = ? AND exec_state IN ('queued', 'running')", agentId, tool, account)?.t ?? 0;
    const lastRan = one<{ t: number | null }>('SELECT MAX(ran_at) AS t FROM approvals WHERE agent_id = ? AND tool = ? AND account = ? AND ran_at IS NOT NULL', agentId, tool, account)?.t ?? 0;
    const due = Math.max(now, Math.max(lastDue, lastRan) + p.every_ms);
    if (due > now) return { state: 'queued', due, deferred: true, plan: `Its agent spaces these ${mins(p.every_ms)} apart${p.why ? `: ${p.why}` : ''}` };
  }
  return { state: 'queued', due: now, deferred: false, plan: null };
}

// The runner's: start what's due now (set by approvals.ts, so a schedule set to "now"
// doesn't wait for the next tick).
let kick: () => void = () => {};
export const setKick = (fn: () => void) => void (kick = fn);

// Holds new approvals for this tool and account (after a failure), until its agent decides.
export function hold(agentId: string, tool: string, account: string, error: string, now: number) {
  exec(
    'INSERT INTO action_pace (agent_id, tool, account, held_since, held_error, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, tool, account) DO UPDATE SET held_since = excluded.held_since, held_error = excluded.held_error, updated_at = excluded.updated_at',
    agentId,
    tool,
    account,
    now,
    error.slice(0, 500),
    now,
  );
}
const release = (agentId: string, tool: string, account: string, now: number) =>
  exec('UPDATE action_pace SET held_since = NULL, held_error = NULL, updated_at = ? WHERE agent_id = ? AND tool = ? AND account = ?', now, agentId, tool, account);

// Claims a due row for running: exactly one caller ever gets it.
export const claim = (id: string, now: number) => exec("UPDATE approvals SET exec_state = 'running', ran_at = ? WHERE id = ? AND exec_state = 'queued' AND due_at <= ?", now, id, now).changes === 1;

const label = (r: { tool: string; args: string }) => {
  const a = JSON.parse(r.args) as Record<string, unknown>;
  const l = [a.subject, a.title, a.to, a.toAddress, a.company, a.name].find(v => typeof v === 'string' && v.trim());
  return `${r.tool}${l ? ` (${String(l).slice(0, 70)})` : ''}`;
};
const on = (account: string) => (account ? ` on ${account}` : '');

// --- The agent's tools ------------------------------------------------------------

const MAX_DELAY_MIN = 7 * 24 * 60;

// approvals.schedule_mine: when its approved-but-not-run actions go.
export function scheduleMine(agentId: string, a: Record<string, unknown>, now: number): string {
  const how = String(a.run ?? '');
  if (!['now', 'later', 'spread', 'cancel'].includes(how)) throw new Error('run is one of: now, later, spread, cancel.');
  const why = String(a.why ?? '').trim().slice(0, 300);
  if (!why) throw new Error('Say why, in a sentence (it is shown to the person on the action).');
  const ids = Array.isArray(a.approval_ids) ? [...new Set(a.approval_ids.map(String))] : [];
  const tool = typeof a.tool === 'string' && a.tool.trim() ? a.tool.trim() : null;
  const account = typeof a.account === 'string' && a.account.trim() ? a.account.trim().toLowerCase() : null;
  let rows = all<QueuedRow>("SELECT * FROM approvals WHERE agent_id = ? AND status = 'approved' AND exec_state IN ('queued', 'paused') ORDER BY created_at, id", agentId);
  if (ids.length) rows = rows.filter(r => ids.includes(r.id));
  if (tool) rows = rows.filter(r => r.tool === tool);
  if (account !== null) rows = rows.filter(r => r.account === account);
  if (!rows.length) throw new Error('None of your approved actions waiting to run match that. approvals.queue_mine lists them.');
  const keys = new Map<string, QueuedRow[]>();
  for (const r of rows) keys.set(`${r.tool}|${r.account}`, [...(keys.get(`${r.tool}|${r.account}`) ?? []), r]);
  const delay = Math.max(0, Math.min(MAX_DELAY_MIN, Number(a.delay_minutes) || 0)) * 60_000;
  const over = Math.max(0, Math.min(MAX_DELAY_MIN, Number(a.over_minutes) || 0)) * 60_000;
  if (how === 'spread' && !over) throw new Error('Give over_minutes: the time to spread them over.');
  for (const [, group] of keys) {
    group.forEach((r, i) => {
      if (how === 'cancel') {
        exec("UPDATE approvals SET exec_state = 'cancelled', result = ?, plan = ? WHERE id = ? AND exec_state IN ('queued', 'paused')", `Cancelled by its agent: ${why}`, why, r.id);
        exec("UPDATE actions SET outcome = 'refused' WHERE approval_id = ? AND outcome = 'queued'", r.id);
        return;
      }
      // Spread per account: each account's own over the time, the first right away
      // (or after the delay), the last at the end.
      const due = now + delay + (how === 'spread' && group.length > 1 ? Math.round((over * i) / (group.length - 1)) : 0);
      const plan = how === 'now' ? null : how === 'later' ? `Its agent set it for ${clock(due)}: ${why}` : `Its agent spread these over ${mins(over)}: ${why}`;
      exec("UPDATE approvals SET exec_state = 'queued', due_at = ?, deferred = 1, plan = ? WHERE id = ? AND exec_state IN ('queued', 'paused')", due, plan, r.id);
    });
    // The agent has decided: new approvals for it run (or follow its pace) again.
    release(agentId, group[0].tool, group[0].account, now);
  }
  kick();
  const n = rows.length;
  if (how === 'cancel') return `Cancelled ${n}: they won't run. Say in your summary which and why (a person approved them).`;
  if (how === 'now') return `${n} running now, one at a time per account. You'll hear how they went once they're done.`;
  if (how === 'later') return `${n} set for ${clock(now + delay)}. You'll hear once they're done.`;
  return `${n} spread over ${mins(over)}${keys.size > 1 ? `, each account's on its own (${keys.size} accounts)` : ''}, starting ${delay ? clock(now + delay) : 'now'}. You'll hear once they're all done; one failing pauses the rest of its account and wakes you.`;
}

// approvals.pace_mine: a pace for one tool (on one account, or every account of it)
// that approvals coming in follow, so a burst a person approves never goes out at once.
export function paceMine(agentId: string, a: Record<string, unknown>, now: number): string {
  const tool = String(a.tool ?? '').trim();
  if (!tool) throw new Error('Give the tool (its id, e.g. zoho-mail.zohomail_send_mail).');
  const account = typeof a.account === 'string' && a.account.trim() ? a.account.trim().toLowerCase() : '*';
  const every = Math.max(0, Math.min(24 * 60, Number(a.every_minutes) || 0)) * 60_000;
  const hours = Math.max(0, Math.min(7 * 24, Number(a.for_hours) || 24));
  const why = String(a.why ?? '').trim().slice(0, 300);
  if (every && !why) throw new Error('Say why, in a sentence (it is shown to the person on each action it delays).');
  exec(
    'INSERT INTO action_pace (agent_id, tool, account, every_ms, until, why, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, tool, account) DO UPDATE SET every_ms = excluded.every_ms, until = excluded.until, why = excluded.why, updated_at = excluded.updated_at',
    agentId,
    tool,
    account,
    every || null,
    every ? now + hours * 3_600_000 : null,
    every ? why : null,
    now,
  );
  if (!every) return `No pace on ${tool}${account === '*' ? '' : on(account)} any more: approved ones run as soon as they're approved.`;
  return `Paced: ${tool} approvals${account === '*' ? ', on each account,' : on(account)} run at least ${mins(every)} apart until ${clock(now + hours * 3_600_000)}. Ones already approved keep their times (approvals.schedule_mine changes those).`;
}

// What it has approved and not run yet, how much it sent lately per account, what
// failed: enough to decide whether spacing is worth it.
export function queueMine(agentId: string, now: number): string {
  const waiting = all<QueuedRow>("SELECT * FROM approvals WHERE agent_id = ? AND status = 'approved' AND exec_state IN ('queued', 'paused', 'running') ORDER BY due_at, created_at", agentId);
  const lines: string[] = [];
  lines.push(waiting.length ? `Approved, not run yet (${waiting.length}):` : 'Approved, not run yet: none.');
  for (const r of waiting.slice(0, 60))
    lines.push(`- ${r.id} ${label(r)}${on(r.account)}: ${r.exec_state === 'paused' ? 'PAUSED after a failure' : r.exec_state === 'running' ? 'running now' : (r.due_at ?? 0) <= now ? 'runs now' : `runs ${clock(r.due_at!)}`}${r.plan ? ` - ${r.plan}` : ''}`);
  if (waiting.length > 60) lines.push(`- and ${waiting.length - 60} more`);
  const sends = all<{ tool: string; account: string; hour: number; day: number; failed: number }>(
    "SELECT tool, account, SUM(ran_at > ?) AS hour, COUNT(*) AS day, SUM(exec_state IN ('failed', 'interrupted')) AS failed FROM approvals WHERE agent_id = ? AND ran_at > ? AND exec_state IN ('done', 'failed', 'interrupted') GROUP BY tool, account ORDER BY day DESC",
    now - 3_600_000,
    agentId,
    now - 86_400_000,
  );
  lines.push(sends.length ? 'Ran lately, per account (last hour / last 24 hours, failed):' : 'Ran lately: nothing approved ran in the last 24 hours.');
  for (const s of sends) lines.push(`- ${s.tool}${on(s.account)}: ${s.hour} / ${s.day}${s.failed ? `, ${s.failed} failed` : ''}`);
  const fails = all<QueuedRow>("SELECT * FROM approvals WHERE agent_id = ? AND exec_state IN ('failed', 'interrupted') AND ran_at > ? ORDER BY ran_at DESC LIMIT 5", agentId, now - 86_400_000);
  if (fails.length) lines.push('Recent failures:', ...fails.map(f => `- ${clock(f.ran_at!)} ${label(f)}${on(f.account)}: ${(f.result ?? '').replace(/^Approved, but it failed: /, '').slice(0, 300)}`));
  const paces = all<Pace>('SELECT * FROM action_pace WHERE agent_id = ? AND ((every_ms IS NOT NULL AND until > ?) OR held_since IS NOT NULL)', agentId, now);
  for (const p of paces) {
    if (p.held_since) lines.push(`Holding ${p.tool}${on(p.account)} since ${clock(p.held_since)} after: ${(p.held_error ?? '').slice(0, 200)} - new approvals for it wait until you schedule them.`);
    if (p.every_ms && p.until && p.until > now) lines.push(`Your pace: ${p.tool}${p.account === '*' ? ' (each account)' : on(p.account)} ${mins(p.every_ms)} apart until ${clock(p.until)}${p.why ? ` - ${p.why}` : ''}`);
  }
  return lines.join('\n');
}

// For its instructions, every run: one line, only when there's something.
export function queueForPrompt(agentId: string, now: number): string {
  const c = one<{ queued: number; paused: number; next: number | null }>(
    "SELECT SUM(exec_state IN ('queued', 'running')) AS queued, SUM(exec_state = 'paused') AS paused, MIN(CASE WHEN exec_state = 'queued' THEN due_at END) AS next FROM approvals WHERE agent_id = ? AND status = 'approved' AND exec_state IN ('queued', 'paused', 'running')",
    agentId,
  );
  const failed = one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE agent_id = ? AND exec_state IN ('failed', 'interrupted') AND ran_at > ?", agentId, now - 86_400_000)?.n ?? 0;
  if (!c?.queued && !c?.paused && !failed) return '';
  const parts = [c?.queued ? `${c.queued} scheduled${c.next && c.next > now ? ` (next ${clock(c.next)})` : ''}` : '', c?.paused ? `${c.paused} PAUSED after a failure - yours to reschedule or cancel` : '', failed ? `${failed} failed in the last 24 hours` : ''].filter(Boolean);
  return `Your approved actions not run yet: ${parts.join('; ')} (approvals.queue_mine).`;
}

// --- For people (api.ts) ----------------------------------------------------------

// Approved and not run yet: when each will run, and why it waits.
export const scheduledRows = () => all<QueuedRow>("SELECT * FROM approvals WHERE status = 'approved' AND exec_state IN ('queued', 'paused', 'running') ORDER BY due_at, created_at");
