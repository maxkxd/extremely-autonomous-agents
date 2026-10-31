import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DATA, readMeta, slug } from '../files.js';
import type { Tier } from '../catalog.js';
import { allChoices, cleanChoices, type ModelChoice } from '../models/choice.js';

// An agent as the runner sees it: its files (docs/agent-creation.md) plus the
// ferocity plan and natural limits the builder wrote into TOOLS.yaml
// (docs/runner.md). Agents built before those existed get the defaults.

// The built-in agent that builds tools and integrations (runner/engineer.ts).
export const FLEET_ENGINEER = 'fleet';

export type NaturalLimit = { tool: string; max: number; per_hours: number; why?: string };

// The builder's numbers for this agent, per ferocity level (docs/runner.md).
export type FerocityPlan = {
  every_hours: [number, number, number, number]; // Chill, Steady, Driven, Relentless (Apocalyptic has none)
  soft_floor: number; // Driven: one gentle nudge below this
  floor: number; // Relentless
  apocalyptic_floor: number; // out of reach on purpose
  counts: string[]; // the actions that count toward a floor (server.tool)
  hint: string; // where else to look, sent with a nudge
  extra_effort: string; // what more output means for this job, above Chill
};

export type AgentDef = {
  id: string;
  name: string;
  department: string;
  owner: string | null; // the person it works for
  org: string | null;
  charter: string;
  models: ModelChoice[];
  tiers: Record<string, Tier>; // every tool it may call
  approvalHours: Record<string, number>;
  newTools: { id: string; description: string; input_schema: unknown }[];
  // The events that wake it (docs/events.md), and ones its builder invented that nothing provides yet.
  events: string[];
  newEvents: { id: string; description: string; how: string }[];
  output: { action: string; label: string }[]; // KPI
  maxRunsPerDay: number;
  ferocity: FerocityPlan;
  limits: NaturalLimit[];
};

export const DEFAULT_PLAN: FerocityPlan = {
  every_hours: [24, 16, 12, 6],
  soft_floor: 3,
  floor: 10,
  apocalyptic_floor: 40,
  counts: [],
  hint: 'Turn to sources and approaches you have not used this run.',
  extra_effort: 'Put the extra effort into work that makes your job better: prepare ahead, improve what you have, and widen your reach.',
};

type ToolsYaml = {
  models?: unknown;
  tool_tiers?: Record<string, Tier>;
  approval_windows?: Record<string, { window_seconds?: number }>;
  new_tools?: { id: string; description: string; input_schema: unknown }[];
  events?: string[];
  new_events?: { id: string; description: string; how?: string }[];
  limits?: { max_runs_per_day?: number };
  ferocity?: Partial<FerocityPlan>;
  natural_limits?: NaturalLimit[];
};

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback);

// Real outcomes only. Telling the person isn't output (a blocked Revenue Ops'
// only way to its target was to email Max over and over), and neither is the
// agent's own workspace, memory or plumbing (Outreach wrote 106 files to reach 15).
const NOT_OUTPUT = new Set(['gmail.send_to_me']);
const notOutput = (c: string) => NOT_OUTPUT.has(c) || /^(files|memory|tasks|requests|ops)\./.test(c);

export function planFrom(raw: Partial<FerocityPlan> | undefined, output: string[]): FerocityPlan {
  const p = raw ?? {};
  const every = Array.isArray(p.every_hours) && p.every_hours.length === 4 ? p.every_hours : DEFAULT_PLAN.every_hours;
  const given = Array.isArray(p.counts) && p.counts.length ? p.counts.map(String) : output;
  let counts = given.filter(c => !notOutput(c));
  // A plan that counted only its workspace counts its KPI's real actions instead;
  // its numbers were sized for files, so they're scaled down to a quarter.
  const rescaled = !counts.length && given.length > 0;
  if (rescaled) counts = output.filter(c => !notOutput(c));
  const scale = (n: number) => (rescaled ? Math.max(1, Math.round(n / 4)) : n);
  const given_floor = num(p.floor, DEFAULT_PLAN.floor);
  return {
    every_hours: every.map((h, i) => num(h, DEFAULT_PLAN.every_hours[i])) as FerocityPlan['every_hours'],
    soft_floor: scale(num(p.soft_floor, Math.max(1, Math.round(given_floor / 3)))),
    floor: scale(given_floor),
    apocalyptic_floor: scale(num(p.apocalyptic_floor, given_floor * 3)),
    counts,
    hint: typeof p.hint === 'string' && p.hint.trim() ? p.hint : DEFAULT_PLAN.hint,
    extra_effort: typeof p.extra_effort === 'string' && p.extra_effort.trim() ? p.extra_effort : DEFAULT_PLAN.extra_effort,
  };
}

export async function loadAgent(id: string): Promise<AgentDef | null> {
  const dir = join(DATA, slug(id));
  const meta = await readMeta(id);
  if (!meta) return null;
  try {
    const [charter, toolsText, kpiText] = await Promise.all(
      ['CHARTER.md', 'TOOLS.yaml', 'KPI.yaml'].map(f => readFile(join(dir, f), 'utf8')),
    );
    const tools = (parse(toolsText) ?? {}) as ToolsYaml;
    const kpi = (parse(kpiText) ?? {}) as { output?: { action: string; label: string }[] };
    const output = kpi.output ?? [];
    const approvalHours: Record<string, number> = {};
    for (const [tool, w] of Object.entries(tools.approval_windows ?? {})) approvalHours[tool] = (w.window_seconds ?? 86400) / 3600;
    return {
      id: slug(id),
      name: meta.name,
      department: meta.department,
      owner: meta.owner ?? meta.setup?.person ?? null,
      org: meta.org ?? meta.setup?.org ?? null,
      charter,
      // The models picked on its card win; the builder's choice is the default.
      models: cleanChoices((await allChoices())[slug(id)] ?? tools.models),
      tiers: tools.tool_tiers ?? {},
      approvalHours,
      newTools: tools.new_tools ?? [],
      events: (tools.events ?? []).filter(e => typeof e === 'string'),
      newEvents: (tools.new_events ?? []).filter(e => e && typeof e.id === 'string').map(e => ({ id: e.id, description: String(e.description ?? ''), how: String(e.how ?? '') })),
      output,
      maxRunsPerDay: num(tools.limits?.max_runs_per_day, 24),
      ferocity: planFrom(tools.ferocity, output.map(o => o.action)),
      limits: (tools.natural_limits ?? []).filter(l => l && typeof l.tool === 'string' && num(l.max, 0) > 0),
    };
  } catch {
    return null;
  }
}
