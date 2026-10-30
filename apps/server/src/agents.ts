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
import { fileRequest, registeredToolIds, requestConnections, serviceLabel } from './runner/tools.js';

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
  // Services its catalogue tools need that aren't connected, one request each.
  for (const what of requestConnections(files.id, files.name, (yaml.tool_tiers ?? {}) as Record<string, Tier>, Date.now(), (agent, trigger, task) => book(agent, trigger as 'request', task))) {
    asked.add(what);
    filed.push(what);
  }
  // Tools nothing provides yet - its builder's inventions, and another agent's
  // nobody has built - one request per service, not per tool: one job for the
  // Agency Engineer. None when that service already has a request open (it
  // sees every tool the agent is missing with it).
  const live = new Set(integrationToolIds());
  const own = new Map((yaml.new_tools ?? []).map(t => [t.id, t]));
  const fleet = await scanFleet(files.id);
  const registered = registeredToolIds();
  const missing = new Map<string, { id: string; does: string; input?: unknown; usedBy?: string[] }[]>();
  for (const id of new Set([...own.keys(), ...Object.keys(yaml.tool_tiers ?? {})])) {
    if (live.has(id)) continue;
    const mine = own.get(id);
    if (!mine && (registered.has(id) || CATALOG_INDEX.has(id) || BASELINE.some(b => toolId(b.server, b.tool.name) === id))) continue;
    const t = fleet.tools.find(x => x.id === id);
    const server = id.split('.')[0];
    missing.set(server, [...(missing.get(server) ?? []), { id, does: mine?.description ?? t?.description ?? '', input: mine?.input_schema, usedBy: t?.usedBy }]);
  }
  for (const [server, tools] of missing) {
    const label = serviceLabel(server, files.id);
    if (asked.has(`Set up ${label}`) || asked.has(`Connect ${label}`)) continue;
    const others = [...new Set(tools.flatMap(t => t.usedBy ?? []))];
    ask(
      `Build the ${label} tools`,
      `${files.name} needs these and nothing provides them yet:\n${tools.map(t => `- ${t.id}${t.does ? `: ${t.does}` : ''}`).join('\n')}`,
      [...tools.filter(t => t.input).map(t => `${t.id} expects: ${JSON.stringify(t.input)}`), ...(others.length ? [`Also used by ${others.join(', ')}.`] : [])].join('\n') || null,
    );
  }
  // Events nothing provides yet: one request per service too.
  const events = new Set(liveEventIds());
  const wanted = new Map<string, { id: string; description: string; how?: string }[]>();
  for (const e of (yaml.new_events ?? []).filter(e => !events.has(e.id))) wanted.set(e.id.split('.')[0], [...(wanted.get(e.id.split('.')[0]) ?? []), e]);
  for (const [server, list] of wanted)
    ask(
      `Set up ${serviceLabel(server, files.id)} events`,
      `${files.name} should wake when these happen:\n${list.map(e => `- ${e.id}: ${e.description}`).join('\n')}`,
      list.filter(e => e.how).map(e => `${e.id} - how the service tells it: ${e.how}`).join('\n') || null,
    );
  return filed;
}

export async function deleteAgent(id: string) {
  const m = await readMeta(id);
  if (id === FLEET_ENGINEER || m?.builtIn) throw new Error(`The ${m?.name ?? 'Agency Engineer'} is part of the agency; it can't be deleted.`);
  await remove(id);
  await removeChoices(id);
  await forgetAgentRuns(id);
}
