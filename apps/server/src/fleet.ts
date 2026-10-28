import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DATA } from './files.js';
import { BASELINE, toolId } from './catalog.js';

// What this fleet already has: its agents, and every tool any of them holds
// (catalogue tools and the ones the builder made). The builder reuses these
// by their exact ids instead of making near-duplicates.

export type FleetAgent = { id: string; name: string; department: string; does: string };
export type FleetTool = { id: string; tier: string; description: string; usedBy: string[] };
export type Fleet = { agents: FleetAgent[]; tools: FleetTool[] };

const BASE_IDS = new Set(BASELINE.map(({ server, tool }) => toolId(server, tool.name)));

export async function scanFleet(exceptId?: string): Promise<Fleet> {
  const agents: FleetAgent[] = [];
  const tools = new Map<string, FleetTool>();
  let ids: string[] = [];
  try {
    ids = (await readdir(DATA, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return { agents, tools: [] };
  }
  for (const id of ids) {
    if (id === exceptId) continue;
    try {
      const yaml = parse(await readFile(join(DATA, id, 'TOOLS.yaml'), 'utf8')) as {
        tool_tiers?: Record<string, string>;
        new_tools?: { id: string; description: string }[];
      };
      const charter = await readFile(join(DATA, id, 'CHARTER.md'), 'utf8').catch(() => '');
      const name = /^# CHARTER\s*-\s*(.+)$/m.exec(charter)?.[1]?.trim() ?? id;
      const mission = /## Mission\s+([^\n]+)/.exec(charter)?.[1]?.trim() ?? '';
      const meta = JSON.parse(await readFile(join(DATA, id, 'meta.json'), 'utf8').catch(() => '{}')) as { department?: string };
      agents.push({ id, name, department: meta.department ?? '', does: mission.slice(0, 220) });
      const described = new Map((yaml.new_tools ?? []).map(t => [t.id, t.description]));
      for (const [tid, tier] of Object.entries(yaml.tool_tiers ?? {})) {
        if (BASE_IDS.has(tid)) continue;
        const t = tools.get(tid) ?? { id: tid, tier, description: described.get(tid) ?? '', usedBy: [] };
        if (!t.description && described.has(tid)) t.description = described.get(tid)!;
        t.usedBy.push(name);
        tools.set(tid, t);
      }
    } catch {
      // Not a complete agent folder - skip it.
    }
  }
  return { agents, tools: [...tools.values()] };
}

export function fleetForPrompt(f: Fleet): string {
  const agents = f.agents.length
    ? f.agents.map(a => `- ${a.name} (id ${a.id}${a.department ? `, ${a.department}` : ''}): ${a.does}`).join('\n')
    : '(none yet)';
  const tools = f.tools.length
    ? f.tools
        .map(t => `- ${t.id} [${t.tier}]${t.description ? ` ${t.description}` : ''} - used by ${t.usedBy.join(', ')}`)
        .join('\n')
    : '(none yet)';
  return `Agents already in this fleet (hand work to them with tasks.delegate_task rather than doing their job):
${agents}

Tools already built and in use in this fleet. Reuse these exact ids when they do the job; they behave the same for every agent that holds them:
${tools}`;
}
