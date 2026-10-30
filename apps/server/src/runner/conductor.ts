import { listIds, readMeta } from '../files.js';
import { integrationToolIds } from '../integrations/index.js';
import { FLEET_ENGINEER, loadAgent } from './agent.js';
import { one, run as exec } from './db.js';
import { postToRequest } from './engineer.js';
import { CONDUCTOR } from './helpers.js';
import { stateOf } from './run.js';
import { ask, HelperStopped, jsonIn } from './quick.js';
import { setRequestRouter, type Wake } from './tools.js';

// The Agency Conductor (docs/requests.md): the first stop for a request, so the
// common case doesn't cost a Agency Engineer run. One cheap model call reads
// the request and the fleet: if an agent that already does this as part of its
// job (and holds the tools) can take it, it's handed over as a task and the
// request closes; anything else - a tool, access, a decision - goes to the
// Agency Engineer. Unsure, or the call fails: the Agency Engineer.

const SYSTEM = `You route requests in an AI agency. An agent filed a request for something it can't do itself. Decide who takes it:
- "agent": another agent in the fleet ALREADY does exactly this as part of its job and holds the tools for it, so handing the work to it gets it done now. Only a genuinely related agent - not one that merely could, and never one whose job is unrelated (customer support doesn't send outreach emails).
- "engineer": anything else - a new tool, an integration, access, a key, a decision, or you're not sure.
Refer to people by name or as "they" - never "he" or "she".
Answer with JSON only: {"route":"agent"|"engineer","agent_id":"<id, for agent>","task":"<for agent: the work to hand over, with everything it needs>","why":"<one sentence>"}`;

type Decision = { route: 'agent' | 'engineer'; agent_id?: string; task?: string; why?: string };

async function fleetFor(requester: string): Promise<string> {
  const lines: string[] = [];
  const live = new Set(integrationToolIds());
  for (const id of await listIds()) {
    if (id === requester || id === FLEET_ENGINEER) continue;
    const meta = await readMeta(id);
    // Only ones that would start on it now: not stopped, not on standby.
    const agent = meta?.status === 'ready' && !meta.service && !meta.builtIn && stateOf(id).state === 'active' ? await loadAgent(id) : null;
    if (!agent) continue;
    const tools = Object.keys(agent.tiers).filter(t => !/^(tasks|requests|memory|files|ops)\./.test(t) && (live.has(t) || /^web\./.test(t)));
    const mission = agent.charter.replace(/^#.*$/m, '').trim().slice(0, 500).replace(/\s+/g, ' ');
    lines.push(`- ${agent.name} (id: ${agent.id}) - tools: ${tools.join(', ') || 'none beyond the basics'}\n  Job: ${mission}`);
  }
  return lines.join('\n') || '(no other agents)';
}

type RequestFacts = { id: number; agent_id: string; what: string; why: string; evidence: string | null };

// Who should take a request: an agent (with the task to hand it), or the engineer.
export async function decideRoute(r: RequestFacts): Promise<Decision> {
  const fleet = await fleetFor(r.agent_id);
  if (fleet === '(no other agents)') return { route: 'engineer', why: 'No other agents.' };
  const meta = await readMeta(r.agent_id);
  const asker = meta?.name ?? r.agent_id;
  // The fleet works for the same people: "the inbox" is the one the fleet's email tools use.
  const forWhom = meta?.owner ? `Every agent here works for ${meta.owner}; their accounts (email, GitHub...) are the ones the agents' tools use.\n\n` : '';
  const prompt = `${forWhom}Request #${r.id} from ${asker}:\nNeeds: ${r.what}\nWhy: ${r.why}${r.evidence ? `\nTried / shows: ${r.evidence}` : ''}\n\nThe other agents:\n${fleet}`;
  const text = await ask(CONDUCTOR, {
    trigger: 'request',
    task: `Request #${r.id} from ${asker}: ${r.what.slice(0, 300)}`,
    system: SYSTEM,
    prompt,
    maxTokens: 800,
    summary: async t => {
      const d = jsonIn<Decision>(t);
      const to = d.route === 'agent' && d.agent_id ? (await readMeta(d.agent_id))?.name : null;
      return `Request #${r.id} from ${asker}: ${to ? `handed to ${to}` : 'sent to the Agency Engineer'}.${d.why ? ` ${d.why}` : ''}`;
    },
  });
  return jsonIn<Decision>(text);
}

export async function conduct(requestId: number, wake: Wake): Promise<void> {
  const r = one<RequestFacts>('SELECT id, agent_id, what, why, evidence FROM requests WHERE id = ?', requestId);
  if (!r) return;
  const toEngineer = () => wake(FLEET_ENGINEER, 'request', `Request #${r.id} from ${r.agent_id}: ${r.what.slice(0, 300)}`);
  try {
    const asker = (await readMeta(r.agent_id))?.name ?? r.agent_id;
    const d = await decideRoute(r);
    const target = d.route === 'agent' && d.agent_id ? await readMeta(d.agent_id) : null;
    if (!target || !d.task?.trim() || d.agent_id === r.agent_id || target.builtIn || target.service || stateOf(d.agent_id!).state !== 'active') return toEngineer();
    const task = d.task.trim().slice(0, 4000);
    const t = exec('INSERT INTO tasks (agent_id, from_agent, task, created_at) VALUES (?, ?, ?, ?)', d.agent_id!, r.agent_id, task, Date.now());
    wake(d.agent_id!, 'handoff', `Task #${t.lastInsertRowid} from ${asker}: ${task}`);
    const answer = `${target.name} does this as part of its job, so it's been handed to it as task #${t.lastInsertRowid}. You'll be told the result when it's done.${d.why ? ` (${d.why})` : ''}`;
    exec("UPDATE requests SET status = 'done', answer = ?, answered_at = ?, stage = NULL WHERE id = ?", answer, Date.now(), r.id);
    postToRequest(r.id, 'engineer', `Handed to ${target.name}: it already does this. ${d.why ?? ''}`.trim());
  } catch (e) {
    // Stopped: everything goes to the engineer, as if there were no Agency Conductor.
    if (!(e instanceof HelperStopped)) console.error(`Agency Conductor couldn't route request #${requestId}:`, (e as Error).message);
    toEngineer();
  }
}

setRequestRouter(conduct);
