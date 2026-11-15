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
import { accountOf, claim, clock, hold, planFor, scheduledRows, setKick, type QueuedRow } from './action-queue.js';
import { keptPageAlive } from './kept-pages.js';

// Approvals (docs/runner.md): a T2 call is queued with the exact arguments
// the agent gave and the run carries on. A person approves or rejects it on
// the Approvals page; approved, it runs then and there - unless its agent chose to
// space them out (action-queue.ts). Either way, or when nobody decides in time,
// the agent gets a run to hear the outcome (one run for a batch: scheduler.ts).

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
    if (!ownerFor.has(id)) ownerFor.set(id, readMeta(id).then(meta => nameNow(meta?.ownerId, meta?.owner)));
    return ownerFor.get(id)!;
  };
  // Once per agent, not per card: a couple of hundred waiting cards are a handful of agents.
  const ownerFor = new Map<string, Promise<ReturnType<typeof nameNow>>>();
  const owners = await Promise.all(rows.map(ownerOf));
  const stopped = new Map<string, boolean>();
  const stoppedNow = (id: string) => stopped.get(id) ?? stopped.set(id, stateOf(id, now).state === 'stopped').get(id)!;
  const agencyIsStopped = agencyStopped();
  // A stopped agent's approvals stay (their clock keeps running) but wait for it to be turned back on.
  // Tools listed by name and plain level, also on cards queued before they were.
  const argsOf = (r: ApprovalRow) => {
    const args = JSON.parse(r.args) as Record<string, unknown>;
    return Array.isArray(args.tools) && typeof args.tools_list === 'string' ? { ...args, tools_list: toolsForPeople(args.tools as { id: string; tier: string }[]) } : args;
  };
  return rows.map((r, i) => ({ id: r.id, agentId: r.agent_id, agentName: names.get(r.agent_id)!, owner: owners[i], agentStopped: stoppedNow(r.agent_id), agencyStopped: agencyIsStopped, tool: r.tool, args: argsOf(r), card: approvalCardOf(r.tool) ?? BUILT_IN_CARDS[r.tool] ?? null, createdAt: r.created_at, expiresAt: r.expires_at }));
}

// Approved and not run yet (action-queue.ts): when each runs and why it waits, so a
// card can say so honestly - and a person can still say "run now" (runApprovedNow).
export async function scheduledApprovals() {
  const rows = scheduledRows();
  const names = new Map<string, string>();
  for (const r of rows) if (!names.has(r.agent_id)) names.set(r.agent_id, (await readMeta(r.agent_id))?.name ?? r.agent_id);
  return rows.map(r => ({
    id: r.id,
    agentId: r.agent_id,
    agentName: names.get(r.agent_id)!,
    tool: r.tool,
    args: JSON.parse(r.args) as Record<string, unknown>,
    card: approvalCardOf(r.tool) ?? BUILT_IN_CARDS[r.tool] ?? null,
    account: r.account || null,
    state: r.exec_state as 'queued' | 'paused' | 'running',
    runsAt: r.exec_state === 'queued' ? r.due_at : null,
    why: r.plan,
    decidedAt: r.decided_at,
  }));
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
  // When it runs (action-queue.ts): now, unless its agent paced this tool on this
  // account, or the last one on it failed and its agent is deciding. Run by the queue,
  // one at a time per account - waited on here, so the person sees its result as before.
  const account = accountOf(args);
  const plan = planFor(a.agent_id, a.tool, account, now);
  exec('UPDATE approvals SET exec_state = ?, due_at = ?, account = ?, deferred = ?, plan = ? WHERE id = ?', plan.state, plan.due, account, plan.deferred ? 1 : 0, plan.plan, id);
  if (plan.state === 'paused' || plan.due > now) return { ok: true, ran: false, result: plan.state === 'paused' ? `Approved. ${plan.plan}` : `Approved. ${plan.plan} - it runs ${clock(plan.due)}.` };
  return settled(id, { wake, load, now: () => Math.max(now, Date.now()) });
}

// --- Running approved actions (action-queue.ts) -------------------------------------

type QueueDeps = { wake: Wake; load: typeof loadAgent; now: () => number };
const keyOf = (r: { agent_id: string; tool: string; account: string }) => `${r.agent_id}|${r.tool}|${r.account}`;
// One drain per agent, tool and account at a time: its actions run one after another,
// every account's at once. waiting: whoever waits on one row's outcome (the person
// who approved it).
const draining = new Set<string>();
const waiting = new Map<string, (() => void)[]>();
const notify = (id: string) => {
  for (const fn of waiting.get(id) ?? []) fn();
  waiting.delete(id);
};
const rowOf = (id: string) => one<QueuedRow>('SELECT * FROM approvals WHERE id = ?', id)!;

