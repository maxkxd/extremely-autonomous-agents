// A new agent's setup (its card): the connectors its first requests asked for,
// how much each helps it (the Agency Engineer's stars), and how far along the
// connecting is. The agent waits, stopped, until its person first resumes it -
// that ends setup for good.
import { listIntegrations } from '../integrations/index.js';
import { all } from './db.js';

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
export type AgentSetup = { items: SetupItem[]; building: number; progress: number };

export async function setups(): Promise<Record<string, AgentSetup>> {
  const agents = all<{ agent_id: string }>('SELECT agent_id FROM agent_state WHERE setup = 1').map(r => r.agent_id);
  if (!agents.length) return {};
  const connected = new Set((await listIntegrations()).filter(i => i.connected).map(i => i.id));
  const out: Record<string, AgentSetup> = {};
  for (const id of agents) {
    const rows = all<{ id: number; what: string; status: string; stage: string | null; waiting_on: string | null; service: string | null; stars: number | null }>(
      "SELECT id, what, status, stage, waiting_on, service, stars FROM requests WHERE agent_id = ? AND setup = 1 AND status IN ('open', 'done') ORDER BY id",
      id,
    );
    // One line per kind of service (its tools and its events are one connector).
    const items = new Map<string, SetupItem>();
    for (const r of rows) {
      const name = generic(r.service, r.what);
      const done = r.status === 'done' || (!!r.waiting_on && connected.has(r.waiting_on));
      const had = items.get(name);
      const item: SetupItem = had
        ? { ...had, stars: Math.max(had.stars, r.stars ?? 3), connected: had.connected && done, building: had.building || (r.status === 'open' && r.stage === 'engineer') }
        : { name, requestId: r.id, stars: r.stars ?? 3, connected: done, building: r.status === 'open' && r.stage === 'engineer' };
      // "Go to request" opens the one still waiting, if any.
      if (had && !done && had.connected) item.requestId = r.id;
      items.set(name, item);
    }
    const list = [...items.values()].sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name));
    const total = list.reduce((n, i) => n + i.stars, 0);
    out[id] = {
      items: list,
      building: list.filter(i => i.building).length,
      // Weighted by stars: the connectors it can't do without move it most.
      progress: total ? list.filter(i => i.connected).reduce((n, i) => n + i.stars, 0) / total : 1,
    };
  }
  return out;
}
