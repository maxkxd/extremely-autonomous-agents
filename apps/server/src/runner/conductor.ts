import { listIds, readMeta } from '../files.js';
import { integrationToolIds } from '../integrations/index.js';
import { FLEET_ENGINEER, loadAgent } from './agent.js';
import { getSetting, one, run as exec, setSetting } from './db.js';
import { paceFacts, storePace } from './goals.js';
import { postToRequest } from './engineer.js';
import { CONDUCTOR } from './helpers.js';
import { stateOf } from './run.js';
import { ask, HelperStopped, jsonIn } from './quick.js';
import { MAX_TASK_TEXT, setRequestRouter, type Wake } from './tools.js';

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
    want: 'cheap',
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
    const task = d.task.trim().slice(0, MAX_TASK_TEXT);
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

// --- Keeping agents on their goals (goals.ts) ------------------------------------
//
// The pace an agent's goals call for is plain arithmetic, worked out fresh whenever it is
// needed. Every half hour the Conductor looks over all of them in one cheap call and may
// change an agent's numbers where judgement helps, or leave it a line of advice. Its
// numbers are kept within sensible bounds and hold for a while (goals.ts); if the call
// fails, or it leaves an agent out, the arithmetic stands.

const PACE_EVERY_MS = 30 * 60_000;
const PACED_AT = 'goals_paced_at';

const PACE_SYSTEM = `You keep the agents of an AI agency on their goals. A goal is a number for a trailing window: the last hour, 24 hours, 7 days, 30 days or 365 days. There is no deadline: 100 a day means 100 in any 24 hours, held at a steady rate. Each line below is one agent that is not at its goal yet: its goals (done/goal in that window), what one of its runs usually makes and how long it takes, and the pace simple arithmetic has worked out for it.
Change an agent's numbers only where judgement helps:
- more per run when its runs are short and productive; fewer runs, each asked for more, is cheaper than many small ones
- more runs at once (up to 20) only when it cannot get there one after another
- a steady rate, not one burst: work done in a burst all drops out of the window together later
- an agent whose runs make nothing needs a hint about what to check, not more runs
Leave an agent out to keep the arithmetic. Refer to people by name or as "they".
Answer with JSON only: {"agents":{"<id>":{"every_min":<minutes between its runs>,"parallel":<runs at once>,"per_run":<what one run is asked for>,"note":"<one short sentence to that agent, or empty>"}}}`;

type PaceAnswer = { agents?: Record<string, { every_min?: number; parallel?: number; per_run?: number; note?: string }> };

let pacing = false;
export async function conductPace(now: number): Promise<number> {
  if (pacing || now - getSetting<number>(PACED_AT, 0) < PACE_EVERY_MS) return 0;
  pacing = true;
  try {
    setSetting(PACED_AT, now);
    const facts = new Map<string, { sig: string; line: string }>();
    for (const id of await listIds()) {
      const meta = await readMeta(id);
      if (!meta || meta.status !== 'ready' || meta.service || meta.builtIn || stateOf(id).state !== 'active') continue;
      const agent = await loadAgent(id);
      const f = agent ? paceFacts(agent, now) : null;
      if (f) facts.set(agent!.id, f);
    }
    if (!facts.size) return 0;
    let paced = 0;
    const apply = (text: string) => {
      const answer = jsonIn<PaceAnswer>(text).agents ?? {};
      paced = 0;
      for (const [id, p] of Object.entries(answer)) {
        const f = facts.get(id);
        if (!f || !p || typeof p !== 'object') continue;
        storePace(id, f.sig, p, now);
        paced++;
      }
      return paced;
    };
    await ask(CONDUCTOR, {
      trigger: 'scheduled',
      task: `Pacing ${facts.size} agent${facts.size === 1 ? '' : 's'} to their goals`,
      system: PACE_SYSTEM,
      prompt: [...facts.values()].map(f => f.line).join('\n'),
      maxTokens: 1500,
      want: 'cheap',
      summary: t => {
        const n = apply(t);
        return `Looked over ${facts.size} agent${facts.size === 1 ? '' : 's'} with goals: ${n ? `changed the pace of ${n}` : 'the worked-out pace stands for all of them'}.`;
      },
    });
    return paced;
  } catch (e) {
    // Stopped, or no model answered: the arithmetic stands.
    if (!(e instanceof HelperStopped)) console.error("The Agency Conductor couldn't pace the agents:", (e as Error).message);
    return 0;
  } finally {
    pacing = false;
  }
}
