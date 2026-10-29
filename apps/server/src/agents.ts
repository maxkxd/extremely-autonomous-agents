import { parse as parseYaml } from 'yaml';
import { kpiLabels, readMeta, remove, save, type AgentFiles } from './files.js';
import { integrationToolIds, liveEventIds } from './integrations/index.js';
import { enqueue } from './jobs.js';
import { removeChoices, setChoices } from './models/choice.js';
import { FLEET_ENGINEER } from './runner/agent.js';
import { all } from './runner/db.js';
import { forgetAgentRuns } from './runner/forget.js';
import { book } from './runner/scheduler.js';
import { fileRequest } from './runner/tools.js';

// Adding and removing agents: the app's builder and packs, and the agency's
// MCP server (runner/agency-mcp.ts) for an AI IDE, all come through here.

export async function createAgent(a: { person: string; org: string | null; files: AgentFiles; setup?: { packId: string; index: number } }) {
  const { person, org, files, setup } = a;
  await save(files, {
    name: files.name,
    department: files.department,
    output: kpiLabels(files.kpi),
    status: setup ? 'setting-up' : 'ready',
    owner: person,
    org,
    setup: setup && { ...setup, person, org, attempts: 0 },
  });
  await setChoices(files.id, files.models ?? []);
  if (setup) enqueue(files.id);
  requestWhatsMissing(files);
}

// Tools and events its builder invented that nothing provides yet go to the
// Fleet Engineer - each once (a pack agent asks again after its tailoring).
export function requestWhatsMissing(files: Pick<AgentFiles, 'id' | 'name' | 'tools'>) {
  const yaml = parseYaml(files.tools) as {
    new_tools?: { id: string; description: string; input_schema: unknown }[];
    new_events?: { id: string; description: string; how?: string }[];
  };
  const asked = new Set(all<{ what: string }>('SELECT what FROM requests WHERE agent_id = ?', files.id).map(r => r.what));
  const wake = (agent: string, trigger: string, task: string) => book(agent, trigger as 'request', task);
  const tools = new Set(integrationToolIds());
  for (const t of (yaml.new_tools ?? []).filter(t => !tools.has(t.id))) {
    const what = `Build the tool ${t.id}`;
    if (!asked.has(what))
      fileRequest(files.id, null, { what, why: `${files.name}'s builder defined it and nothing provides it yet: ${t.description}`, evidence: `Input it expects: ${JSON.stringify(t.input_schema)}` }, Date.now(), wake, true);
  }
  const events = new Set(liveEventIds());
  for (const e of (yaml.new_events ?? []).filter(e => !events.has(e.id))) {
    const what = `Set up the event ${e.id}`;
    if (!asked.has(what))
      fileRequest(files.id, null, { what, why: `${files.name} should wake when this happens: ${e.description}`, evidence: e.how ? `How the service tells it: ${e.how}` : null }, Date.now(), wake, true);
  }
}

export async function deleteAgent(id: string) {
  const m = await readMeta(id);
  if (id === FLEET_ENGINEER || m?.builtIn) throw new Error(`The ${m?.name ?? 'Fleet Engineer'} is part of the agency; it can't be deleted.`);
  await remove(id);
  await removeChoices(id);
  await forgetAgentRuns(id);
}
