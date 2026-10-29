import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import type { Build } from './builder.js';
import { fitEffort } from './models/caps.js';
import { cleanChoices, type Effort, type ModelChoice } from './models/choice.js';
import { BASELINE, CATALOG_INDEX, toolId, type Tier } from './catalog.js';

// Turns a build into the agent's three files, shaped like the agency
// runner's (docs/agent-creation.md), and writes them on accept.

export const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'agents');

export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'agent';

export type AgentFiles = { id: string; name: string; department: string; charter: string; tools: string; kpi: string; models: ModelChoice[] };

// Kept beside the files: what the app shows on the card, and set-up state.
export type Meta = {
  name: string;
  department: string;
  output: string[]; // KPI labels
  status: 'ready' | 'setting-up' | 'generic';
  owner?: string; // the person it works for
  builtIn?: boolean; // part of the agency itself (the Fleet Engineer), owned by no one
  service?: boolean; // a built-in helper (Conductor, Security Reviewer): runs only when called, never scheduled
  org?: string | null; // their organisation, if any
  setup?: { packId: string; index: number; person: string; org: string | null; attempts: number };
};

// fleetIds: tools other agents in this fleet already hold, which can be reused.
// available: the connected models the build's choices must come from.
export function compose(
  b: Build,
  id: string,
  fleetIds: Set<string> = new Set(),
  available: { connection: string; models: string[]; efforts?: Record<string, Effort[]> }[] = [],
  eventIds: Set<string> = new Set(), // events a connected service provides now
): AgentFiles {
  // Only connected models, each at the nearest effort it actually takes.
  const models = cleanChoices(b.models ?? []).flatMap(m => {
    const a = available.find(x => x.connection === m.connection && x.models.includes(m.model));
    return a ? [{ ...m, effort: fitEffort(m.effort, a.efforts?.[m.model] ?? []) }] : [];
  });
  const newIds = new Set(b.new_tools.map(t => toolId(t.server, t.name)));
  const newEventIds = new Set((b.new_events ?? []).map(e => toolId(e.server, e.name)));
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
    // Up to three, in order; the runner falls back down the list (models/health.ts).
    models,
    servers: [...new Set(Object.keys(tiers).map(t => t.split('.')[0]))],
    tools_allowed: Object.keys(tiers),
    tool_tiers: tiers,
    approval_windows: windows,
    // What wakes it besides its schedule (docs/events.md): events that exist, and its own new ones.
    events: [...new Set([...(b.events ?? []).map(e => e.id).filter(e => eventIds.has(e) || newEventIds.has(e)), ...newEventIds])],
    new_events: (b.new_events ?? []).map(e => ({ id: toolId(e.server, e.name), description: e.description, how: e.how_detected })),
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
    // How hard it works at each ferocity level (docs/runner.md). Read by the
    // runner; agents built without one use its defaults.
    ...(b.ferocity ? { ferocity: ferocityPlan(b.ferocity, tiers) } : {}),
    natural_limits: (b.natural_limits ?? [])
      .filter(l => tiers[l.tool] && l.max > 0 && l.per_hours > 0)
      .map(l => ({ tool: l.tool, max: Math.round(l.max), per_hours: l.per_hours, why: l.why })),
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
    models,
    charter: b.charter.trim() + '\n',
    tools: `# TOOLS - ${b.name} (${id})\n# Written by the agent builder.\n#\n${why}\n${stringify(tools)}`,
    kpi: `# KPI - ${b.name}: successful calls of these actions are its output.\n${stringify(kpi)}`,
  };
}

// The builder's ferocity plan in the runner's shape (runner/agent.ts). Floors
// only count tools the agent holds; schedules never get faster than every
// 15 minutes below Apocalyptic.
function ferocityPlan(f: NonNullable<Build['ferocity']>, tiers: Record<string, Tier>) {
  const hours = (h: number, fallback: number) => (Number.isFinite(h) && h > 0 ? Math.max(0.25, h) : fallback);
  const chill = hours(f.chill_every_hours, 24);
  const whole = (n: number, min: number) => Math.max(min, Math.round(Number.isFinite(n) ? n : min));
  const floor = whole(f.relentless_floor, 1);
  return {
    every_hours: [chill, hours(f.steady_every_hours, chill / 1.5), hours(f.driven_every_hours, chill / 2), hours(f.relentless_every_hours, chill / 4)],
    soft_floor: whole(f.driven_soft_floor, 1),
    floor,
    apocalyptic_floor: Math.max(whole(f.apocalyptic_floor, floor * 3), floor + 1),
    counts: f.counts.filter(id => tiers[id]),
    hint: f.hint,
    extra_effort: f.extra_effort,
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
