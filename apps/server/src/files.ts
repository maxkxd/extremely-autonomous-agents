import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import type { Build } from './builder.js';
import { BASELINE, CATALOG_INDEX, toolId, type Tier } from './catalog.js';

// Turns a build into the agent's three files, shaped like the agency
// runner's (docs/agent-creation.md), and writes them on accept.

export const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'agents');

export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'agent';

export type AgentFiles = { id: string; name: string; department: string; charter: string; tools: string; kpi: string };

// Kept beside the files: what the app shows on the card, and set-up state.
export type Meta = {
  name: string;
  department: string;
  output: string[]; // KPI labels
  status: 'ready' | 'setting-up' | 'generic';
  setup?: { packId: string; index: number; person: string; org: string | null; attempts: number };
};

// fleetIds: tools other agents in this fleet already hold, which can be reused.
export function compose(b: Build, id: string, fleetIds: Set<string> = new Set()): AgentFiles {
  const newIds = new Set(b.new_tools.map(t => toolId(t.server, t.name)));
  // Only tools that exist: the fleet's, the catalogue's, or ones this build defines.
  const picked = b.tools.filter(t => fleetIds.has(t.id) || CATALOG_INDEX.has(t.id) || newIds.has(t.id));
  const tiers: Record<string, Tier> = {};
  for (const { server, tool } of BASELINE) tiers[toolId(server, tool.name)] = tool.tier;
  for (const t of picked) tiers[t.id] = t.tier;

  const hours = new Map(b.approval_hours.map(a => [a.id, a.hours]));
  const windows: Record<string, { window_seconds: number; on_timeout: 'expire' }> = {};
  for (const t of picked)
    if (t.tier === 'T2') windows[t.id] = { window_seconds: Math.round((hours.get(t.id) ?? 24) * 3600), on_timeout: 'expire' };

  const tools = {
    agent_id: id,
    model: b.model,
    servers: [...new Set(Object.keys(tiers).map(t => t.split('.')[0]))],
    tools_allowed: Object.keys(tiers),
    tool_tiers: tiers,
    approval_windows: windows,
    new_tools: b.new_tools.map(t => ({
      id: toolId(t.server, t.name),
      description: t.description,
      input_schema: safeJson(t.input_schema),
      how_it_works: t.how_it_works,
      status: 'built',
    })),
    // The runaway backstop, NOT the cadence. Cadence is the agent's ferocity.
    limits: { max_runs_per_day: Math.max(1, Math.round(b.max_runs_per_day)) },
    kill_switch_scope_keys: ['fleet:*', `department:${b.department}`, `agent:${id}`],
  };
  const kpi = {
    agent_id: id,
    output: b.kpi.filter(k => tiers[k.id]).map(k => ({ action: k.id, label: k.label })),
  };
  const why = picked.map(t => `#   ${t.id} [${t.tier}] - ${t.why}`).join('\n');
  return {
    id,
    name: b.name,
    department: b.department,
    charter: b.charter.trim() + '\n',
    tools: `# TOOLS - ${b.name} (${id})\n# Written by the agent builder.\n#\n${why}\n${stringify(tools)}`,
    kpi: `# KPI - ${b.name}: successful calls of these actions are its output.\n${stringify(kpi)}`,
  };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { type: 'object', description: s };
  }
}

export async function save(files: AgentFiles, meta: Meta) {
  const dir = join(DATA, slug(files.id));
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, 'CHARTER.md'), files.charter),
    writeFile(join(dir, 'TOOLS.yaml'), files.tools),
    writeFile(join(dir, 'KPI.yaml'), files.kpi),
  ]);
  await writeMeta(files.id, meta);
  return dir;
}

export const kpiLabels = (kpiYaml: string) =>
  ((parse(kpiYaml) as { output?: { label: string }[] }).output ?? []).map(o => o.label);

export async function readMeta(id: string): Promise<Meta | null> {
  try {
    return JSON.parse(await readFile(join(DATA, slug(id), 'meta.json'), 'utf8')) as Meta;
  } catch {
    return null;
  }
}

export const writeMeta = (id: string, meta: Meta) =>
  writeFile(join(DATA, slug(id), 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

export async function listIds(): Promise<string[]> {
  try {
    return (await readdir(DATA, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
  } catch {
    return [];
  }
}

// Deleting an agent removes its files for good. Placeholder agents have none.
export async function remove(id: string) {
  if (id !== slug(id)) throw new Error('Bad agent id');
  await rm(join(DATA, id), { recursive: true, force: true });
}
