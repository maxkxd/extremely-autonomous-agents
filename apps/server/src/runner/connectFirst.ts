// "Connect these first" (the Dashboard): the services agents are waiting on,
// ranked by how many agents each one unblocks - one GitHub token unblocked eight
// agents in a test, but sat in Requests looking like any other item. Built-ins
// show at once; a service the Agency Engineer still has to build shows as being
// set up, with the agents it will unblock, so the whole picture is there on day one.
import { listIds } from '../files.js';
import { listIntegrations, toolIdsOf } from '../integrations/index.js';
import { loadAgent } from './agent.js';
import { canCount } from './ferocity.js';
import { BUILT_IN_IDS } from './helpers.js';
import { all } from './db.js';
import { heldTools, toolsFor } from './tools.js';

type Integ = Awaited<ReturnType<typeof listIntegrations>>[number];
export type ConnectService = {
  key: string;
  name: string;
  integrationId: string | null; // to open in Settings; null while it's being set up
  connected: boolean;
  settingUp: boolean; // the Agency Engineer is building it
  needs: 'sign-in' | 'a key' | 'a few details' | null;
  agents: { id: string; name: string }[];
};

// Quickest to connect first, when two unblock as many agents.
const EFFORT = { 'sign-in': 0, 'a key': 1, 'a few details': 2 } as const;

export async function connectFirst() {
  const integrations = await listIntegrations();
  const provider = new Map<string, Integ>();
  // A tool more than one connection offers (web search: Brave, Tavily) is served by
  // a connected one if any, else a live one before a draft.
  const rank = (i: Integ) => (i.connected ? 2 : 0) + (i.draft ? 0 : 1);
  for (const i of integrations) for (const t of toolIdsOf(i.id)) if (!provider.has(t) || rank(i) > rank(provider.get(t)!)) provider.set(t, i);
  const byId = new Map(integrations.map(i => [i.id, i]));
  const services = new Map<string, ConnectService>();
  const service = (key: string, name: string, integ: Integ | null): ConnectService => {
    let s = services.get(key);
    if (!s) {
      const needs: ConnectService['needs'] = !integ ? null : integ.signIn ? 'sign-in' : integ.fields ? 'a few details' : integ.needsKey ? 'a key' : null;
      s = { key, name, integrationId: integ?.id ?? null, connected: !!integ?.connected, settingUp: !integ, needs, agents: [] };
      services.set(key, s);
    }
    return s;
  };
  let unlocked = 0;
  let total = 0;
  const names = new Map<string, string>();
  const add = (s: ConnectService, id: string, name: string) => {
    if (!s.agents.some(a => a.id === id)) s.agents.push({ id, name });
  };
  for (const id of await listIds()) {
    if (BUILT_IN_IDS.includes(id)) continue;
    const agent = await loadAgent(id);
    if (!agent) continue;
    total++;
    names.set(id, agent.name);
    const { ids } = toolsFor(agent);
    if (canCount(agent, new Set(ids.values()))) unlocked++;
    // The connections serving what it holds (an extension counts as its parent).
    for (const tool of Object.keys(heldTools(agent))) {
      const p = provider.get(tool);
      const integ = p?.keyFrom ? (byId.get(p.keyFrom.id) ?? p) : p;
      if (integ) add(service(integ.id, integ.name, integ), id, agent.name);
    }
  }
  // What the Agency Engineer has said it waits on (a code draft's tools aren't
  // known until it's approved, so this is how its agents are found)...
  for (const r of all<{ agent_id: string; waiting_on: string }>("SELECT agent_id, waiting_on FROM requests WHERE status = 'open' AND waiting_on IS NOT NULL")) {
    const p = byId.get(r.waiting_on);
    const integ = p?.keyFrom ? (byId.get(p.keyFrom.id) ?? p) : p;
    if (integ && names.has(r.agent_id)) add(service(integ.id, integ.name, integ), r.agent_id, names.get(r.agent_id)!);
  }
  // ...and what it is still building, by the request's own name ("Set up Stripe").
  // A request's name ("Drive", "Zoho", "analytics (PostHog, GA)") is matched to a
  // connection already listed when either name contains the other, or one of its
  // options does - so Google Drive isn't listed again as "Drive being set up".
  const match = (label: string) => {
    const l = label.toLowerCase();
    const opts = [l.replace(/\s*\(.*\)\s*/, '').trim(), ...(/\(([^)]*)\)/.exec(l)?.[1].split(/,|or/).map(o => o.trim()) ?? [])].filter(o => o.length > 1);
    const found = [...services.values()].filter(s => {
      const n = s.name.toLowerCase();
      return opts.some(o => n === o || n.includes(o) || o.includes(n));
    });
    return found.sort((x, y) => x.name.length - y.name.length)[0];
  };
  for (const r of all<{ agent_id: string; what: string }>("SELECT agent_id, what FROM requests WHERE status = 'open' AND stage = 'engineer' AND waiting_on IS NULL")) {
    const m = /^(?:Set up|Connect|Build the) (.+?)(?: tools(?: and events)?| events)?$/.exec(r.what);
    if (!m || !names.has(r.agent_id) || /^Fix the tool/.test(r.what)) continue;
    const name = m[1].replace(/^(a|an|the) /i, '');
    add(match(name) ?? service(`build:${name.toLowerCase()}`, name, null), r.agent_id, names.get(r.agent_id)!);
  }
  const list = [...services.values()].filter(s => s.agents.length);
  list.sort(
    (a, b) =>
      Number(a.connected) - Number(b.connected) ||
      Number(a.settingUp) - Number(b.settingUp) ||
      b.agents.length - a.agents.length ||
      (a.needs ? EFFORT[a.needs] : 3) - (b.needs ? EFFORT[b.needs] : 3) ||
      a.name.localeCompare(b.name),
  );
  return {
    services: list,
    agents: { unlocked, total },
    connections: { done: list.filter(s => s.connected).length, total: list.length },
  };
}
