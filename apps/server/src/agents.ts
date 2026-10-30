import { parse as parseYaml } from 'yaml';
import { currentActor, personFor } from './access.js';
import { BASELINE, CATALOG_INDEX, toolId, type Tier } from './catalog.js';
import { kpiLabels, readMeta, remove, save, type AgentFiles } from './files.js';
import { scanFleet } from './fleet.js';
import { integrationToolIds, liveEventIds } from './integrations/index.js';
import { enqueue } from './jobs.js';
import { removeChoices, setChoices } from './models/choice.js';
import { FLEET_ENGINEER } from './runner/agent.js';
import { all } from './runner/db.js';
import { forgetAgentRuns } from './runner/forget.js';
import { topUpModels } from './runner/defaults.js';
import { book } from './runner/scheduler.js';
import { fileRequest, registeredToolIds, requestConnections } from './runner/tools.js';

// Adding and removing agents: the app's builder and packs, and the agency's
// MCP server (runner/agency-mcp.ts) for an AI IDE, all come through here.

export async function createAgent(a: { person: string; org: string | null; files: AgentFiles; setup?: { packId: string; index: number } }) {
  const { org, files, setup } = a;
  // Someone signed in from their own app: it's theirs, whatever the request says.
  const maker = currentActor();
  const person = personFor(a.person);
  await save(files, {
    name: files.name,
    department: files.department,
    output: kpiLabels(files.kpi),
    status: setup ? 'setting-up' : 'ready',
    owner: person,
    ...(maker.via === 'token' ? { ownerId: maker.id } : {}),
    org,
    setup: setup && { ...setup, person, org, attempts: 0 },
  });
  await setChoices(files.id, await topUpModels(files.models ?? []));
  if (setup) enqueue(files.id);
  return requestWhatsMissing(files);
}

// Tools and events it needs that nothing provides yet go to the Agency Engineer:
// the ones its builder invented, and fleet tools it reuses that another agent
// invented and nobody has built. Each once while a request for it is open (a
// pack agent asks again after its tailoring; one remade under an old id asks
// afresh). Answers with what it asked for.
export async function requestWhatsMissing(files: Pick<AgentFiles, 'id' | 'name' | 'tools'>): Promise<string[]> {
  const yaml = parseYaml(files.tools) as {
    tool_tiers?: Record<string, string>;
    new_tools?: { id: string; description: string; input_schema: unknown }[];
    new_events?: { id: string; description: string; how?: string }[];
  };
  const asked = new Set(all<{ what: string }>("SELECT what FROM requests WHERE agent_id = ? AND status = 'open'", files.id).map(r => r.what));
  const filed: string[] = [];
  const ask = (what: string, why: string, evidence: string | null) => {
    if (asked.has(what)) return;
    asked.add(what);
    fileRequest(files.id, null, { what, why, evidence }, Date.now(), (agent, trigger, task) => book(agent, trigger as 'request', task), true);
    filed.push(what);
  };
  const live = new Set(integrationToolIds());
  const own = new Map((yaml.new_tools ?? []).map(t => [t.id, t]));
  for (const t of own.values())
    if (!live.has(t.id)) ask(`Build the tool ${t.id}`, `${files.name}'s builder defined it and nothing provides it yet: ${t.description}`, `Input it expects: ${JSON.stringify(t.input_schema)}`);
  // Held, but nothing provides it and it isn't its own: another agent's invention, not built.
  const fleet = await scanFleet(files.id);
  const registered = registeredToolIds();
  for (const id of Object.keys(yaml.tool_tiers ?? {})) {
    if (own.has(id) || registered.has(id) || CATALOG_INDEX.has(id) || BASELINE.some(b => toolId(b.server, b.tool.name) === id)) continue;
    const t = fleet.tools.find(x => x.id === id);
    ask(`Build the tool ${id}`, `${files.name} uses it and nothing provides it yet${t?.description ? `: ${t.description}` : '.'}`, t?.usedBy.length ? `Also used by ${t.usedBy.join(', ')}.` : null);
  }
  // Services its catalogue tools need that aren't connected.
  for (const what of requestConnections(files.id, files.name, (yaml.tool_tiers ?? {}) as Record<string, Tier>, Date.now(), (agent, trigger, task) => book(agent, trigger as 'request', task))) {
    asked.add(what);
    filed.push(what);
  }
  const events = new Set(liveEventIds());
  for (const e of (yaml.new_events ?? []).filter(e => !events.has(e.id)))
    ask(`Set up the event ${e.id}`, `${files.name} should wake when this happens: ${e.description}`, e.how ? `How the service tells it: ${e.how}` : null);
  return filed;
}

export async function deleteAgent(id: string) {
  const m = await readMeta(id);
  if (id === FLEET_ENGINEER || m?.builtIn) throw new Error(`The ${m?.name ?? 'Agency Engineer'} is part of the agency; it can't be deleted.`);
  await remove(id);
  await removeChoices(id);
  await forgetAgentRuns(id);
}
