import type { ApprovalToolId, ToolArgs } from './approvalTools';
import { currentOrg, scoped, state } from './account';

// Placeholder data for the UI only - not the real agency roster.

// 'agency' = the built-in agents every account gets (shown as the Agency Engineer).
export type Department = 'engineering' | 'marketing' | 'sales' | 'finance' | 'research' | 'operations' | 'agency';

export type Slice = { label: string; value: number };

export type Agent = {
  id: string;
  name: string;
  department: Department;
  owner: string; // member name; only shown when the user is in an organization
  builtIn?: boolean; // part of the agency itself, owned by no one
  service?: boolean; // a built-in helper (Agency Conductor, Agency Reviewer): runs only when called, so no schedule
  // Per month (30 days); other time ranges are scaled from this for the placeholder UI.
  // Output is successful actions by type; cost is dollars by source.
  output: Slice[];
  cost: Slice[];
  runs: number;
  lastRun: { minutesAgo: number; outcome: 'succeeded' | 'failed' | 'running' | 'stopped' } | null; // null = never run
  // Approval outcomes per month (scaled to the time frame like the other stats).
  decisions: Decisions;
  ferocity: number; // index into FEROCITY
  // A real agent run by the runner: its numbers are live, for the selected
  // time frame already (not placeholder monthly figures to scale).
  live?: boolean;
  runsPerDay?: number[]; // expected runs a day at each ferocity level
  perRun?: number | null; // output actions per run, recently
  // A pack agent still being customized for the organisation: it isn't run,
  // and DMs to it wait, until this clears.
  settingUp?: boolean;
};

export type Decisions = { approved: number; rejected: number; expired: number };

export type Organization = { name: string; members: string[] };

// Admins can switch Approvals to everyone's; members only see their own agents'.
export type Account = { name: string; role: 'admin' | 'member'; org: Organization | null };

// Who you are in the agency the app is in (account.ts, read before this loads).
// Your own agency: this computer's person. An organisation: you as its members
// know you, and its members.
const ORG = currentOrg();
const myName = ORG && ORG.role !== 'owner' ? (state.me?.user.name ?? 'You') : (state.localName ?? state.me?.user.name ?? 'You');
export const ACCOUNT: Account = {
  name: myName,
  role: !ORG || ORG.role !== 'member' ? 'admin' : 'member',
  org: ORG ? { name: ORG.name, members: state.members.length ? state.members.map(m => (m.userId === state.me?.user.id ? myName : m.name)) : [myName] } : null,
};

// The fleet: what the server has (App.tsx keeps this in step with it). The
// Agency Engineer is built in, so it's here from the start; its numbers come
// from the runner like every other agent's.
export const AGENTS: Agent[] = [
  {
    id: 'fleet',
    name: 'Agency Engineer',
    department: 'agency',
    owner: 'Built-in',
    builtIn: true,
    output: [],
    cost: [],
    runs: 0,
    lastRun: null,
    decisions: { approved: 0, rejected: 0, expired: 0 },
    ferocity: 0,
  },
];

// Agents made with the agent builder (docs/agent-creation.md). Kept in this
// browser for now and appended to AGENTS, so every view sees them.
const CREATED_KEY = scoped('eaa.createdAgents');

function loadCreated(): Agent[] {
  try {
    return JSON.parse(localStorage.getItem(CREATED_KEY) ?? '[]') as Agent[];
  } catch {
    return [];
  }
}
AGENTS.push(...loadCreated().filter(a => !AGENTS.some(x => x.id === a.id)));

// Deleted agents stay deleted, including the placeholder ones.
const DELETED_KEY = scoped('eaa.deletedAgents');
const loadDeleted = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(DELETED_KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
};
for (const id of loadDeleted()) {
  const i = AGENTS.findIndex(a => a.id === id);
  if (i >= 0) AGENTS.splice(i, 1);
}

