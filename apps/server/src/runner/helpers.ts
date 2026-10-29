import { stringify } from 'yaml';
import { readMeta, save } from '../files.js';
import { allChoices, setChoices } from '../models/choice.js';
import { FLEET_ENGINEER } from './agent.js';
import { defaultModels, type Want } from './defaults.js';

// The agency's two helpers (docs/requests.md, docs/integrations.md): built-in
// agents, owned by no one, that make one quick judgement when asked and never
// run on a schedule. Each has a card like any agent - its models (changeable),
// runs, cost - and a DM channel recording what it decided. Stopped, the
// Conductor's requests go straight to the Fleet Engineer and the Security
// Reviewer's plugins can't be proposed.

export const CONDUCTOR = 'conductor';
export const REVIEWER = 'reviewer';

// Every built-in and the kind of model its job wants.
const WANTS: Record<string, Want> = { [FLEET_ENGINEER]: 'strong', [CONDUCTOR]: 'cheap', [REVIEWER]: 'careful' };

const HELPERS = [
  {
    id: CONDUCTOR,
    name: 'Conductor',
    charter: `# CHARTER - Conductor (built in)

The first stop for every request an agent files. It reads the request and the fleet, and either hands the work to an agent that already does it as part of its job (as a task, closing the request) or sends it to the Fleet Engineer - for a new tool, access, a key, a decision, or when it's unsure.

One quick model call per request, on a cheap model. It never runs on a schedule. Stopped, every request goes straight to the Fleet Engineer.
`,
  },
  {
    id: REVIEWER,
    name: 'Security Reviewer',
    charter: `# CHARTER - Security Reviewer (built in)

Reads every code plugin the Fleet Engineer writes before it can be proposed, as an independent attacker: it didn't write the code. A serious finding sends the plugin back; otherwise what it can do on this computer, in plain words, goes on the approval card.

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
  await fillBuiltInModels();
}

// A built-in with no models gets them from what's connected - at start and on
// every tick, so connecting the first AI model sets them all straight away.
// Ones a person picked are left alone.
export async function fillBuiltInModels() {
  const chosen = await allChoices();
  for (const [id, want] of Object.entries(WANTS)) {
    if (chosen[id]?.length || !(await readMeta(id))) continue;
    const models = await defaultModels(want);
    if (models.length) await setChoices(id, models);
  }
}
