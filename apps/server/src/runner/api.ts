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
import { FLEET_ENGINEER, loadAgent } from './agent.js';
import { DOCTOR } from './doctor.js';
import { connectFirst } from './connectFirst.js';
import { postToRequest, waitingOn } from './engineer.js';
import { sendToIde, type Ide } from './ide.js';
import { pluginsAllowed } from '../integrations/plugins.js';
import { decideApproval, pendingApprovals } from './approvals.js';
import { openProfileForSignIn, profileStatus } from './browser.js';
import { all, getSetting, one, run as exec, setSetting } from './db.js';
import { APOCALYPTIC_GAP_MS, LEVELS } from './ferocity.js';
import { spentToday } from './pricing.js';
import { hostZone, hostZoneSet, setHostZone, startOfMonth } from './clock.js';
import { mcpUrlFor } from './agency-mcp.js';
import { eventOverview } from './events.js';
import { hooksBase, setTunnel, tunnelState } from './hooks.js';
import { resume as resumeJobs } from '../jobs.js';
import { isPrivateIp } from './net.js';
import { agencyState, stateOf, type AgencyState, type Trigger } from './run.js';
import { abortAll, abortRun, book, isRunning } from './scheduler.js';
import { AccessError, currentActor, requireAdmin, requireMakerOrAdmin } from '../access.js';

