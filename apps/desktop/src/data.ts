import type { ApprovalToolId, ToolArgs } from './approvalTools';

// Placeholder data for the UI only - not the real agency roster.

// 'agency' = the built-in agents every account gets (shown as the Fleet Engineer).
export type Department = 'engineering' | 'marketing' | 'sales' | 'finance' | 'research' | 'operations' | 'agency';

export type Slice = { label: string; value: number };

export type Agent = {
  id: string;
  name: string;
  department: Department;
  owner: string; // member name; only shown when the user is in an organization
  builtIn?: boolean; // part of the agency itself, owned by no one
  // Per month (30 days); other time ranges are scaled from this for the placeholder UI.
  // Output is successful actions by type; cost is dollars by source.
  output: Slice[];
  cost: Slice[];
  runs: number;
  lastRun: { minutesAgo: number; outcome: 'succeeded' | 'failed' | 'running' } | null; // null = never run
  // Approval outcomes per month (scaled to the time frame like the other stats).
  decisions: Decisions;
  ferocity: number; // index into FEROCITY
};

export type Decisions = { approved: number; rejected: number; expired: number };

export type Organization = { name: string; members: string[] };

// Admins can switch Approvals to everyone's; members only see their own agents'.
export type Account = { name: string; role: 'admin' | 'member'; org: Organization | null };

// Organizations this account belongs to (the first is the current one).
export const ORGANIZATIONS = ['Acme Ventures', 'Northwind Labs'];

// Preview the no-organization experience with ?noorg, and a non-admin member with ?member.
const params = new URLSearchParams(window.location.search);
const noOrg = params.has('noorg');

export const ACCOUNT: Account = {
  name: 'Max',
  role: params.has('member') ? 'member' : 'admin',
  org: noOrg ? null : { name: 'Acme Ventures', members: ['Max', 'Priya', 'Jordan'] },
};

export const AGENTS: Agent[] = [
  {
    id: 'research',
    name: 'Research Assistant',
    department: 'research',
    owner: 'Priya',
    output: [
      { label: 'Briefs written', value: 34 },
      { label: 'Sources summarised', value: 212 },
      { label: 'Questions answered', value: 58 },
    ],
    cost: [
      { label: 'Model usage', value: 41.2 },
      { label: 'Web search', value: 12.6 },
      { label: 'Document parsing', value: 3.1 },
    ],
    runs: 96,
    lastRun: { minutesAgo: 4, outcome: 'running' },
    decisions: { approved: 4, rejected: 1, expired: 0 },
    ferocity: 1,
  },
  {
    id: 'inbox',
    name: 'Inbox Triage',
    department: 'operations',
    owner: 'Max',
    output: [
      { label: 'Emails labelled', value: 1240 },
      { label: 'Replies drafted', value: 86 },
      { label: 'Tasks created', value: 41 },
    ],
    cost: [
      { label: 'Model usage', value: 18.9 },
      { label: 'Email API', value: 2.4 },
    ],
    runs: 720,
    lastRun: { minutesAgo: 11, outcome: 'succeeded' },
    decisions: { approved: 52, rejected: 9, expired: 3 },
    ferocity: 2,
  },
  {
    id: 'writer',
    name: 'Content Writer',
    department: 'marketing',
    owner: 'Jordan',
    output: [
      { label: 'Blog posts', value: 9 },
      { label: 'Social posts', value: 47 },
      { label: 'Newsletter issues', value: 4 },
    ],
    cost: [
      { label: 'Model usage', value: 63.5 },
      { label: 'Image generation', value: 22.0 },
      { label: 'SEO data', value: 15.0 },
    ],
    runs: 58,
    lastRun: { minutesAgo: 190, outcome: 'succeeded' },
    decisions: { approved: 18, rejected: 6, expired: 1 },
    ferocity: 1,
  },
  {
    id: 'leads',
    name: 'Lead Finder',
    department: 'sales',
    owner: 'Max',
    output: [
      { label: 'Connection requests', value: 310 },
      { label: 'Emails sent', value: 145 },
      { label: 'Leads qualified', value: 62 },
      { label: 'Replies sent', value: 23 },
    ],
    cost: [
      { label: 'Model usage', value: 37.8 },
      { label: 'Data enrichment', value: 48.0 },
      { label: 'Email sending', value: 6.5 },
    ],
    runs: 184,
    lastRun: { minutesAgo: 27, outcome: 'failed' },
    decisions: { approved: 70, rejected: 14, expired: 5 },
    ferocity: 3,
  },
  {
    id: 'books',
    name: 'Bookkeeper',
    department: 'finance',
    owner: 'Priya',
    output: [
      { label: 'Transactions coded', value: 530 },
      { label: 'Invoices chased', value: 14 },
      { label: 'Reports filed', value: 3 },
    ],
    cost: [
      { label: 'Model usage', value: 9.7 },
      { label: 'Accounting API', value: 0 },
    ],
    runs: 30,
    lastRun: { minutesAgo: 1440, outcome: 'succeeded' },
    decisions: { approved: 12, rejected: 2, expired: 0 },
    ferocity: 0,
  },
  {
    id: 'reviewer',
    name: 'Code Reviewer',
    department: 'engineering',
    owner: 'Jordan',
    output: [
      { label: 'PRs reviewed', value: 77 },
      { label: 'Fixes pushed', value: 19 },
      { label: 'Issues filed', value: 12 },
    ],
    cost: [
      { label: 'Model usage', value: 88.4 },
      { label: 'CI minutes', value: 11.2 },
    ],
    runs: 141,
    lastRun: { minutesAgo: 2, outcome: 'running' },
    decisions: { approved: 31, rejected: 4, expired: 2 },
    ferocity: 2,
  },
  {
    // Built-in: the Conductor (cheap rerouting) + Fleet Engineer (builds tools),
    // shown as one agent. See docs/requests.md.
    id: 'fleet',
    name: 'Fleet Engineer',
    department: 'agency',
    owner: 'Built-in',
    builtIn: true,
    output: [
      { label: 'Requests rerouted', value: 41 },
      { label: 'Tools built', value: 9 },
      { label: 'Requests answered', value: 23 },
    ],
    cost: [
      { label: 'Model usage', value: 14.6 },
      { label: 'Sandbox time', value: 2.1 },
    ],
    runs: 120,
    lastRun: { minutesAgo: 9, outcome: 'succeeded' },
    decisions: { approved: 7, rejected: 2, expired: 1 },
    ferocity: 1,
  },
];

