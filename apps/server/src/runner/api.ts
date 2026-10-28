import type { IncomingMessage } from 'node:http';
import { listIds, readMeta } from '../files.js';
import { PROVIDERS } from '../models/providers.js';
import { loadAgent } from './agent.js';
import { all, getSetting, one, run as exec, setSetting } from './db.js';
import { LEVELS } from './ferocity.js';
import { spentToday } from './pricing.js';
import { stateOf } from './run.js';
import { abortRun, book, isRunning } from './scheduler.js';

// The runner's routes for the app: each agent's card (ferocity, Drain/Stop,
// real stats), its DM channel, requests, and spend caps (Settings -> Usage).

type Route = (req: IncomingMessage, q: URLSearchParams, body: <T>() => Promise<T>) => Promise<unknown>;

const isId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]+$/.test(id);
const connName = (id: string | null) => PROVIDERS.find(p => p.id === id)?.name ?? id ?? 'Unknown';

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
      // KPI labels ("ideas written") for each output action.
      const labels = new Map((await loadAgent(id))?.output.map(o => [o.action, o.label] as const) ?? []);
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
        output: outputs.map(o => ({ tool: o.tool, label: labels.get(o.tool) ?? o.tool, value: o.n })),
        cost: costs.filter(c => c.connection).map(c => ({ label: connName(c.connection), value: c.usd ?? 0 })),
        costUnknown: costs.some(c => c.unknown > 0),
        decisions: { approved: decisions?.approved ?? 0, rejected: decisions?.rejected ?? 0, expired: decisions?.expired ?? 0 },
        spendCapUsd: st.spend_cap_usd,
      };
    }
    return out;
  },

  // Ferocity, Drain/Stop, a per-agent spend cap.
  'POST /api/runner/agent': async (_req, _q, body) => {
    const b = await body<{ id: string; ferocity?: number; state?: 'active' | 'draining' | 'stopped'; spendCapUsd?: number | null }>();
    if (!isId(b.id)) throw new Error('Unknown agent.');
    stateOf(b.id);
    const now = Date.now();
    if (typeof b.ferocity === 'number' && b.ferocity >= 0 && b.ferocity < LEVELS.length)
      exec('UPDATE agent_state SET ferocity = ?, updated_at = ? WHERE agent_id = ?', Math.floor(b.ferocity), now, b.id);
    if (b.state === 'active' || b.state === 'draining' || b.state === 'stopped') {
      // Draining with nothing running is simply stopped.
      const state = b.state === 'draining' && !isRunning(b.id) ? 'stopped' : b.state;
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
    book(id, 'self-booked', 'A person started this run from the app. Do your job as your Charter says.');
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
    exec("INSERT INTO dm (agent_id, kind, body, at) VALUES (?, 'you', ?, ?)", id, JSON.stringify({ kind: 'you', text: text.trim() }), Date.now());
    book(id, 'your message', text.trim());
    return { ok: true };
  },

  // --- Requests (docs/requests.md) ---
  'GET /api/runner/requests': async () =>
    all('SELECT id, agent_id, run_id, what, why, evidence, expected_effect, status, answer, created_at, answered_at FROM requests ORDER BY created_at DESC'),

  // --- Spend caps (Settings -> Usage) ---
  'GET /api/usage': async () => {
    const now = Date.now();
    const agents = [];
    for (const id of await listIds()) {
      const meta = await readMeta(id);
      if (!meta) continue;
      agents.push({ id, name: meta.name, capUsd: stateOf(id).spend_cap_usd, spentTodayUsd: spentToday(now, id) });
    }
    return { orgCapUsd: getSetting<number | null>('spend_cap_org_usd', null), spentTodayUsd: spentToday(now), agents };
  },
  'POST /api/usage': async (_req, _q, body) => {
    const { orgCapUsd } = await body<{ orgCapUsd: number | null }>();
    setSetting('spend_cap_org_usd', orgCapUsd == null || orgCapUsd < 0 ? null : orgCapUsd);
    return { ok: true };
  },
};
