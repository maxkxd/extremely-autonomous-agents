import { stringify } from 'yaml';
import { listIds, readMeta, save } from '../files.js';
import { allChoices, setChoices, type ModelChoice } from '../models/choice.js';
import { FLEET_ENGINEER } from './agent.js';
import { getSetting, run as exec } from './db.js';
import { availableModels } from '../models/connections.js';
import { allChecks } from '../models/check.js';
import { choiceKey, type Health } from '../models/health.js';
import { pickDefaults, type Want } from './defaults.js';
import { DOCTOR } from './doctor.js';

// The agency's built-in agents, kept together here because they're different:
// owned by no one, never deleted, no Ferocity, and one day hideable. The
// Agency Engineer (engineer.ts) does real runs; the two helpers below
// (docs/requests.md, docs/integrations.md) make one quick judgement when asked
// and never run on a schedule. Each has a card like any agent - its models (changeable),
// runs, cost - and a DM channel recording what it decided. While the agency
// is stopped, requests wait for the Agency Engineer and plugins can't be proposed.

export const CONDUCTOR = 'conductor';
export const REVIEWER = 'reviewer';
export const HELPER_IDS = [CONDUCTOR, REVIEWER];
export const BUILT_IN_IDS = [FLEET_ENGINEER, DOCTOR, ...HELPER_IDS];

// Every built-in and the kind of model its job wants.
const WANTS: Record<string, Want> = { [FLEET_ENGINEER]: 'strong', [DOCTOR]: 'careful', [CONDUCTOR]: 'cheap', [REVIEWER]: 'careful' };

const HELPERS = [
  {
    id: CONDUCTOR,
    name: 'Agency Conductor',
    charter: `# CHARTER - Agency Conductor (built in)

The first stop for every request an agent files. It reads the request and the fleet, and either hands the work to an agent that already does it as part of its job (as a task, closing the request) or sends it to the Agency Engineer - for a new tool, access, a key, a decision, or when it's unsure.

One quick model call per request, on a cheap model. It never runs on a schedule. Stopped, every request goes straight to the Agency Engineer.
`,
  },
  {
    id: REVIEWER,
    name: 'Agency Reviewer',
    charter: `# CHARTER - Agency Reviewer (built in)

Reads every code plugin the Agency Engineer writes before it can be proposed, as an independent attacker: it didn't write the code. A serious finding sends the plugin back; otherwise what it can do on this computer, in plain words, goes on the approval card.

One model call per plugin, on a careful model. It never runs on a schedule. Stopped, plugins can't be proposed.
`,
  },
];

export async function ensureHelpers() {
  for (const h of HELPERS) {
    const tools = stringify({ agent_id: h.id, models: [], tools_allowed: [], tool_tiers: {}, new_tools: [], limits: { max_runs_per_day: 1000 } });
    await save(
      { id: h.id, name: h.name, department: 'agency', charter: h.charter, tools: `# TOOLS - ${h.name} (built in)\n${tools}`, kpi: 'output: []\n', models: [] },
      { name: h.name, department: 'agency', output: [], status: 'ready', builtIn: true, service: true },
    );
  }
  // No Stop or Standby of their own (the agency's Stop covers them): one set before that is cleared.
  exec(`UPDATE agent_state SET state = 'active' WHERE agent_id IN (${BUILT_IN_IDS.map(() => '?').join(', ')})`, ...BUILT_IN_IDS);
  await fillBuiltInModels();
}

// An agent's models when none of them works: the best working ones first, its
// own behind them while there's room. Null: one of them still works, or nothing does.
export function rescued(
  mine: ModelChoice[],
  working: { connection: string; models: string[] }[],
  works: (c: Pick<ModelChoice, 'connection' | 'model'>) => boolean,
  want: Want,
): ModelChoice[] | null {
  if (mine.some(works)) return null;
  const fresh = pickDefaults(working, want);
  if (!fresh.length) return null;
  return [...fresh, ...mine.filter(c => !fresh.some(f => choiceKey(f) === choiceKey(c)))].slice(0, 3);
}

// An agent none of whose models works gets working ones - at start and on every
// tick, so connecting the first AI model sets the built-ins straight away, and
// a broken one (a key revoked, Claude Code signed out, a model gone) moves every
// agent on it to what still works, without anyone switching each by hand. A
// model "doesn't work" when its connection is gone, its check failed, or it has
// failed 3 times in a row; one that recovers is kept behind the new ones while
// there's room. While any of an agent's models works, they're left alone.
export async function fillBuiltInModels() {
  const avail = await availableModels().catch(() => []);
  if (!avail.length) return;
  const checks = await allChecks().catch(() => ({}) as Record<string, { ok: boolean }>);
  const health = getSetting<Health>('model_health', {});
  const has = (c: Pick<ModelChoice, 'connection' | 'model'>) => !!avail.find(a => a.connection === c.connection)?.models.includes(c.model);
  const works = (c: Pick<ModelChoice, 'connection' | 'model'>) => has(c) && checks[choiceKey(c)]?.ok !== false && (health[choiceKey(c)]?.failures ?? 0) < 3;
  const working = avail.map(a => ({ ...a, models: a.models.filter(m => works({ connection: a.connection, model: m })) })).filter(a => a.models.length);
  if (!working.length) return;
  const chosen = await allChoices();
  for (const id of await listIds()) {
    const mine = chosen[id] ?? [];
    const next = rescued(mine, working, works, WANTS[id] ?? 'strong');
    if (!next) continue;
    const meta = await readMeta(id);
    if (!meta || meta.status === 'setting-up') continue;
    await setChoices(id, next);
    if (mine.length) console.log(`${id}: none of its models worked (${mine.map(choiceKey).join(', ')}); now ${next.map(choiceKey).join(', ')}`);
  }
}