// Agents made with the agent builder (docs/agent-creation.md). Kept in this
// browser for now and appended to AGENTS, so every view sees them.
const CREATED_KEY = 'eaa.createdAgents';

function loadCreated(): Agent[] {
  try {
    return JSON.parse(localStorage.getItem(CREATED_KEY) ?? '[]') as Agent[];
  } catch {
    return [];
  }
}
AGENTS.push(...loadCreated().filter(a => !AGENTS.some(x => x.id === a.id)));

// Deleted agents stay deleted, including the placeholder ones.
const DELETED_KEY = 'eaa.deletedAgents';
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
      'Maximise output by any means available. Think of every possible way to get more of your work done and request whatever it takes - new channels, new tools, more access. You can only ask: everything you request still needs a human or the Fleet Engineer to grant it.',
  },
];

export const rangeDays = (r: TimeRange) => TIME_RANGES.find(t => t.value === r)!.factor * 30;

// A pending approval = an agent's call to a human-approved tool that hasn't
// run yet. The card's text comes from the tool's definition (approvalTools.ts)
// filled in with these arguments.
export type Approval = {
  id: string;
  agentId: string;
  tool: ApprovalToolId;
  args: ToolArgs;
  minutesAgo: number; // when the agent made the call (placeholder data)
  createdAt?: number; // ms timestamp, for approvals raised while the app is open
  // Whose owner decides it, when that isn't the calling agent - e.g. the
  // Fleet Engineer (owned by no one) building a tool FOR Lead Finder goes
  // to Lead Finder's owner.
  forAgentId?: string;
};

// Placeholder approvals for the UI only.
export const APPROVALS: Approval[] = [
  {
    id: 'ap-1',
    agentId: 'inbox',
    tool: 'email.send',
    minutesAgo: 6,
    args: {
      to: 'dana.whitfield@northwindlogistics.com',
      subject: 'Re: Invoice INV-2291 - payment date',
      body:
        "Hi Dana,\n\nThanks for flagging this. INV-2291 was approved on our side yesterday and is scheduled for payment on the 14th with the rest of this month's run.\n\nI'll send the remittance as soon as it clears.\n\nMax",
    },
  },
  {
    id: 'ap-2',
    agentId: 'leads',
    tool: 'linkedin.connect',
    minutesAgo: 22,
    args: {
      name: 'Priyanka Rao',
      headline: 'Head of Operations, Tidewater Freight',
      note: "Hi Priyanka - saw your post on consolidating depot reporting. We help ops teams do exactly that without the spreadsheet shuffle. Would be good to connect.",
    },
  },
  {
    id: 'ap-3',
    agentId: 'writer',
    tool: 'blog.publish',
    minutesAgo: 48,
    args: {
      title: 'Five signs your asset register has quietly gone stale',
      site: 'Company blog',
      excerpt:
        "Most registers don't fail in one go. They drift: a laptop that changed hands, a forklift that moved sites, a licence that renewed under a different cost centre...",
    },
  },
  {
    id: 'ap-4',
    agentId: 'inbox',
    tool: 'email.archive',
    minutesAgo: 75,
    args: {
      count: 38,
      description: 'Newsletters and promotions older than 30 days',
      senders: 'Mostly SaaS updates, event invites and webinar reminders',
    },
  },
];

// Agents each person owns (owner names live on the agents).
// Whose an approval is: the agent it's for, else the agent that raised it.
export const approvalOwnerAgent = (a: Approval) => a.forAgentId ?? a.agentId;

