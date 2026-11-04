// A new agent's setup (its card): the connectors its first requests asked for,
// how much each helps it (the Agency Engineer's stars), and how far along the
// connecting is. The agent waits, stopped, until its person first resumes it -
// that ends setup for good.
import { listIntegrations } from '../integrations/index.js';
import { all, one, run as exec } from './db.js';

// On the card a connector goes by what it is, not a product the person may not
// use ("CRM", not "HubSpot" - they may be on Salesforce); its request says which.
const GENERIC: Record<string, string> = {
  crm: 'CRM',
  helpdesk: 'Help desk',
  xero: 'Accounting',
  quickbooks: 'Accounting',
  accounting: 'Accounting',
  stripe: 'Payments',
  billing: 'Payments',
  analytics: 'Analytics',
  posthog: 'Analytics',
  ads: 'Ads',
  google_ads: 'Ads',
  social: 'Social scheduling',
  buffer: 'Social scheduling',
  github: 'Code repository',
  docs: 'Docs & sheets',
  drive: 'Docs & sheets',
  gmail: 'Email',
  email: 'Email',
  calendar: 'Calendar',
  web: 'Web search',
  enrich: 'Contact enrichment',
  cms: 'Website',
  linkedin: 'LinkedIn',
  slack: 'Team chat',
  sentry: 'Error tracking',
  aws: 'Cloud hosting',
  vercel: 'Web hosting',
  pagespeed: 'Site speed',
  search_console: 'Search rankings',
  dataforseo: 'SEO data',
  uptime: 'Uptime checks',
  bullmq: 'Job queues',
};
const generic = (service: string | null, what: string) =>
  (service && GENERIC[service]) ??
  what
    .replace(/^(Connect|Set up)\s+/i, '')
    .replace(/\s+events$/i, '')
    .replace(/\s*\(.*\)\s*/, '')
    .replace(/^(a|an|the)\s+/i, '')
    .replace(/^./, c => c.toUpperCase());

export type SetupItem = { name: string; requestId: number; stars: number; connected: boolean; building: boolean };
// ready: everything it needs is connected - it waits for its person to press Start.
export type AgentSetup = { items: SetupItem[]; building: number; progress: number; ready: boolean };

export async function setups(): Promise<Record<string, AgentSetup>> {
  const agents = all<{ agent_id: string }>('SELECT agent_id FROM agent_state WHERE setup = 1').map(r => r.agent_id);
  if (!agents.length) return {};
  const connected = new Set((await listIntegrations()).filter(i => i.connected).map(i => i.id));
  const out: Record<string, AgentSetup> = {};
  for (const id of agents) {
    const rows = all<{ id: number; what: string; status: string; stage: string | null; waiting_on: string | null; service: string | null; stars: number | null; setup_name: string | null }>(
      // One joined to another agent's (one request per connection) stands as that one does.
      `SELECT r.id, r.what, r.status, CASE WHEN r.stage = 'joined' THEN p.stage ELSE r.stage END AS stage, COALESCE(r.waiting_on, p.waiting_on) AS waiting_on, r.service, COALESCE(r.stars, p.stars) AS stars, r.setup_name
       FROM requests r LEFT JOIN requests p ON p.id = r.joined_to WHERE r.agent_id = ? AND r.setup = 1 AND r.status IN ('open', 'done') ORDER BY r.id`,
      id,
    );
    // One line per kind of service (its tools and its events are one connector).
    // No stars until the Agency Engineer has rated it (ask_for_connection).
    const items = new Map<string, SetupItem>();
    for (const r of rows) {
      // The Agency Engineer's name for it, once the person's answer changed what it is.
      const name = r.setup_name || generic(r.service, r.what);
      const done = r.status === 'done' || (!!r.waiting_on && connected.has(r.waiting_on));
      const had = items.get(name);
      const item: SetupItem = had
        ? { ...had, stars: Math.max(had.stars, r.stars ?? 0), connected: had.connected && done, building: had.building || (r.status === 'open' && r.stage === 'engineer') }
        : { name, requestId: r.id, stars: r.stars ?? 0, connected: done, building: r.status === 'open' && r.stage === 'engineer' };
      // "Go to request" opens the one still waiting, if any.
      if (had && !done && had.connected) item.requestId = r.id;
      items.set(name, item);
    }
    const list = [...items.values()].sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));
    // Unrated ones count as middling, so a rating coming in doesn't move the bar.
    const weight = (i: SetupItem) => i.stars || 3;
    const total = list.reduce((n, i) => n + weight(i), 0);
    const building = list.filter(i => i.building).length;
    out[id] = {
      items: list,
      building,
      // Weighted by stars: the connectors it can't do without move it most.
      progress: total ? list.filter(i => i.connected).reduce((n, i) => n + weight(i), 0) / total : 1,
      ready: !building && list.every(i => i.connected) && !refusedAll(id),
    };
  }
  return out;
}

// Every one turned down: nothing it needs is there, so it isn't "ready" either
// (it would start with no tools at all) - its person resumes it if they want.
const refusedAll = (id: string) =>
  one<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE agent_id = ? AND setup = 1 AND status = 'done'", id)?.n === 0 &&
  (one<{ n: number }>("SELECT COUNT(*) AS n FROM requests WHERE agent_id = ? AND setup = 1 AND status = 'rejected'", id)?.n ?? 0) > 0;
// A new agent never starts by itself: once its setup is ready its card says Start,
// and pressing it ends the setup (api.ts) - it used to resume itself unannounced.