// Runs a row that's due now (through its account's drain) and says how it went.
async function settled(id: string, deps: QueueDeps): Promise<{ ok: boolean; ran: boolean; result: string | null }> {
  const done = new Promise<void>(resolve => waiting.set(id, [...(waiting.get(id) ?? []), resolve]));
  drain(rowOf(id), deps);
  await done;
  const after = rowOf(id);
  if (after.exec_state === 'done') return { ok: true, ran: true, result: after.result };
  if (after.exec_state === 'failed' || after.exec_state === 'interrupted') return { ok: false, ran: true, result: after.result };
  // Paused behind one that failed, or its agent stopped meanwhile: it waits, approved.
  return {
    ok: true,
    ran: false,
    result: after.exec_state === 'paused' ? 'Approved. Held: one before it on the same account failed, and its agent is deciding when to go on.' : 'Approved; it runs once its agent is back on.',
  };
}

// The scheduler's wake, set as it starts (this can't import scheduler.ts: it imports this).
let liveWake: Wake = () => {};
export const setQueueWake = (fn: Wake) => {
  liveWake = fn;
  setKick(() => void runDueActions());
};

// Starts what's due: every tick, and when an agent reschedules its own.
export function runDueActions(deps: QueueDeps = { wake: (agentId, t, task) => liveWake(agentId, t, task), load: loadAgent, now: () => Date.now() }) {
  const due = all<QueuedRow>("SELECT * FROM approvals WHERE status = 'approved' AND exec_state = 'queued' AND due_at <= ? ORDER BY due_at, created_at", deps.now());
  const keys = new Set<string>();
  for (const r of due)
    if (!keys.has(keyOf(r))) {
      keys.add(keyOf(r));
      drain(r, deps);
    }
  return keys.size;
}

function drain(first: QueuedRow, deps: QueueDeps) {
  const key = keyOf(first);
  if (draining.has(key)) return;
  draining.add(key);
  void (async () => {
    try {
      for (;;) {
        const now = deps.now();
        // A stopped agent's wait for it to be back on.
        if (stateOf(first.agent_id, now).state === 'stopped') break;
        const next = one<QueuedRow>(
          "SELECT * FROM approvals WHERE status = 'approved' AND exec_state = 'queued' AND agent_id = ? AND tool = ? AND account = ? AND due_at <= ? ORDER BY due_at, created_at LIMIT 1",
          first.agent_id,
          first.tool,
          first.account,
          now,
        );
        if (!next) break;
        // Exactly one caller ever runs it.
        if (!claim(next.id, now)) continue;
        await runOne(next, deps).catch(e => console.error(`Running approved ${next.id} failed:`, (e as Error).message));
        notify(next.id);
      }
    } finally {
      draining.delete(key);
      // Anyone still waiting on one of this account's: it isn't running now (paused,
      // later, or its agent stopped).
      for (const id of [...waiting.keys()]) if (one('SELECT 1 FROM approvals WHERE id = ? AND agent_id = ? AND tool = ? AND account = ?', id, first.agent_id, first.tool, first.account)) notify(id);
    }
  })();
}

const on = (account: string) => (account ? ` on ${account}` : '');

