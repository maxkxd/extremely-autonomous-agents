import type { IncomingMessage } from 'node:http';
import { listIds, readMeta } from '../files.js';
import { PROVIDERS } from '../models/providers.js';
import {
  addIntegration,
  connectIntegration,
  disconnectIntegration,
  discardDraft,
  draftsForRequest,
  integrationProblems,
  listIntegrations,
  recheckStale,
  removeIntegration,
  setWebhookSecret,
  startIntegrationSignIn,
} from '../integrations/index.js';
import { FLEET_ENGINEER, loadAgent, realName } from './agent.js';
import { DOCTOR } from './doctor.js';
import { setups } from './setup.js';
import { postToRequest, waitingOn } from './engineer.js';
import { sendToIde, type Ide } from './ide.js';
import { connectAssistant, type Assistant } from './assistant.js';
import { answerRemoteMcp, isRemoteMcpUrl, remoteMcpUrl, takeRemoteMcp } from './remote-mcp.js';
import type { Rpc } from './mcp.js';
import { pluginsAllowed } from '../integrations/plugins.js';
import { decideApproval, pendingApprovals } from './approvals.js';
import { openProfileForSignIn, profileStatus } from './browser.js';
import { all, getSetting, one, run as exec, setSetting } from './db.js';
import { APOCALYPTIC_GAP_MS, LEVELS } from './ferocity.js';
import { BUILT_IN_IDS, HELPER_IDS } from './helpers.js';
import { spentToday } from './pricing.js';
import { hostZone, hostZoneSet, setHostZone, startOfMonth } from './clock.js';
import { mcpUrlFor, rpcAs } from './agency-mcp.js';
import { eventOverview } from './events.js';
import { hooksBase, setTunnel, tunnelState } from './hooks.js';
import { resume as resumeJobs } from '../jobs.js';
import { isPrivateIp } from './net.js';
import { agencyState, stateOf, type AgencyState, type Trigger } from './run.js';
import { abortAll, abortRun, blockedOnConnections, book, isRunning } from './scheduler.js';
import { AccessError, currentActor, nameNow, requireAdmin, requireMakerOrAdmin } from '../access.js';
import { scrub } from '../secrets.js';

// The runner's routes for the app: each agent's card (ferocity, Drain/Stop,
// real stats), its DM channel, requests, and spend caps (Settings > Usage).

type Route = (req: IncomingMessage, q: URLSearchParams, body: <T>() => Promise<T>) => Promise<unknown>;

const isId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]+$/.test(id);

