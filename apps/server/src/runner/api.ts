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
  startIntegrationSignIn,
} from '../integrations/index.js';
import { FLEET_ENGINEER, loadAgent } from './agent.js';
import { postToRequest } from './engineer.js';
import { sendToIde, type Ide } from './ide.js';
import { pluginsAllowed } from '../integrations/plugins.js';
import { decideApproval, pendingApprovals } from './approvals.js';
import { openProfileForSignIn, profileStatus } from './browser.js';
import { all, getSetting, one, run as exec, setSetting } from './db.js';
import { APOCALYPTIC_GAP_MS, LEVELS } from './ferocity.js';
import { spentToday } from './pricing.js';
import { hostZone, hostZoneSet, setHostZone, startOfMonth } from './clock.js';
import { agencyMcpUrl, startAgencyMcp } from './agency-mcp.js';
import { isPrivateIp } from './net.js';
import { agencyStopped, stateOf, type Trigger } from './run.js';
import { abortAll, abortRun, book, isRunning } from './scheduler.js';

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
// what the Fleet Engineer drafted for it goes, and so does its go-live card.
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

  // Stop the whole agency: every run cut short, nothing starts, approvals wait.
  'GET /api/runner/agency': async () => ({ stopped: agencyStopped() }),
  'POST /api/runner/agency': async (_req, _q, body) => {
    const { stopped } = await body<{ stopped: boolean }>();
    setSetting('agency_stopped', !!stopped);
    if (stopped) abortAll();
    return { stopped: agencyStopped() };
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
    return all<{ kind: string; body: string; at: number }>('SELECT kind, body, at FROM dm WHERE agent_id = ? ORDER BY at, id', id).map(r => ({
      ...(JSON.parse(r.body) as object),
      kind: r.kind,
      at: r.at,
    }));
  },
  'POST /api/dm': async (_req, _q, body) => {
    const { id, text } = await body<{ id: string; text: string }>();
    if (!isId(id) || !text?.trim()) throw new Error('Nothing to send.');
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
    // The approval a request waits on (the Fleet Engineer's go-live), to go straight to.
    const waiting = all<{ id: string; request: number }>(
      "SELECT id, json_extract(args, '$.request_id') AS request FROM approvals WHERE status = 'pending' AND expires_at > ? AND agent_id = ?",
      Date.now(),
      FLEET_ENGINEER,
    );
    return rows.map(r => ({
      ...r,
      thread: messages.filter(m => m.request_id === r.id).map(m => ({ from: m.from_who === 'you' ? 'you' : 'engineer', text: m.text, at: m.at })),
      engineerBusy: r.stage === 'engineer' && isRunning(FLEET_ENGINEER),
      approvalId: waiting.find(w => Number(w.request) === r.id)?.id ?? null,
    }));
  },

  // A person writes to the Fleet Engineer on a request; it's woken to answer.
  'POST /api/runner/requests/message': async (_req, _q, body) => {
    const { id, text } = await body<{ id: number; text: string }>();
    const r = one<{ id: number; status: string; agent_id: string }>('SELECT id, status, agent_id FROM requests WHERE id = ?', Number(id));
    if (!r || r.status !== 'open') throw new Error('That request is closed.');
    if (!text?.trim()) throw new Error('Nothing to send.');
    postToRequest(r.id, 'you', text.trim());
    exec("UPDATE requests SET stage = 'engineer' WHERE id = ?", r.id);
    book(FLEET_ENGINEER, 'request reply', `${(await readMeta(r.agent_id))?.owner ?? 'The person'} replied on request #${r.id}: "${text.trim().slice(0, 1500)}"`);
    return { ok: true };
  },

  // Send to your IDE: the request's folder, the agency's tools, the IDE opened (ide.ts).
  'POST /api/runner/requests/ide': async (_req, _q, body) => {
    const { id, ide } = await body<{ id: number; ide: Ide }>();
    return sendToIde(Number(id), ide);
  },

  // Whether the Fleet Engineer may write code plugins (docs/integrations.md).
  // The agency's own MCP server, for the person's AI IDE (agency-mcp.ts): its
  // address, and a new one (the old stops working) if it was shared by mistake.
  'GET /api/settings/agency-mcp': async () => ({ url: agencyMcpUrl() }),
  'POST /api/settings/agency-mcp': async () => ({ url: startAgencyMcp(true) }),
  // Who the host is (until orgs exist, whoever runs the app): agents made from the IDE are theirs.
  'POST /api/settings/host-person': async (_req, _q, body) => {
    const { name } = await body<{ name: string }>();
    if (typeof name === 'string' && name.trim()) setSetting('host_person', name.trim().slice(0, 100));
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
    // Turned on: the Fleet Engineer may have requests waiting on exactly this.
    if (allowed && !was) book(FLEET_ENGINEER, 'request reply', 'The person turned on code plugins in Settings. Pick up any request that was waiting on them.');
    return { allowed: pluginsAllowed() };
  },

  // A person's answer: done (with what they did or decided) or turned down.
  // The agent is told at the start of its next run.
  'POST /api/runner/requests/answer': async (_req, _q, body) => {
    const { id, status, answer } = await body<{ id: number; status: 'done' | 'rejected'; answer?: string }>();
    await answerRequest(Number(id), status, answer);
    return { ok: true };
  },

  // --- Approvals: T2 calls waiting on a person ---
  'GET /api/runner/approvals': async () => ({ approvals: await pendingApprovals() }),
  'POST /api/runner/approvals/decide': async (_req, _q, body) => {
    const { id, decision, note } = await body<{ id: string; decision: 'approved' | 'rejected'; note?: string }>();
    if (decision !== 'approved' && decision !== 'rejected') throw new Error('Approve or reject.');
    return decideApproval(id, decision, note ?? null, book);
  },

  // --- Integrations (docs/integrations.md) ---
  'GET /api/integrations': async () => (recheckStale(), { integrations: await listIntegrations(), problems: integrationProblems(), profile: profileStatus() }),
  'POST /api/integrations/connect': async (_req, _q, body) => {
    const { id, key } = await body<{ id: string; key?: string }>();
    return connectIntegration(id, key);
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
