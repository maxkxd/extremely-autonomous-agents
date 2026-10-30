import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { CATALOG_INDEX, type Tier } from './catalog.js';
import { DATA, listIds, readMeta } from './files.js';
import { setBuiltInLevel } from './runner/db.js';
import { integrationToolInfo } from './integrations/index.js';

// Settings > Tools: every tool the agency's agents use, by a plain name, and how
// much a person is involved when one is used (catalog.ts):
//   T0 - it just runs, nothing logged;
//   T1 - it runs, and the agent says so in its DM channel;
//   T2 - it waits for a person's approval.
// A tool's tier lives in each agent's TOOLS.yaml (tool_tiers); setting it here
// sets it for every agent that has the tool. Of the built-in agents' own tools,
// only the ones that act on the fleet are listed (giving tools, a rule for an
// agent); their reading and drafting are plumbing, not a choice to make.

const TIERS: Tier[] = ['T0', 'T1', 'T2'];
// The built-in agents' actions a person can set the level of, by what they do.
const BUILT_IN_ACTIONS: Record<string, { name: string; does: string }> = {
  'engineer.publish_integration': { name: 'Give agents a new connection', does: 'Turn on a connection the person connected, and give it to the agents waiting for it.' },
  'engineer.give_tools': { name: 'Give an agent tools', does: 'Give an agent tools from a connection that is already on.' },
  'engineer.give_events': { name: 'Wake an agent on events', does: 'Have an agent woken when something happens at a service.' },
  'doctor.propose_rule': { name: "Add a rule to an agent's instructions", does: 'A short rule for a pattern that keeps going wrong.' },
  'doctor.tell_agent': { name: 'Tell an agent something', does: 'Put a note in an agent\'s memory.' },
  'doctor.close_request': { name: 'Close a repeated request', does: "Close an agent's request that is a repeat or a loop." },
};
const DEFAULT_APPROVAL_HOURS = 24;

// "errors.list_issues" -> "List issues"; "send_to_me" -> "Send to me".
const words = (s: string) => {
  const w = s.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

export type ToolView = {
  id: string;
  name: string; // what it does, in a few words
  source: string; // the service or area it's part of
  does: string; // a sentence, no ids
  tier: Tier | 'mixed';
  agents: { id: string; name: string; tier: Tier }[];
};

const toolsFile = (id: string) => join(DATA, id, 'TOOLS.yaml');

async function agentTiers() {
  const out: { id: string; name: string; builtIn: boolean; tiers: Record<string, Tier> }[] = [];
  for (const id of await listIds()) {
    const meta = await readMeta(id);
    if (!meta || meta.service) continue;
    const doc = parseDocument(await readFile(toolsFile(id), 'utf8').catch(() => ''));
    const tiers = (doc.toJSON() as { tool_tiers?: Record<string, Tier> } | null)?.tool_tiers ?? {};
    // A built-in: only its actions on the fleet.
    out.push({ id, name: meta.name, builtIn: !!meta.builtIn, tiers: meta.builtIn ? Object.fromEntries(Object.entries(tiers).filter(([t]) => t in BUILT_IN_ACTIONS)) : tiers });
  }
  return out;
}

export async function listTools(): Promise<ToolView[]> {
  const fromIntegrations = integrationToolInfo();
  const byTool = new Map<string, ToolView>();
  for (const agent of await agentTiers()) {
    for (const [id, tier] of Object.entries(agent.tiers)) {
      if (!TIERS.includes(tier)) continue;
      let t = byTool.get(id);
      if (!t) {
        const [server, ...rest] = id.split('.');
        const known = CATALOG_INDEX.get(id);
        const via = fromIntegrations.get(id);
        const builtIn = BUILT_IN_ACTIONS[id];
        t = {
          id,
          name: builtIn?.name ?? words(rest.join(' ') || id),
          // The catalogue's own tools by their area (Web); others by the service they come through (Gmail); a built-in's by the agent.
          source: builtIn ? agent.name : known ? words(server) : via?.via || words(server),
          does: (builtIn?.does ?? known?.does ?? via?.description ?? '').split('\n')[0].slice(0, 200),
          tier,
          agents: [],
        };
        byTool.set(id, t);
      }
      t.agents.push({ id: agent.id, name: agent.name, tier });
      if (t.tier !== tier) t.tier = 'mixed';
    }
  }
  return [...byTool.values()].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}

// One tool's tier, for every agent that has it. To T2, an agent with no
// approval window for it gets one (how long it waits for a person).
export async function setToolTier(toolId: string, tier: unknown) {
  if (typeof tier !== 'string' || !TIERS.includes(tier as Tier)) throw new Error('The level is T0, T1 or T2.');
  let changed = 0;
  for (const agent of await agentTiers()) {
    if (!(toolId in agent.tiers)) continue;
    // A built-in's files are rewritten on every start: the choice is kept apart too.
    if (agent.builtIn) setBuiltInLevel(agent.id, toolId, tier as Tier);
    const file = toolsFile(agent.id);
    const text = await readFile(file, 'utf8');
    const doc = parseDocument(text);
    doc.setIn(['tool_tiers', toolId], tier);
    if (tier === 'T2' && !doc.hasIn(['approval_windows', toolId])) doc.setIn(['approval_windows', toolId], { window_seconds: DEFAULT_APPROVAL_HOURS * 3600 });
    // The header's summary line for it says the new level too.
    let out = doc.toString();
    const escaped = toolId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`^(#\\s+${escaped} )\\[T[012]\\]`, 'm'), `$1[${tier}]`);
    await writeFile(file, out);
    changed++;
  }
  if (!changed) throw new Error('No agent uses that tool.');
  return { changed };
}
