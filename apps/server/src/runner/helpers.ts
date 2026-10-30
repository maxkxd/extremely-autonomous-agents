import { stringify } from 'yaml';
import { readMeta, save } from '../files.js';
import { allChoices, setChoices } from '../models/choice.js';
import { FLEET_ENGINEER } from './agent.js';
import { run as exec } from './db.js';
import { availableModels } from '../models/connections.js';
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

// A built-in with no model it can use gets three from what's connected - at
// start and on every tick, so connecting the first AI model sets them all
// straight away, and disconnecting the ones it had moves it to what's left.
// While any of its models is still connected, its models are left alone.
export async function fillBuiltInModels() {
  const avail = await availableModels().catch(() => []);
  if (!avail.length) return;
  const connected = new Set(avail.map(a => a.connection));
  const chosen = await allChoices();
  for (const [id, want] of Object.entries(WANTS)) {
    if ((chosen[id] ?? []).some(c => connected.has(c.connection)) || !(await readMeta(id))) continue;
    const models = pickDefaults(avail, want);
    if (models.length) await setChoices(id, models);
  }
}