// A label for output that isn't one of its KPI actions (extra effort, like
// stocking up files): "write_file" -> "Write file".
const outputLabel = (tool: string) => {
  if (tool === 'files.write_file') return 'Files written';
  const name = (tool.split('.').pop() ?? tool).replace(/_/g, ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
};
const connName = (id: string | null) => PROVIDERS.find(p => p.id === id)?.name ?? id ?? 'Unknown';

// A monthly spend limit as typed (Settings > Usage): dollars above 0, to the cent,
// up to a million; empty clears it. Anything else is refused, never saved as
// something else ("-5" was dropped, "abc-5" kept as text, a 20-digit number rounded).
export const MAX_CAP_USD = 1_000_000;
export function capUsd(v: unknown): number | null {
  if (v == null || (typeof v === 'string' && !v.trim())) return null;
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim().replace(/^\$/, '').replace(/,/g, '') : '';
  const n = Number(s);
  if (!/^\d+(\.\d{1,2})?$/.test(s) || !(n > 0) || n > MAX_CAP_USD)
    throw new Error('A monthly limit is a dollar amount above 0, to the cent at most, like 25 or 12.50 - up to 1,000,000. Leave it empty for no limit.');
  return n;
}

// The words of a typed command that could start a server here: a program
// (npx, uvx, docker...) or a path to one. Plain words ("not a url at all") aren't one.
const RUNNERS = /^(npx|npm|pnpm|pnpx|yarn|bunx?|node|deno|uvx?|pipx|python[\d.]*|py|docker|podman|java|go|dotnet|ruby|php|cmd|powershell|pwsh|bash|sh)(\.exe|\.cmd)?$/i;
export const looksLikeCommand = (words: string[]) => {
  const first = words[0] ?? '';
  return RUNNERS.test(first) || /[\\/]/.test(first) || /^[a-z]:/i.test(first) || /\.(exe|cmd|bat|sh|py|js|mjs|ts)$/i.test(first) || /^[\w.-]+-mcp(-server)?$|^mcp-[\w.-]+$/i.test(first);
};

// "npx -y @scope/server C:/My Notes" -> its words; quotes keep spaces together.
const splitCommand = (s: string) => (s.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(w => w.replace(/^["']|["']$/g, ''));
// An address on this computer or its network (a local MCP server the person adds).
const isLocalAddress = (u: string) => {
  const h = new URL(u).hostname.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.local') || isPrivateIp(h);
};

// A person's answer to a request: done (with what they did or decided) or
// turned down. The agent is told at the start of its next run. Turned down:
// what the Agency Engineer drafted for it goes, and so does its go-live card.
// A run's task about request #N ("Request #4 from ...", "... replied on request #4: ...").
const mentions = (task: string | null, id: number) => new RegExp(`request #${id}\\b`, 'i').test(task ?? '');

// What an agent's request shows a person of its evidence: not the lines for the
// Agency Engineer - the tool and event ids it names ("Tools: square.list_bookings,
// ..."), their inputs, how a service signals - the why already says them in words.
const FOR_ENGINEER = /^\s*((Tools|Events): |[\w-]+\.[\w.-]+ (expects: |- how the service tells it:)|Input it expects:)/;
export const evidenceForPeople = (evidence: unknown) => {
  const kept = String(evidence ?? '')
    .split('\n')
    .filter(l => !FOR_ENGINEER.test(l))
    .join('\n')
    .trim();
  return kept || null;
};

// A person's reply on a request wakes the Agency Engineer. Replies sent while
// that wake is still waiting join it, so one run answers them all, not one each.
export function replyToEngineer(requestId: number, who: string, text: string) {
  const said = `"${text.slice(0, 1500)}"`;
  const waiting = one<{ id: number; task: string | null }>(
    "SELECT id, task FROM bookings WHERE agent_id = ? AND trigger = 'request reply' AND task LIKE ? ORDER BY id LIMIT 1",
    FLEET_ENGINEER,
    `%request #${requestId}:%`,
  );
  if (waiting) exec('UPDATE bookings SET task = ? WHERE id = ?', `${waiting.task ?? ''}\nThen: ${said}`.slice(-6000), waiting.id);
  else book(FLEET_ENGINEER, 'request reply', `${who} replied on request #${requestId}: ${said}`);
}

// A person turned a request down: the agent still needs what it was for, so
// the Agency Engineer follows up - what they'd rather, or how the agent does
// without - instead of the agent being stuck on one no. (Not worded "request
// #N": that would let dropStaleRequestRuns drop it, the request being closed.)
function turnedDown(id: number, note?: string | null) {
  const r = one<{ agent_id: string; what: string }>('SELECT agent_id, what FROM requests WHERE id = ?', id);
  if (!r) return;
  const why = note?.trim() ? `, saying: "${note.trim().slice(0, 1000)}"` : ', without saying why';
  book(
    FLEET_ENGINEER,
    'turned down',
    r.agent_id === FLEET_ENGINEER
      ? `A person turned down your own ask (#${id}): "${r.what.slice(0, 300)}"${why}.`
      : `A person turned down ${r.agent_id}'s ask (#${id}): "${r.what.slice(0, 300)}"${why}.`,
  );
}

export async function answerRequest(id: number, status: 'done' | 'rejected', answer?: string | null): Promise<boolean> {
  if (status !== 'done' && status !== 'rejected') throw new Error('Answer with done or rejected.');
  const changed = exec(
    "UPDATE requests SET status = ?, answer = ?, answered_at = ? WHERE id = ? AND status = 'open'",
    status,
    answer?.trim() ? answer.trim().slice(0, 4000) : null,
    Date.now(),
    id,
  ).changes;
  if (!changed) return false;
  if (status === 'rejected') {
    turnedDown(id, answer);
    for (const d of draftsForRequest(id)) await discardDraft(d).catch(() => {});
    exec(
      "UPDATE approvals SET status = 'rejected', decided_at = ?, note = 'The request was turned down.' WHERE status = 'pending' AND agent_id = ? AND CAST(json_extract(args, '$.request_id') AS INTEGER) = ?",
      Date.now(),
      FLEET_ENGINEER,
      id,
    );
  }
  return true;
}

export const runnerRoutes: Record<string, Route> = {
  // Every real agent's card: state and stats over the last `days`.
  'GET /api/runner/agents': async (_req, q) => {
    const days = Math.max(1, Math.min(365, Number(q.get('days')) || 7));
    const since = Date.now() - days * 86_400_000;
    const out: Record<string, unknown> = {};
    for (const id of await listIds()) {
      const meta = await readMeta(id);
      if (!meta) continue;
      const st = stateOf(id);
      const agent = await loadAgent(id);
      // KPI labels ("ideas written") for each output action.
      const labels = new Map(agent?.output.map(o => [o.action, o.label] as const) ?? []);
      // Expected runs a day at each level, for the card's estimate - on the high side
      // on purpose: its plan's schedules, and at Apocalyptic back-to-back runs of its
      // usual length, as if every run reached its target.
      const avg = one<{ ms: number | null }>(
        "SELECT AVG(ended_at - started_at) AS ms FROM (SELECT ended_at, started_at FROM runs WHERE agent_id = ? AND status = 'succeeded' AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 20)",
        id,
      )?.ms;
      const backToBack = Math.min(1000, 86_400_000 / ((avg ?? 120_000) + APOCALYPTIC_GAP_MS));
      const runsPerDay = agent ? [...agent.ferocity.every_hours.map(h => 24 / h), backToBack] : [1, 1.5, 2, 4, 100];
      // Nothing it's counted by is connected yet (the card says so); it runs at its level all the same.
      const waitingOnTools = !!agent && !BUILT_IN_IDS.includes(id) && blockedOnConnections(agent);
      // Output per run from its busier runs - the busiest half of its last 20 - so quiet
      // runs don't drag the estimate down (it's meant to come out high). Nothing counted
      // in any of them says nothing about its rate: null, so the card shows how often it
      // runs - not "Est. Output: 0" after one quiet run.
      const acts = all<{ acts: number | null }>("SELECT acts FROM runs WHERE agent_id = ? AND status = 'succeeded' ORDER BY started_at DESC LIMIT 20", id)
        .map(r => r.acts ?? 0)
        .sort((x, y) => y - x);
      const busiest = acts.slice(0, Math.ceil(acts.length / 2));
      const perRun = acts.some(n => n > 0) ? busiest.reduce((s, n) => s + n, 0) / busiest.length : null;
      // Before it has any: a starting guess from each level's target (its plan's floors),
      // so the card shows a number to aim at - replaced by its real rate once it runs.
      const f = agent?.ferocity;
      const soft = Math.max(1, f?.soft_floor || 3);
      const perRunGuess = [Math.max(1, Math.round(soft / 2)), Math.max(1, Math.round(soft * 0.75)), soft, Math.max(soft, f?.floor || 10), Math.max(soft, f?.apocalyptic_floor || 30)];
      const last = one<{ started_at: number; ended_at: number | null; status: string }>(
        'SELECT started_at, ended_at, status FROM runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1',
        id,
      );
      const outputs = all<{ tool: string; n: number }>(
        'SELECT tool, SUM(output) AS n FROM actions WHERE agent_id = ? AND at >= ? AND output > 0 GROUP BY tool',
        id,
        since,
      );
      const costs = all<{ connection: string | null; usd: number | null; unknown: number }>(
        'SELECT connection, SUM(cost_usd) AS usd, SUM(cost_usd IS NULL AND connection IS NOT NULL) AS unknown FROM runs WHERE agent_id = ? AND started_at >= ? GROUP BY connection',
        id,
        since,
      );
      const decisions = one<{ approved: number; rejected: number; expired: number }>(
        "SELECT SUM(status = 'approved') AS approved, SUM(status = 'rejected') AS rejected, SUM(status = 'expired') AS expired FROM approvals WHERE agent_id = ? AND created_at >= ?",
        id,
        since,
      );
      out[id] = {
        ferocity: st.ferocity,
        level: LEVELS[st.ferocity],
        state: st.state,
        running: isRunning(id),
        // Run now pressed, waiting for one of the runs going now to finish (scheduler.ts MAX_PARALLEL).
        queued: !!one("SELECT 1 AS x FROM bookings WHERE agent_id = ? AND trigger = 'run now'", id),
        runs: one<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND started_at >= ?', id, since)?.n ?? 0,
        lastRun: last ? { at: last.ended_at ?? last.started_at, outcome: last.status === 'running' ? 'running' : last.status } : null,
        output: outputs.map(o => ({ tool: o.tool, label: labels.get(o.tool) ?? outputLabel(o.tool), value: o.n })),
        cost: costs.filter(c => c.connection).map(c => ({ label: connName(c.connection), value: c.usd ?? 0 })),
        costUnknown: costs.some(c => c.unknown > 0),
        decisions: { approved: decisions?.approved ?? 0, rejected: decisions?.rejected ?? 0, expired: decisions?.expired ?? 0 },
        spendCapUsd: st.spend_cap_usd,
        // Moved to working models when none of its own work (helpers.ts), unless turned off.
        autoModels: st.auto_models !== 0,
        runsPerDay,
        waitingOnTools,
        perRun: perRun ?? null,
        perRunGuess, // output actions per run, recently (null: never run, or nothing counted yet)
      };
    }
    return out;
  },

  // The whole agency on standby (nothing starts by itself) or stopped (every
  // run cut short, nothing at all: no building or tailoring either), or active.
  'GET /api/runner/agency': async () => ({ state: agencyState() }),
  // New agents' setup (their cards): connectors, stars and progress, until first resumed.
  'GET /api/runner/setup': async () => setups(),
  'POST /api/runner/agency': async (_req, _q, body) => {
    const { state } = await body<{ state: AgencyState }>();
    if (!['active', 'standby', 'stopped'].includes(state)) throw new Error('active, standby or stopped.');
    setSetting('agency_state', state);
    if (state === 'stopped') abortAll();
    // Pack set-up waits while stopped (jobs.ts); it carries on now.
    else void resumeJobs().catch(() => {});
    return { state: agencyState() };
  },

  // Ferocity, Drain/Stop, a per-agent spend cap.
  'POST /api/runner/agent': async (_req, _q, body) => {
    const b = await body<{ id: string; ferocity?: number; state?: 'active' | 'draining' | 'stopped'; spendCapUsd?: number | null; autoModels?: boolean }>();
    if (!isId(b.id)) throw new Error('Unknown agent.');
    // In an organization, only the agent's maker or an admin controls it (access.ts).
    if (b.ferocity !== undefined || b.state !== undefined || b.autoModels !== undefined)
      await requireMakerOrAdmin(b.id, null, currentActor(), b.state === 'stopped' ? 'stop it' : b.state === 'draining' ? 'put it on standby' : b.state === 'active' ? 'resume it' : b.autoModels !== undefined ? 'change how its models are picked' : 'change its ferocity');
    if (b.spendCapUsd !== undefined) requireAdmin(currentActor(), 'A spend limit');
    const cap = b.spendCapUsd !== undefined ? capUsd(b.spendCapUsd) : undefined;
    stateOf(b.id);
    const now = Date.now();
    // Built-ins keep theirs: they work when there's work, with a daily look otherwise.
    if (typeof b.ferocity === 'number' && b.ferocity >= 0 && b.ferocity < LEVELS.length && !(await readMeta(b.id))?.builtIn)
      exec('UPDATE agent_state SET ferocity = ?, updated_at = ? WHERE agent_id = ?', Math.floor(b.ferocity), now, b.id);
    // Built-ins have no Stop of their own: the agency's Stop covers them.
    if ((b.state === 'active' || b.state === 'draining' || b.state === 'stopped') && !(await readMeta(b.id))?.builtIn) {
      const state = b.state;
      exec('UPDATE agent_state SET state = ?, updated_at = ? WHERE agent_id = ?', state, now, b.id);
      if (state === 'stopped') abortRun(b.id);
      // Turning it back on also clears any failure backoff.
      if (state === 'active') exec('UPDATE agent_state SET fail_streak = 0, backoff_until = NULL WHERE agent_id = ?', b.id);
      // Its first resume ends setup: its card's setup list is gone for good.
      if (state !== 'stopped') exec('UPDATE agent_state SET setup = NULL WHERE agent_id = ?', b.id);
    }
    if (cap !== undefined) exec('UPDATE agent_state SET spend_cap_usd = ? WHERE agent_id = ?', cap, b.id);
    if (typeof b.autoModels === 'boolean') exec('UPDATE agent_state SET auto_models = ? WHERE agent_id = ?', b.autoModels ? 1 : 0, b.id);
    return { ok: true, state: stateOf(b.id) };
  },

  // Start a run now (for trying an agent out).
  'POST /api/runner/run-now': async (_req, _q, body) => {
    const { id } = await body<{ id: string }>();
    if (!isId(id)) throw new Error('Unknown agent.');
    // What the scheduler would never start: refused, not left waiting as a booking for ever.
    if (HELPER_IDS.includes(id)) throw new Error('It works only when an agent needs it - it has no runs of its own.');
    await requireMakerOrAdmin(id, null, currentActor(), 'run it');
    if (stateOf(id).state === 'stopped') throw new Error("It's stopped - resume it first.");
    if ((await readMeta(id))?.status === 'setting-up') throw new Error("It's still being set up.");
    book(id, 'run now', null);
    return { ok: true };
  },

  // --- DM channel (docs/agent-dms.md) ---
  'GET /api/dm': async (_req, q) => {
    const id = q.get('id');
    if (!isId(id)) return [];
    // In an organization, an agent's DMs are its maker's and the admins' (access.ts);
    // the Agency Engineer's are everyone's, as anyone may write to it.
    if (id !== FLEET_ENGINEER) await requireMakerOrAdmin(id, null, currentActor(), 'see its DMs');
    return all<{ kind: string; body: string; at: number }>('SELECT kind, body, at FROM dm WHERE agent_id = ? ORDER BY at, id', id).map(r => {
      const b = JSON.parse(r.body) as { by?: string; byId?: string; tools?: { approvalId?: string }[] };
      // A tool that waited on approval: how it was decided, so its dot says so after a reload too.
      const tools = b.tools?.map(t => (t.approvalId ? { ...t, decided: one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', t.approvalId)?.status ?? 'pending' } : t));
      // Who wrote it, by the name they have now.
      return { ...b, ...(tools ? { tools } : {}), ...(b.byId ? { by: nameNow(b.byId, b.by) } : {}), kind: r.kind, at: r.at };
    });
  },
  'POST /api/dm': async (_req, _q, body) => {
    const { id, text: typed } = await body<{ id: string; text: string }>();
    const text = typed && scrub(typed);
    if (!isId(id) || !text?.trim()) throw new Error('Nothing to send.');
    // Anyone in the organization may write to the Agency Engineer; other agents are their maker's and the admins'.
    if (id !== FLEET_ENGINEER) await requireMakerOrAdmin(id, null, currentActor(), 'message it');
    const meta = await readMeta(id);
    if (meta?.service) throw new Error('This helper only records what it decides; it takes no messages.');
    // Who wrote it (by, byId), so everyone sees the right name on it - not whoever's looking.
    const by = currentActor();
    const now = Date.now();
    exec("INSERT INTO dm (agent_id, kind, body, at) VALUES (?, 'you', ?, ?)", id, JSON.stringify({ kind: 'you', text: text.trim(), by: by.name, byId: by.id }), now);
    // Stopped (it, or the whole agency): kept, with the app's reply that it's stopped and
    // where to resume it (AgentDM.tsx). The booking waits, so it answers once resumed.
    const stopped = agencyState() === 'stopped' || stateOf(id).state === 'stopped';
    if (stopped) exec("INSERT INTO dm (agent_id, kind, body, at) VALUES (?, 'stopped', ?, ?)", id, JSON.stringify({ kind: 'stopped' }), now + 1);
    book(id, 'your message', text.trim());
    return { ok: true, stopped };
  },

  // --- Requests (docs/requests.md) ---
  'GET /api/runner/requests': async () => {
    const rows = all<Record<string, unknown> & { id: number }>(
      'SELECT id, agent_id, run_id, what, why, evidence, expected_effect, status, stage, answer, created_at, answered_at, joined_to FROM requests ORDER BY created_at DESC',
    );
    // One request per connection (tools.ts): a joined one shows as the request it
    // joined stands - its stage, the connection, the Agency Engineer's steps, its
    // card - with its own agent's reason. Each of its people sees it on their own.
    const byId = new Map(rows.map(r => [r.id, r]));
    const leadOf = (r: Record<string, unknown>) => (r.joined_to != null && r.status === 'open' ? byId.get(Number(r.joined_to)) : undefined);
    const messages = all<{ request_id: number; from_who: string; text: string; at: number }>('SELECT request_id, from_who, text, at FROM request_messages ORDER BY id');
    // What the Agency Engineer is doing and has waiting, to tell which request it's on.
    const onIt = {
      running: isRunning(FLEET_ENGINEER) ? all<{ task: string | null }>("SELECT task FROM runs WHERE agent_id = ? AND status = 'running'", FLEET_ENGINEER).map(x => x.task) : [],
      queued: all<{ task: string | null }>('SELECT task FROM bookings WHERE agent_id = ?', FLEET_ENGINEER).map(x => x.task),
    };
    // The approval a request waits on (the Agency Engineer's go-live), to go straight to.
    const waiting = all<{ id: string; request: number }>(
      "SELECT id, json_extract(args, '$.request_id') AS request FROM approvals WHERE status = 'pending' AND expires_at > ? AND agent_id = ?",
      Date.now(),
      FLEET_ENGINEER,
    );
    const connections = (await listIntegrations()).map(i => ({ id: i.id, name: i.name }));
    return rows.map(row => {
      const lead = leadOf(row);
      // The lead's for what it stands at; its engineer's steps with this one's own conversation.
      const r = lead ? { ...row, stage: row.stage === 'joined' ? lead.stage : row.stage } : row;
      const said = messages.filter(m => m.request_id === r.id || (lead && m.request_id === lead.id && m.from_who === 'engineer')).sort((x, y) => x.at - y.at);
      const on = lead ?? r;
      return {
      ...r,
      evidence: evidenceForPeople(r.evidence),
      // The request it joined, and the agents that joined it: one card for all of them.
      joinedTo: lead?.id ?? null,
      alsoFor: rows.filter(j => leadOf(j)?.id === r.id).map(j => ({ requestId: j.id, agentId: j.agent_id, why: j.why })),
      thread: said.map(m => ({ from: m.from_who === 'you' ? 'you' : 'engineer', text: m.text, at: m.at })),
      // Its run for this request is going or waiting - not just any run of its.
      engineerBusy: r.stage === 'engineer' && (onIt.running.some(t => mentions(t, on.id)) || onIt.queued.some(t => mentions(t, on.id))),
      // The Requests page shows a request only once it needs the person: the
      // engineer asked them something, handed it to them, or its go-live waits
      // on them. While the engineer is still working it out, it isn't there.
      // Once they've joined in, it stays while the engineer works on their reply.
      needsYou: ['waiting_you', 'approval', 'person'].includes(String(r.stage)) || messages.some(m => m.request_id === r.id && m.from_who === 'you'),
      approvalId: waiting.find(w => Number(w.request) === on.id)?.id ?? null,
      // The connection it waits for the person to connect, so the page can show one item per connection.
      waitingOn: r.stage === 'waiting_you' ? waitingOn(on.id, connections) : null,
      };
    });
  },

  // A person writes to the Agency Engineer on a request; it's woken to answer.
  'POST /api/runner/requests/message': async (_req, _q, body) => {
    const { id, text: typed } = await body<{ id: number; text: string }>();
    const text = typed && scrub(typed);
    const r = one<{ id: number; status: string; agent_id: string }>('SELECT id, status, agent_id FROM requests WHERE id = ?', Number(id));
    if (!r || r.status !== 'open') throw new Error('That request is closed.');
    await requireMakerOrAdmin(r.agent_id);
    if (!text?.trim()) throw new Error('Nothing to send.');
    postToRequest(r.id, 'you', text.trim());
    // One joined to another's stays with it (one request per connection); the engineer reads it there.
    exec("UPDATE requests SET stage = 'engineer' WHERE id = ? AND joined_to IS NULL", r.id);
    replyToEngineer(r.id, (await readMeta(r.agent_id))?.owner || 'The person', text.trim());
    return { ok: true };
  },

  // Send to your IDE: the request's folder, the agency's tools, the IDE opened (ide.ts).
  'POST /api/runner/requests/ide': async (_req, _q, body) => {
    const { id, ide } = await body<{ id: number; ide: Ide }>();
    // It opens on the host computer, so for whoever's at it; for a request on an agent they made, or an admin.
    if (!currentActor().here) throw new AccessError(403, "Send to opens your AI assistant on the computer the organization runs on, so it only works there.");
    const r = one<{ agent_id: string }>('SELECT agent_id FROM requests WHERE id = ?', Number(id));
    if (r) await requireMakerOrAdmin(r.agent_id);
    return sendToIde(Number(id), ide);
  },

  // Whether the Agency Engineer may write code plugins (docs/integrations.md).
  // The agency's own MCP server, for the person's AI IDE (agency-mcp.ts): its
  // address, and a new one (the old stops working) if it was shared by mistake.
  // Yours: the host computer's own person has the standing one; everyone else their own, acting as them.
  // here: whether this person is at the computer the address is on (it only works there).
  'GET /api/settings/agency-mcp': async () => ({ url: mcpUrlFor(), here: !!currentActor().here }),
  // Your AI assistant (assistant.ts): opens its one-click install for the agency.
  'POST /api/settings/assistant/connect': async (_req, _q, body) => {
    // url: a teammate's address for an organization hosted elsewhere (remote-mcp.ts), on their own computer.
    const { app, url, org } = await body<{ app: Assistant; url?: string; org?: string }>();
    if (!currentActor().here) throw new AccessError(403, "Your AI assistant connects on the computer the organization runs on, so it only works there.");
    if (url && !isRemoteMcpUrl(url)) throw new AccessError(403, 'That address isn’t one of this app’s.');
    return connectAssistant(app, url, url ? org : undefined);
  },
  // The organization's host: one MCP message from a teammate's AI assistant on another computer, as them.
  'POST /api/agency-mcp/rpc': async (_req, _q, body) => {
    const { msg } = await body<{ msg: Rpc }>();
    return (await rpcAs(currentActor(), msg)) ?? {};
  },
  // A teammate's own computer (remote-mcp.ts): their AI assistant's address for an organization
  // hosted elsewhere, and the messages their app carries there and back.
  'POST /api/assistant/remote': async (_req, _q, body) => {
    if (currentActor().via !== 'local') throw new AccessError(403, 'Only from this computer.');
    const { orgId } = await body<{ orgId: string }>();
    return { url: remoteMcpUrl(String(orgId)) };
  },
  'GET /api/assistant/pending': async (_req, q) => {
    if (currentActor().via !== 'local') throw new AccessError(403, 'Only from this computer.');
    return { calls: await takeRemoteMcp(Math.max(0, Math.min(30_000, Number(q.get('wait')) || 0))) };
  },
  'POST /api/assistant/answer': async (_req, _q, body) => {
    if (currentActor().via !== 'local') throw new AccessError(403, 'Only from this computer.');
    const { id, reply, error } = await body<{ id: number; reply?: object | null; error?: string }>();
    answerRemoteMcp(Number(id), reply ?? null, error);
    return { ok: true };
  },
  'POST /api/settings/agency-mcp': async () => ({ url: mcpUrlFor(currentActor(), true) }),
  // Who the host is (until orgs exist, whoever runs the app): agents made from the IDE are theirs.
  'POST /api/settings/host-person': async (_req, _q, body) => {
    const { name, org } = await body<{ name: string; org?: string | null }>();
    if (typeof name === 'string' && realName(name)) setSetting('host_person', name.trim().slice(0, 100));
    // Their organization, if they have one: agents made from the IDE work for it.
    if (org !== undefined) setSetting('host_org', typeof org === 'string' && org.trim() ? org.trim().slice(0, 200) : null);
    return { ok: true };
  },

  // The host's time zone: whose midnight the agency's days start at (clock.ts).
  'GET /api/settings/host-timezone': async () => ({ zone: hostZone(), set: hostZoneSet() }),
  'POST /api/settings/host-timezone': async (_req, _q, body) => {
    const { zone } = await body<{ zone: string }>();
    setHostZone(String(zone ?? ''));
    return { zone: hostZone(), set: true };
  },

  'GET /api/settings/code-plugins': async () => ({ allowed: pluginsAllowed() }),
  'POST /api/settings/code-plugins': async (_req, _q, body) => {
    const { allowed } = await body<{ allowed: boolean }>();
    const was = pluginsAllowed();
    setSetting('code_plugins', !!allowed);
    // Turned on: the Agency Engineer may have requests waiting on exactly this.
    if (allowed && !was) book(FLEET_ENGINEER, 'request reply', 'The person turned on code plugins in Settings. Pick up any request that was waiting on them.');
    return { allowed: pluginsAllowed() };
  },

  // A person's answer: done (with what they did or decided) or turned down.
  // The agent is told at the start of its next run.
  'POST /api/runner/requests/answer': async (_req, _q, body) => {
    const { id, status, answer: typed } = await body<{ id: number; status: 'done' | 'rejected'; answer?: string }>();
    const answer = typed && scrub(typed);
    const r = one<{ agent_id: string }>('SELECT agent_id FROM requests WHERE id = ?', Number(id));
    if (r) await requireMakerOrAdmin(r.agent_id);
    if (await answerRequest(Number(id), status, answer)) {
      const by = currentActor();
      exec('UPDATE requests SET answered_by = ?, answered_by_id = ? WHERE id = ?', by.name, by.id, Number(id));
    }
    return { ok: true };
  },

  // --- Approvals: T2 calls waiting on a person ---
  'GET /api/runner/approvals': async () => ({ approvals: await pendingApprovals() }),
  'POST /api/runner/approvals/decide': async (_req, _q, body) => {
    const { id, decision, note: typed } = await body<{ id: string; decision: 'approved' | 'rejected'; note?: string }>();
    const note = typed && scrub(typed);
    if (decision !== 'approved' && decision !== 'rejected') throw new Error('Approve or reject.');
    const a = one<{ agent_id: string; request: number | null; about: string | null }>(
      "SELECT agent_id, json_extract(args, '$.request_id') AS request, json_extract(args, '$.agent_id') AS about FROM approvals WHERE id = ?",
      String(id),
    );
    if (a) await requireMakerOrAdmin(a.agent_id, a.request == null ? null : Number(a.request), undefined, undefined, a.agent_id === DOCTOR ? a.about : null);
    const by = currentActor();
    return decideApproval(id, decision, note ?? null, book, undefined, undefined, by);
  },

  // --- Events (docs/events.md) ---
  // Every event agents can subscribe to: who listens, its last check, its webhook
  // address; and the tunnel that gives those addresses a public https one.
  'GET /api/events': async () => ({ tunnel: tunnelState(), base: hooksBase(), events: await eventOverview(hooksBase()) }),
  'POST /api/events/tunnel': async (_req, _q, body) => {
    const { on } = await body<{ on: boolean }>();
    return { tunnel: await setTunnel(!!on), base: hooksBase() };
  },
  // The signing secret a service gives for its webhook posts.
  'POST /api/integrations/webhook-secret': async (_req, _q, body) => {
    const { id, secret } = await body<{ id: string; secret: string }>();
    await setWebhookSecret(String(id), String(secret ?? ''));
    return { ok: true };
  },

  // --- Integrations (docs/integrations.md) ---
  'GET /api/integrations': async () => (recheckStale(), { integrations: await listIntegrations(), problems: integrationProblems(), profile: profileStatus() }),
  'POST /api/integrations/connect': async (_req, _q, body) => {
    const { id, key, fields } = await body<{ id: string; key?: string; fields?: Record<string, unknown> }>();
    return connectIntegration(id, key, fields && typeof fields === 'object' ? fields : undefined);
  },
  // Signing in to a service (OAuth): returns its sign-in page, which the app
  // opens; the browser lands back on the server root (index.ts).
  'POST /api/integrations/sign-in': async (_req, _q, body) => {
    const { id, clientId, clientSecret } = await body<{ id: string; clientId?: string; clientSecret?: string }>();
    return startIntegrationSignIn(id, { clientId, clientSecret });
  },
  'POST /api/integrations/disconnect': async (_req, _q, body) => {
    const { id } = await body<{ id: string }>();
    await disconnectIntegration(id);
    return { ok: true };
  },
  // A person adds a remote MCP server by its address (or a full definition).
  'POST /api/integrations/add': async (_req, _q, body) => {
    const b = await body<{ definition?: unknown; name?: string; url?: string; auth?: 'none' | 'bearer' | 'header' | 'signin'; header?: string; key?: string }>();
    // An address, or a command that starts a server on this computer (npx -y ...).
    const where = b.url?.trim() ?? '';
    const isUrl = /^https?:\/\//i.test(where);
    const command = isUrl ? undefined : splitCommand(where);
    // An address without https:// ("mcp.example.com/sse") isn't a command either.
    const bareAddress = /^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(where) && !/\.(exe|cmd|bat|sh|py|js|mjs|ts)$/i.test(where);
    if (!b.definition && !isUrl && (bareAddress || !looksLikeCommand(command ?? [])))
      throw new Error(
        bareAddress
          ?"That isn't a web address or a command. A web address starts with https://."
          : "That isn't a web address or a command. Paste the server's address (https://...) or the command that starts it (like npx -y ...).",
      );
    const local = isUrl ? isLocalAddress(where) : undefined;
    // A command, or a server on the host's own network, runs on the host's computer.
    const def0 = b.definition as { command?: unknown; url?: unknown; local?: unknown } | undefined;
    if (def0 ? !!def0.command || !!def0.local || (typeof def0.url === 'string' && /^https?:\/\//i.test(def0.url) && isLocalAddress(def0.url)) : !isUrl || local)
      requireAdmin(currentActor(), 'A server on the host computer');
    const name =
      b.name?.trim() || (isUrl ? new URL(where).hostname.replace(/^www\.|^mcp\./, '') : (command?.find(a => /server|mcp/i.test(a)) ?? command?.[0] ?? 'local').replace(/^@[^/]+\//, '').replace(/^server-|-mcp$|^mcp-/g, ''));
    const def =
      b.definition ??
      ({
        kind: 'mcp',
        id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mcp',
        name,
        what: isUrl ? `MCP server at ${new URL(where).host}` : `MCP server on this computer: ${where.slice(0, 120)}`,
        ...(isUrl ? { url: where, ...(local ? { local: true } : {}) } : { command }),
        auth:
          b.auth === 'signin'
            ? { type: 'mcp_oauth' }
            : b.auth === 'bearer'
              ? { type: 'bearer' }
              : b.auth === 'header'
                ? { type: 'api_key', header: b.header || 'x-api-key' }
                : { type: 'none' },
      } as const);
    const integration = await addIntegration(def);
    // One that signs in: the app opens its sign-in next (it connects when that lands).
    if (integration.auth.type === 'mcp_oauth') return { id: integration.id, ok: true, signIn: (await startIntegrationSignIn(integration.id, {})).url };
    // Connect straight away, so its tools are discovered.
    const result = await connectIntegration(integration.id, b.key).catch(e => ({ ok: false, message: (e as Error).message }));
    return { id: integration.id, ok: result.ok, message: result.message };
  },
  'POST /api/integrations/remove': async (_req, _q, body) => {
    const { id } = await body<{ id: string }>();
    await removeIntegration(id);
    return { ok: true };
  },
  // Opens the agents' signed-in browser profile so the person can sign in.
  'POST /api/browser/sign-in': async () => openProfileForSignIn(),

  // --- Spend caps (Settings > Usage) ---
  // Spend and runs: today (for the caps) and this calendar month, per agent.
  // A run on a plan is priced as the same model on an API; Ollama costs $0; one
  // whose model has no known price is counted, and its cost reported as unknown.
  // The month is the host's (clock.ts).
  'GET /api/usage': async (_req, q) => {
    const now = Date.now();
    // This calendar month, or the Dashboard's time frame (days back) when asked - the
    // limits are monthly either way.
    const days = Number(q.get('days'));
    const monthStart = days > 0 ? now - Math.min(36_500, days) * 86_400_000 : startOfMonth(now);
    const month = new Map(
      all<{ agent_id: string; spend: number | null; runs: number; unknown: number }>(
        'SELECT agent_id, SUM(cost_usd) AS spend, COUNT(*) AS runs, SUM(cost_usd IS NULL) AS unknown FROM runs WHERE started_at >= ? GROUP BY agent_id',
        monthStart,
      ).map(r => [r.agent_id, r]),
    );
    const agents = [];
    for (const id of await listIds()) {
      const meta = await readMeta(id);
      if (!meta) continue;
      const m = month.get(id);
      agents.push({
        id,
        name: meta.name,
        department: meta.department,
        capUsd: stateOf(id).spend_cap_usd,
        spentTodayUsd: spentToday(now, id),
        monthUsd: m?.spend ?? 0,
        monthRuns: m?.runs ?? 0,
        monthUnknownRuns: m?.unknown ?? 0,
      });
    }
    return { orgCapUsd: getSetting<number | null>('spend_cap_org_usd', null), spentTodayUsd: spentToday(now), agents };
  },
  'POST /api/usage': async (_req, _q, body) => {
    const { orgCapUsd } = await body<{ orgCapUsd: unknown }>();
    setSetting('spend_cap_org_usd', capUsd(orgCapUsd));
    return { ok: true };
  },
};