// The runner's routes for the app: each agent's card (ferocity, Drain/Stop,
// real stats), its DM channel, requests, and spend caps (Settings -> Usage).

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
      // Expected runs a day at each level, for the card's estimate: its plan's
      // schedules, and at Apocalyptic back-to-back runs of its usual length.
      const avg = one<{ ms: number | null }>(
        "SELECT AVG(ended_at - started_at) AS ms FROM (SELECT ended_at, started_at FROM runs WHERE agent_id = ? AND status = 'succeeded' AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT 20)",
        id,
      )?.ms;
      const runsPerDay = agent
        ? [...agent.ferocity.every_hours.map(h => 24 / h), Math.min(1000, 86_400_000 / ((avg ?? 120_000) + APOCALYPTIC_GAP_MS))]
        : [1, 1.5, 2, 4, 100];
      const perRun = one<{ acts: number | null }>(
        "SELECT AVG(acts) AS acts FROM (SELECT acts FROM runs WHERE agent_id = ? AND status = 'succeeded' ORDER BY started_at DESC LIMIT 20)",
        id,
      )?.acts;
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
        runs: one<{ n: number }>('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ? AND started_at >= ?', id, since)?.n ?? 0,
        lastRun: last ? { at: last.ended_at ?? last.started_at, outcome: last.status === 'running' ? 'running' : last.status } : null,
        output: outputs.map(o => ({ tool: o.tool, label: labels.get(o.tool) ?? outputLabel(o.tool), value: o.n })),
        cost: costs.filter(c => c.connection).map(c => ({ label: connName(c.connection), value: c.usd ?? 0 })),
        costUnknown: costs.some(c => c.unknown > 0),
        decisions: { approved: decisions?.approved ?? 0, rejected: decisions?.rejected ?? 0, expired: decisions?.expired ?? 0 },
        spendCapUsd: st.spend_cap_usd,
        runsPerDay,
        perRun: perRun ?? null, // output actions per run, recently (null: never run)
      };
    }
    return out;
  },

  // The whole agency on standby (nothing starts by itself) or stopped (every
  // run cut short, nothing at all: no building or tailoring either), or active.
  'GET /api/runner/agency': async () => ({ state: agencyState() }),
  // "Connect these first" on the Dashboard: services ranked by the agents they unblock.
  'GET /api/runner/connect-first': async () => connectFirst(),
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
    const b = await body<{ id: string; ferocity?: number; state?: 'active' | 'draining' | 'stopped'; spendCapUsd?: number | null }>();
    if (!isId(b.id)) throw new Error('Unknown agent.');
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
    }
    if (b.spendCapUsd !== undefined) requireAdmin(currentActor(), 'A spend cap');
    if (b.spendCapUsd !== undefined)
      exec('UPDATE agent_state SET spend_cap_usd = ? WHERE agent_id = ?', b.spendCapUsd == null || b.spendCapUsd < 0 ? null : b.spendCapUsd, b.id);
    return { ok: true, state: stateOf(b.id) };
  },

  // Start a run now (for trying an agent out).
  'POST /api/runner/run-now': async (_req, _q, body) => {
    const { id } = await body<{ id: string }>();
    if (!isId(id)) throw new Error('Unknown agent.');
    book(id, 'run now', null);
    return { ok: true };
  },

  // --- DM channel (docs/agent-dms.md) ---
  'GET /api/dm': async (_req, q) => {
    const id = q.get('id');
    if (!isId(id)) return [];
    // In an organisation, an agent's DMs are its maker's and the admins' (access.ts).
    await requireMakerOrAdmin(id, null, currentActor(), 'see its DMs');
    return all<{ kind: string; body: string; at: number }>('SELECT kind, body, at FROM dm WHERE agent_id = ? ORDER BY at, id', id).map(r => ({
      ...(JSON.parse(r.body) as object),
      kind: r.kind,
      at: r.at,
    }));
  },
  'POST /api/dm': async (_req, _q, body) => {
    const { id, text } = await body<{ id: string; text: string }>();
    if (!isId(id) || !text?.trim()) throw new Error('Nothing to send.');
    await requireMakerOrAdmin(id, null, currentActor(), 'message it');
    if ((await readMeta(id))?.service) throw new Error('This helper only records what it decides; it takes no messages.');
    exec("INSERT INTO dm (agent_id, kind, body, at) VALUES (?, 'you', ?, ?)", id, JSON.stringify({ kind: 'you', text: text.trim() }), Date.now());
    book(id, 'your message', text.trim());
    return { ok: true };
  },

  // --- Requests (docs/requests.md) ---
  'GET /api/runner/requests': async () => {
    const rows = all<Record<string, unknown> & { id: number }>(
      'SELECT id, agent_id, run_id, what, why, evidence, expected_effect, status, stage, answer, created_at, answered_at FROM requests ORDER BY created_at DESC',
    );
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
    return rows.map(r => ({
      ...r,
      thread: messages.filter(m => m.request_id === r.id).map(m => ({ from: m.from_who === 'you' ? 'you' : 'engineer', text: m.text, at: m.at })),
      // Its run for this request is going or waiting - not just any run of its.
      engineerBusy: r.stage === 'engineer' && (onIt.running.some(t => mentions(t, r.id)) || onIt.queued.some(t => mentions(t, r.id))),
      // The Requests page shows a request only once it needs the person: the
      // engineer asked them something, handed it to them, or its go-live waits
      // on them. While the engineer is still working it out, it isn't there.
      // Once they've joined in, it stays while the engineer works on their reply.
      needsYou: ['waiting_you', 'approval', 'person'].includes(String(r.stage)) || messages.some(m => m.request_id === r.id && m.from_who === 'you'),
      approvalId: waiting.find(w => Number(w.request) === r.id)?.id ?? null,
      // The connection it waits for the person to connect, so the page can show one item per connection.
      waitingOn: r.stage === 'waiting_you' ? waitingOn(r.id, connections) : null,
    }));
  },

  // A person writes to the Agency Engineer on a request; it's woken to answer.
  'POST /api/runner/requests/message': async (_req, _q, body) => {
    const { id, text } = await body<{ id: number; text: string }>();
    const r = one<{ id: number; status: string; agent_id: string }>('SELECT id, status, agent_id FROM requests WHERE id = ?', Number(id));
    if (!r || r.status !== 'open') throw new Error('That request is closed.');
    await requireMakerOrAdmin(r.agent_id);
    if (!text?.trim()) throw new Error('Nothing to send.');
    postToRequest(r.id, 'you', text.trim());
    exec("UPDATE requests SET stage = 'engineer' WHERE id = ?", r.id);
    replyToEngineer(r.id, (await readMeta(r.agent_id))?.owner ?? 'The person', text.trim());
    return { ok: true };
  },

  // Send to your IDE: the request's folder, the agency's tools, the IDE opened (ide.ts).
  'POST /api/runner/requests/ide': async (_req, _q, body) => {
    const { id, ide } = await body<{ id: number; ide: Ide }>();
    // It opens on the host computer, so for whoever's at it; for a request on an agent they made, or an admin.
    if (!currentActor().here) throw new AccessError(403, 'Send to IDE opens on the host computer. Use your own agency MCP address (Settings > Connectors) instead.');
    const r = one<{ agent_id: string }>('SELECT agent_id FROM requests WHERE id = ?', Number(id));
    if (r) await requireMakerOrAdmin(r.agent_id);
    return sendToIde(Number(id), ide);
  },

  // Whether the Agency Engineer may write code plugins (docs/integrations.md).
  // The agency's own MCP server, for the person's AI IDE (agency-mcp.ts): its
  // address, and a new one (the old stops working) if it was shared by mistake.
  // Yours: the host computer's own person has the standing one; everyone else their own, acting as them.
  'GET /api/settings/agency-mcp': async () => ({ url: mcpUrlFor() }),
  'POST /api/settings/agency-mcp': async () => ({ url: mcpUrlFor(currentActor(), true) }),
  // Who the host is (until orgs exist, whoever runs the app): agents made from the IDE are theirs.
  'POST /api/settings/host-person': async (_req, _q, body) => {
    const { name, org } = await body<{ name: string; org?: string | null }>();
    if (typeof name === 'string' && name.trim()) setSetting('host_person', name.trim().slice(0, 100));
    // Their organisation, if they have one: agents made from the IDE work for it.
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
    const { id, status, answer } = await body<{ id: number; status: 'done' | 'rejected'; answer?: string }>();
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
    const { id, decision, note } = await body<{ id: string; decision: 'approved' | 'rejected'; note?: string }>();
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

  // --- Spend caps (Settings -> Usage) ---
  // Spend and runs: today (for the caps) and this calendar month, per agent.
  // A run on a plan is priced as the same model on an API; Ollama costs $0; one
  // whose model has no known price is counted, and its cost reported as unknown.
  // The month is the host's (clock.ts).
  'GET /api/usage': async () => {
    const now = Date.now();
    const monthStart = startOfMonth(now);
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
    const { orgCapUsd } = await body<{ orgCapUsd: number | null }>();
    setSetting('spend_cap_org_usd', orgCapUsd == null || orgCapUsd < 0 ? null : orgCapUsd);
    return { ok: true };
  },
};