async function runOne(a: QueuedRow, deps: QueueDeps) {
  // The agent's reason (_why) is for the card, not the tool.
  const { _why: _reason, ...args } = JSON.parse(a.args) as Record<string, unknown>;
  const what = `${a.tool} (${argsLine(args)})`;
  const note = one<{ note: string | null }>('SELECT note FROM approvals WHERE id = ?', a.id)?.note?.trim();
  const why = note ? ` Their note: "${note}"` : '';
  const agent = await deps.load(a.agent_id);
  let result: string;
  let ok = true;
  try {
    if (!agent) throw new Error('The agent no longer exists.');
    result = await runApproved({ agent, runId: a.run_id, level: 0, now: deps.now, fleet: async () => [], wake: (id, t, task) => deps.wake(id, t as 'request', task), approved: true }, a.tool, args);
  } catch (e) {
    ok = false;
    result = `Approved, but it failed: ${(e as Error).message}`;
  }
  const now = deps.now();
  await approvalSettled(a.run_id);
  exec('UPDATE approvals SET result = ?, exec_state = ?, ran_at = ? WHERE id = ?', result.slice(0, 2000), ok ? 'done' : 'failed', now, a.id);
  settleAction(a.id, ok ? 'ok' : 'failed');
  if (!ok) {
    // The rest of this account's wait for the agent, and so do new ones for it: a
    // burst that tripped a sending limit isn't a broken tool, and more of the same
    // would only fail too. Woken once - its booking gathers whatever else comes in.
    const paused = exec("UPDATE approvals SET exec_state = 'paused', deferred = 1 WHERE agent_id = ? AND tool = ? AND account = ? AND exec_state = 'queued'", a.agent_id, a.tool, a.account).changes;
    hold(a.agent_id, a.tool, a.account, result, now);
    exec('UPDATE approvals SET told_at = ? WHERE id = ?', now, a.id);
    const fine = one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE agent_id = ? AND tool = ? AND account = ? AND exec_state = 'done' AND ran_at > ?", a.agent_id, a.tool, a.account, now - 3_600_000)?.n ?? 0;
    deps.wake(
      a.agent_id,
      'approval',
      `A person APPROVED your queued ${what}, but running it failed: ${result.replace(/^Approved, but it failed: /, '')}${why}` +
        (fine ? ` ${fine} of the same ran fine${on(a.account)} in the last hour, so after a burst like that it's more likely a sending or rate limit than a broken tool.` : '') +
        ` Every other approved ${a.tool}${on(a.account)} is PAUSED${paused ? ` (${paused} waiting)` : ''}, and new approvals for it wait too, until you decide: approvals.queue_mine shows them; approvals.schedule_mine runs them now, later or spread out, or cancels them. Work out what to do about it.`,
    );
    return;
  }
  if (!a.deferred) {
    exec('UPDATE approvals SET told_at = ? WHERE id = ?', now, a.id);
    deps.wake(a.agent_id, 'approval', `A person APPROVED your queued ${what}, and it ran: ${result}${why} Carry on from there.`);
    return;
  }
  // One it scheduled: no wake each (56 spread over hours would be 56 runs) - one when
  // the last of them has run, with how they went.
  if (one("SELECT 1 FROM approvals WHERE agent_id = ? AND deferred = 1 AND exec_state IN ('queued', 'running', 'paused')", a.agent_id)) return;
  const untold = all<QueuedRow>("SELECT * FROM approvals WHERE agent_id = ? AND deferred = 1 AND exec_state = 'done' AND told_at IS NULL ORDER BY ran_at", a.agent_id);
  if (!untold.length) return;
  exec("UPDATE approvals SET told_at = ? WHERE agent_id = ? AND deferred = 1 AND exec_state = 'done' AND told_at IS NULL", now, a.agent_id);
  const lines = untold.slice(0, 15).map(u => `- ${u.tool}${on(u.account)}: ${(u.result ?? '').slice(0, 200)}`);
  deps.wake(
    a.agent_id,
    'approval',
    `Your scheduled approved actions have all run: ${untold.length} done.\n${lines.join('\n')}${untold.length > 15 ? `\n- and ${untold.length - 15} more (approvals.queue_mine)` : ''}\nCarry on from there.`,
  );
}

// A person pressing "Run now" on an approved action that's waiting (scheduled by its
// agent, or held after a failure): it runs now, and only it.
export async function runApprovedNow(id: string, wake: Wake, load = loadAgent, now = Date.now()) {
  const a = one<QueuedRow>('SELECT * FROM approvals WHERE id = ?', id);
  if (!a || a.status !== 'approved' || !['queued', 'paused'].includes(a.exec_state ?? '')) throw new Error(a?.exec_state === 'running' ? "It's running now." : "That one isn't waiting to run.");
  if (stateOf(a.agent_id, now).state === 'stopped') throw new Error(agencyStopped() ? 'The agency is stopped. Resume it to run this.' : 'Its agent is stopped. Resume it to run this.');
  if (!exec("UPDATE approvals SET exec_state = 'queued', due_at = ?, plan = NULL WHERE id = ? AND exec_state IN ('queued', 'paused')", now, id).changes) throw new Error('It started meanwhile.');
  return settled(id, { wake, load, now: () => Math.max(now, Date.now()) });
}

// Ones the agency was running when it stopped: they may or may not have happened, so
// never run again by themselves - the agent is told, and the rest of that account
// waits for it.
export function recoverInterruptedActions(now: number, wake: Wake) {
  const cut = all<QueuedRow>("SELECT * FROM approvals WHERE exec_state = 'running'");
  for (const a of cut) {
    // Not "failed": it says nothing about the tool (failuresLastHour, tools.ts).
    const msg = 'Interrupted: the agency stopped while this was running, so it may or may not have happened.';
    if (!exec("UPDATE approvals SET exec_state = 'interrupted', result = ?, told_at = ? WHERE id = ? AND exec_state = 'running'", msg, now, a.id).changes) continue;
    settleAction(a.id, 'failed');
    const paused = exec("UPDATE approvals SET exec_state = 'paused', deferred = 1 WHERE agent_id = ? AND tool = ? AND account = ? AND exec_state = 'queued'", a.agent_id, a.tool, a.account).changes;
    hold(a.agent_id, a.tool, a.account, msg, now);
    wake(
      a.agent_id,
      'approval',
      `Your approved ${a.tool} (${argsLine(JSON.parse(a.args))}) was running when the agency stopped, so it may or may not have happened - check before doing it again (a sent folder, the record itself). It won't run again by itself. Every other approved ${a.tool}${on(a.account)} is PAUSED${paused ? ` (${paused} waiting)` : ''} until you decide (approvals.queue_mine, approvals.schedule_mine).`,
    );
  }
  return cut.length;
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
