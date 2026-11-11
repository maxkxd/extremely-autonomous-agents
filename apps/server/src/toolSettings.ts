import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { CATALOG_INDEX, type Tier } from './catalog.js';
import { DATA, listIds, readMeta } from './files.js';
import { setBuiltInLevel } from './runner/db.js';
import { integrationToolInfo } from './integrations/index.js';
import { ACRONYMS, BUILTIN_IDS } from './runner/tools.js';

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
  'engineer.install_program': { name: 'Install a program', does: "Install a program agents' tools need, like FFmpeg or Python." },
  'doctor.rewrite_instructions': { name: "Fix an agent's instructions", does: 'Rewrites them whole, for a pattern that keeps going wrong.' },
  'doctor.tell_agent': { name: 'Tell an agent something', does: 'Put a note in an agent\'s memory.' },
  'doctor.close_request': { name: 'Close a repeated request', does: "Close an agent's request that is a repeat or a loop." },
  'doctor.tidy_memories': { name: 'Tidy what agents have learned', does: 'Merge memories that repeat each other, and remove or correct one that has turned out wrong - about the organization or a person.' },
};
const DEFAULT_APPROVAL_HOURS = 24;

// "errors.list_issues" -> "List issues"; "send_to_me" -> "Send to me".
const words = (s: string) => {
  const w = s.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

// A service's name: "seo_data" -> "SEO Data", "cms" -> "CMS" (as its card says), not "Seo data".
// The agency's own areas say where they act: two tools both read "Write file",
// one on the person's computer and one in the agent's workspace.
const OWN_AREAS: Record<string, string> = { computer_files: 'This computer', files: "Agent's own files", signed_in_browser: 'Signed-in browser' };
// Tools whose one-word names read like buttons ("Back", "Open"): what they do.
const NAMES: Record<string, string> = {
  'signed_in_browser.open': 'Open a page',
  'signed_in_browser.back': 'Go back a page',
  'signed_in_browser.scroll': 'Scroll the page',
  'signed_in_browser.click': 'Click on a page',
  'signed_in_browser.type': 'Type into a page',
  'signed_in_browser.choose': 'Pick from a dropdown',
  'signed_in_browser.click_to_pay': 'Click to pay',
  'signed_in_browser.click_to_post': 'Click to post publicly',
  'signed_in_browser.click_to_start_tool': 'Click to start a new business tool',
  'signed_in_browser.make_password': 'Make a password for a new account',
  'signed_in_browser.type_password': 'Type a saved password',
  'signed_in_browser.passwords': 'List saved accounts',
  'signed_in_browser.show_person': 'Open the browser on your screen',
};
const service = (s: string) =>
  OWN_AREAS[s] ??
  s
    .split(/[_-]+/)
    .filter(Boolean)
    .map(w => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');

export type ToolView = {
  id: string;
  name: string; // what it does, in a few words
  source: string; // the service or area it's part of
  does: string; // a sentence, no ids
  tier: Tier | 'mixed';
  agents: { id: string; name: string; tier: Tier; ownerId?: string | null }[];
};

const toolsFile = (id: string) => join(DATA, id, 'TOOLS.yaml');

async function agentTiers() {
  const out: { id: string; name: string; builtIn: boolean; ownerId: string | null; tiers: Record<string, Tier> }[] = [];
  for (const id of await listIds()) {
    const meta = await readMeta(id);
    if (!meta || meta.service) continue;
    const doc = parseDocument(await readFile(toolsFile(id), 'utf8').catch(() => ''));
    const tiers = (doc.toJSON() as { tool_tiers?: Record<string, Tier> } | null)?.tool_tiers ?? {};
    // A built-in: only its actions on the fleet.
    out.push({ id, name: meta.name, builtIn: !!meta.builtIn, ownerId: meta.ownerId ?? null, tiers: meta.builtIn ? Object.fromEntries(Object.entries(tiers).filter(([t]) => t in BUILT_IN_ACTIONS)) : tiers });
  }
  return out;
}

export async function listTools(): Promise<ToolView[]> {
  const fromIntegrations = integrationToolInfo();
  const byTool = new Map<string, ToolView>();
  for (const agent of await agentTiers()) {
    for (const [id, tier] of Object.entries(agent.tiers)) {
      // Every agent's own basics (hand work off, remember, book its next run) run at
      // the level the app gives them: a level set here would be ignored, so they aren't listed.
      if (!TIERS.includes(tier) || BUILTIN_IDS.has(id)) continue;
      let t = byTool.get(id);
      if (!t) {
        const [server, ...rest] = id.split('.');
        const known = CATALOG_INDEX.get(id);
        const via = fromIntegrations.get(id);
        const builtIn = BUILT_IN_ACTIONS[id];
        t = {
          id,
          name: builtIn?.name ?? NAMES[id] ?? words(rest.join(' ') || id),
          // The catalogue's own tools by their area (Web); others by the service they come through (Gmail); a built-in's by the agent.
          source: builtIn ? agent.name : known ? service(server) : via?.via || service(server),
          does: (builtIn?.does ?? known?.does ?? via?.description ?? '').split('\n')[0].slice(0, 200),
          tier,
          agents: [],
        };
        byTool.set(id, t);
      }
      t.agents.push({ id: agent.id, name: agent.name, tier, ownerId: agent.builtIn ? null : agent.ownerId });
      if (t.tier !== tier) t.tier = 'mixed';
    }
  }
  return [...byTool.values()].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}

// One tool's tier, for every agent that has it. To T2, an agent with no
// approval window for it gets one (how long it waits for a person).
// onlyFor: a member's account - only their own agents change (an owner or admin's
// change is every agent's).
export async function setToolTier(toolId: string, tier: unknown, onlyFor: string | null = null) {
  if (typeof tier !== 'string' || !TIERS.includes(tier as Tier)) throw new Error('The level is T0, T1 or T2.');
  if (BUILTIN_IDS.has(toolId)) throw new Error("That one's level is set by the app.");
  let changed = 0;
  for (const agent of await agentTiers()) {
    if (!(toolId in agent.tiers)) continue;
    if (onlyFor && (agent.builtIn || agent.ownerId !== onlyFor)) continue;
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
  if (!changed) throw new Error(onlyFor ? 'None of your agents uses that tool.' : 'No agent uses that tool.');
  return { changed };
}