export const isMine = (agentId: string) => {
  const a = AGENTS.find(x => x.id === agentId);
  return !!a && !a.builtIn && a.owner === ACCOUNT.name;
};

// Your approve/reject decisions earlier today, before this session (placeholder).
export const DECIDED_EARLIER_TODAY = { approved: 6, rejected: 2 };

// A resource request that the agency couldn't settle itself (docs/requests.md).
export type ResourceRequest = {
  id: string;
  agentId: string;
  summary: string; // one sentence: what the agent needs
  detail: string; // the agent's fuller explanation
  minutesAgo: number;
  // PLACEHOLDER: the simulated Fleet Engineer's side of the conversation,
  // until the real engineer exists. Rule: it never just says why it can't -
  // `plan` always tells you what to do so it can finish the job.
  engineer: {
    canDoNow?: boolean; // it can design the fix as soon as you say go
    plan: string; // its opening message on the request: what you need to do
    // The tool it designs once it can. Building it is a human approval.
    build: { toolName: string; does: string; access: string };
    done: string; // what it did once the build was approved
  };
};

// Placeholder requests for the UI only.
export const REQUESTS: ResourceRequest[] = [
  {
    id: 'rq-1',
    agentId: 'leads',
    summary: 'Needs access to the company LinkedIn Sales Navigator account',
    detail:
      "I'm finding decision-makers through public search, which caps at about 30 useful profiles a day and hides seniority filters. With a Sales Navigator seat I could filter by role, company size and region and roughly triple qualified leads. I don't need to post or message from it - read-only search is enough.",
    minutesAgo: 190,
    engineer: {
      plan:
        "I can build a read-only Sales Navigator search tool for Lead Finder. Here's what I need from you:\n1. Buy a Sales Navigator seat (Core is enough - read-only search).\n2. In Sales Navigator, go to Settings > Integrations and create an API key.\n3. Reply here when that's done. I'll build the tool, and you'll paste the key into Settings > Connections (not here).",
      build: { toolName: 'Sales Navigator search', does: 'Searches Sales Navigator for leads by role, company size and region', access: 'Read-only - cannot message or post' },
      done: 'Approved and built: Lead Finder has a read-only Sales Navigator search tool. It goes live once the API key is added in Settings > Connections.',
    },
  },
  {
    id: 'rq-2',
    agentId: 'research',
    summary: 'Wants a Statista subscription to cite market-size figures',
    detail:
      "Three of this week's briefs need current market-size numbers. The free sources I can reach are 2-3 years old or paywalled. A Statista (or similar) subscription would let me cite current figures with a proper source.",
    minutesAgo: 140,
    engineer: {
      plan:
        "I can wire up a market-data source once there's access. Here's what to do:\n1. Buy a Statista subscription (the Professional tier includes API access) - or tell me which data source you'd rather use.\n2. Create an API key in its account settings.\n3. Reply here when that's done and I'll build a lookup tool for Research Assistant.",
      build: { toolName: 'Market data lookup', does: 'Looks up market-size and industry figures, with source and date', access: 'Read-only' },
      done: 'Approved and built: Research Assistant has a market-data lookup that cites the source and date with every figure.',
    },
  },
  {
    id: 'rq-3',
    agentId: 'writer',
    summary: "Can't find the current brand guidelines",
    detail:
      'Two different "brand guidelines" PDFs are in the shared drive (2024 and 2025) and they disagree on the primary colour and tone of voice. I need to know which one is current before drafting the newsletter.',
    minutesAgo: 95,
    engineer: {
      plan:
        "Only a person can decide which brand guide is current, so here's how to settle it:\n1. Tell me which one is current - 2024 or 2025 - or upload the right one to Shared Drive > Brand.\n2. I'll archive the other one so nothing picks it up again, and point Content Writer at the right file.",
      build: { toolName: 'Brand guide pointer', does: 'Archives the outdated brand guide and points Content Writer at the current one', access: 'Can move files within Shared Drive > Brand' },
      done: 'Approved and done: the old guide is archived, the current one is in Shared Drive > Brand, and Content Writer uses it from now on.',
    },
  },
  {
    id: 'rq-4',
    agentId: 'inbox',
    summary: 'Needs permission to read the shared accounts@ inbox',
    detail:
      'Supplier invoices are going to accounts@ rather than your inbox, so I miss them when triaging. Read-only delegated access to that mailbox would let me file and flag invoices the same way I do for yours.',
    minutesAgo: 30,
    engineer: {
      canDoNow: true,
      plan:
        "I can build Inbox Triage a read-only reader for accounts@ (read and label only - it can't send or delete). Nothing needed from you except a yes: reply here and I'll raise it for your approval.",
      build: { toolName: 'accounts@ mailbox reader', does: 'Reads, files and flags emails in the shared accounts@ inbox', access: 'Read and label only - cannot send or delete' },
      done: 'Approved and built: Inbox Triage can now read, file and flag supplier invoices in accounts@.',
    },
  },
];