// Update a created agent (e.g. when its set-up finishes), here and in storage.
export function updateAgent(id: string, patch: Partial<Agent>) {
  const a = AGENTS.find(x => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  try {
    localStorage.setItem(CREATED_KEY, JSON.stringify(loadCreated().map(x => (x.id === id ? { ...x, ...patch } : x))));
  } catch {
    // Storage unavailable - it re-syncs from the server next time.
  }
}

export function removeAgent(id: string) {
  const i = AGENTS.findIndex(a => a.id === id);
  if (i >= 0) AGENTS.splice(i, 1);
  try {
    localStorage.setItem(CREATED_KEY, JSON.stringify(loadCreated().filter(a => a.id !== id)));
    localStorage.setItem(DELETED_KEY, JSON.stringify([...new Set([...loadDeleted(), id])]));
  } catch {
    // Storage unavailable - it comes back on reload.
  }
}

// One this browser had that the server doesn't (made before, or removed
// elsewhere): dropped here, without marking it deleted.
export function forgetAgent(id: string) {
  const i = AGENTS.findIndex(a => a.id === id);
  if (i >= 0) AGENTS.splice(i, 1);
  try {
    localStorage.setItem(CREATED_KEY, JSON.stringify(loadCreated().filter(a => a.id !== id)));
  } catch {
    // Storage unavailable - nothing kept to forget.
  }
}

export function addAgent(agent: Agent) {
  AGENTS.push(agent);
  try {
    localStorage.setItem(CREATED_KEY, JSON.stringify([...loadCreated(), agent]));
  } catch {
    // Storage unavailable - the agent lasts until the page reloads.
  }
}


export type TimeRange = 'today' | 'week' | 'month' | 'year' | 'all';

export const TIME_RANGES: { value: TimeRange; label: string; factor: number }[] = [
  { value: 'today', label: 'Today', factor: 1 / 30 },
  { value: 'week', label: 'This week', factor: 7 / 30 },
  { value: 'month', label: 'This month', factor: 1 },
  { value: 'year', label: 'This year', factor: 10 },
  { value: 'all', label: 'All time', factor: 16 },
];

export const rangeLabel = (r: TimeRange) => TIME_RANGES.find(t => t.value === r)!.label;

// Placeholder scaling until real per-range numbers come from the backend.
export function scaleTo(range: TimeRange, n: number, whole = true): number {
  const v = n * TIME_RANGES.find(t => t.value === range)!.factor;
  return whole ? Math.round(v) : v;
}

// How hard an agent works. Each level is a schedule (how often the runner wakes
// it) plus a self-booking rule (whether it chains its own next run when work is
// left). max_runs_per_day stays a runaway backstop set well above the level's
// cadence - it is never the thing that sets the pace.
//
// PLACEHOLDERS: the level NAMES are final; every cadence, cron, selfBook and
// runsPerDay value below is a placeholder to make the UI and its estimate work.
// The real mapping gets decided when this app has its own runner.
export type FerocityLevel = {
  name: string;
  cadence: string; // human summary of cron + self-booking (placeholder)
  cron: string;
  selfBook: 'never' | 'when-work-left' | 'always';
  runsPerDay: number; // expected, for the estimate
  // How readily the agent files resource requests at this level - the text
  // that goes into its run instructions (docs/requests.md, "Ferocity and
  // requests"). Higher levels ask for more to get more done, but asking is
  // all it can do: anything new still goes through a request or approval.
  requestStance: string;
};

export const FEROCITY: FerocityLevel[] = [
  {
    name: 'Chill',
    cadence: 'Once a day',
    cron: '0 9 * * *',
    selfBook: 'never',
    runsPerDay: 1,
    requestStance:
      'Make do with the tools you have. Only file a request when you are genuinely blocked and cannot do the work at all any other way.',
  },
  {
    name: 'Steady',
    cadence: 'Every 4 hours',
    cron: '0 */4 * * *',
    selfBook: 'never',
    runsPerDay: 6,
    requestStance:
      'File a request when a tool or resource would make you clearly more effective at your core job, not just when you are blocked.',
  },
  {
    name: 'Driven',
    cadence: 'Hourly, chains when work is left',
    cron: '0 * * * *',
    selfBook: 'when-work-left',
    runsPerDay: 30,
    requestStance:
      'Actively look for tools, access and data that would increase your output, and request the ones with a clear payoff.',
  },
  {
    name: 'Relentless',
    cadence: 'Every 15 min, always chains',
    cron: '*/15 * * * *',
    selfBook: 'always',
    runsPerDay: 120,
    requestStance:
      'Treat every limit on your output as something to remove. Request any tool, channel or access that would let you do more or go faster.',
  },
  {
    name: 'Apocalyptic',
    cadence: 'Non-stop, back-to-back runs',
    cron: '*/5 * * * *',
    selfBook: 'always',
    runsPerDay: 288,
    requestStance:
      'Maximise output by any means available. Think of every possible way to get more of your work done and request whatever it takes - new channels, new tools, more access. You can only ask: everything you request still needs a human or the Agency Engineer to grant it.',
  },
];

export const rangeDays = (r: TimeRange) => TIME_RANGES.find(t => t.value === r)!.factor * 30;

// A pending approval = an agent's call to a human-approved tool that hasn't
// run yet. The card's text comes from the tool's definition (approvalTools.ts)
// filled in with these arguments.
export type Approval = {
  id: string;
  agentId: string;
  tool: ApprovalToolId | string; // live ones can be any T2 tool
  args: ToolArgs;
  expiresAt?: number; // live ones: the server's deadline
  live?: boolean; // a real agent's queued call, decided on the server
  paused?: boolean; // its agent is stopped: shown greyed, can't be decided until it's resumed
  owner?: string | null; // a real one: whose decision it is, from the server (null: anyone's)
  minutesAgo: number; // when the agent made the call
  createdAt?: number; // ms timestamp, for approvals raised while the app is open
  // Whose owner decides it, when that isn't the calling agent - e.g. the
  // Agency Engineer (owned by no one) building a tool FOR Lead Finder goes
  // to Lead Finder's owner.
  forAgentId?: string;
};


// Agents each person owns (owner names live on the agents).
// Whose an approval is: the agent it's for, else the agent that raised it.
export const approvalOwnerAgent = (a: Approval) => a.forAgentId ?? a.agentId;

export const isMine = (agentId: string) => {
  const a = AGENTS.find(x => x.id === agentId);
  return !!a && !a.builtIn && a.owner === ACCOUNT.name;
};


// A resource request that the agency couldn't settle itself (docs/requests.md).
export type ResourceRequest = {
  id: string;
  agentId: string;
  live?: number; // a real agent's request: its id on the server
  // A real one's conversation with the (real) Agency Engineer, and where it stands:
  // engineer (it has it), waiting_you, approval (its go-live waits), person (yours).
  liveThread?: { from: 'you' | 'engineer'; text: string }[];
  stage?: 'engineer' | 'waiting_you' | 'approval' | 'person' | null;
  busy?: boolean; // the engineer is running right now
  approvalId?: string | null; // the approval it waits on, to go straight to
  closedAs?: 'done' | 'rejected'; // closed elsewhere (the Agency Engineer, another device): plays its exit, then goes
  summary: string; // one sentence: what the agent needs
  detail: string; // the agent's fuller explanation
  minutesAgo: number;

};
