import { parse as parseYaml } from 'yaml';
import { kpiLabels, readMeta, remove, save, type AgentFiles } from './files.js';
import { integrationToolIds } from './integrations/index.js';
import { enqueue } from './jobs.js';
import { removeChoices, setChoices } from './models/choice.js';
import { FLEET_ENGINEER } from './runner/agent.js';
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
  // Tools its builder invented that nothing provides yet go to the Fleet Engineer.
  const invented = (parseYaml(files.tools) as { new_tools?: { id: string; description: string; input_schema: unknown }[] }).new_tools ?? [];
  const live = new Set(integrationToolIds());
  for (const t of invented.filter(t => !live.has(t.id)))
    fileRequest(
      files.id,
      null,
      {
        what: `Build the tool ${t.id}`,
        why: `${files.name}'s builder defined it and nothing provides it yet: ${t.description}`,
        evidence: `Input it expects: ${JSON.stringify(t.input_schema)}`,
      },
      Date.now(),
      (agent, trigger, task) => book(agent, trigger as 'request', task),
      true,
    );
}

export async function deleteAgent(id: string) {
  const m = await readMeta(id);
  if (id === FLEET_ENGINEER || m?.builtIn) throw new Error(`The ${m?.name ?? 'Fleet Engineer'} is part of the agency; it can't be deleted.`);
  await remove(id);
  await removeChoices(id);
  await forgetAgentRuns(id);
}
