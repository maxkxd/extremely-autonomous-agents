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
  lastRun: { minutesAgo: number; outcome: 'succeeded' | 'failed' | 'running' };
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
};

export const FEROCITY: FerocityLevel[] = [
  { name: 'Chill', cadence: 'Once a day', cron: '0 9 * * *', selfBook: 'never', runsPerDay: 1 },
  { name: 'Steady', cadence: 'Every 4 hours', cron: '0 */4 * * *', selfBook: 'never', runsPerDay: 6 },
  { name: 'Driven', cadence: 'Hourly, chains when work is left', cron: '0 * * * *', selfBook: 'when-work-left', runsPerDay: 30 },
  { name: 'Relentless', cadence: 'Every 15 min, always chains', cron: '*/15 * * * *', selfBook: 'always', runsPerDay: 120 },
  { name: 'Apocalyptic', cadence: 'Non-stop, back-to-back runs', cron: '*/5 * * * *', selfBook: 'always', runsPerDay: 288 },
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
  minutesAgo: number; // when the agent made the call
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
export const isMine = (agentId: string) => {
  const a = AGENTS.find(x => x.id === agentId);
  return !!a && !a.builtIn && a.owner === ACCOUNT.name;
};

// Your approve/reject decisions earlier today, before this session (placeholder).
export const DECIDED_EARLIER_TODAY = { approved: 6, rejected: 2 };

// One step in how a request got here (Conductor / Fleet Engineer attempts).
export type RequestStep = { by: 'Conductor' | 'Fleet Engineer'; text: string };

// A resource request that the agency couldn't settle itself (docs/requests.md).
export type ResourceRequest = {
  id: string;
  agentId: string;
  summary: string; // one sentence: what the agent needs
  detail: string; // the agent's fuller explanation
  trail: RequestStep[]; // what was tried before it reached a person
  minutesAgo: number;
  // PLACEHOLDER: what the Fleet Engineer says if you task it with this
  // request, until the real engineer exists. ok = it managed it.
  engineerReply: { ok: boolean; text: string };
};

// Placeholder requests for the UI only.
export const REQUESTS: ResourceRequest[] = [
  {
    id: 'rq-1',
    agentId: 'leads',
    summary: 'Needs access to the company LinkedIn Sales Navigator account',
    detail:
      "I'm finding decision-makers through public search, which caps at about 30 useful profiles a day and hides seniority filters. With a Sales Navigator seat I could filter by role, company size and region and roughly triple qualified leads. I don't need to post or message from it - read-only search is enough.",
    trail: [
      { by: 'Conductor', text: 'No other agent has Sales Navigator access.' },
      { by: 'Fleet Engineer', text: "Can't build this as a tool - it needs a paid seat and someone to sign in." },
    ],
    minutesAgo: 190,
    engineerReply: {
      ok: false,
      text: "Still blocked: LinkedIn doesn't allow automated sign-in to Sales Navigator. Someone needs to buy a seat and connect it once from the browser.",
    },
  },
  {
    id: 'rq-2',
    agentId: 'research',
    summary: 'Wants a Statista subscription to cite market-size figures',
    detail:
      "Three of this week's briefs need current market-size numbers. The free sources I can reach are 2-3 years old or paywalled. A Statista (or similar) subscription would let me cite current figures with a proper source.",
    trail: [
      { by: 'Conductor', text: 'No agent has a paid data source.' },
      { by: 'Fleet Engineer', text: 'Not a tool problem - needs a paid subscription.' },
    ],
    minutesAgo: 140,
    engineerReply: { ok: false, text: 'Still needs someone to buy the subscription - there is no free API that covers this.' },
  },
  {
    id: 'rq-3',
    agentId: 'writer',
    summary: "Can't find the current brand guidelines",
    detail:
      'Two different "brand guidelines" PDFs are in the shared drive (2024 and 2025) and they disagree on the primary colour and tone of voice. I need to know which one is current before drafting the newsletter.',
    trail: [
      { by: 'Conductor', text: 'Rerouted to Research Assistant - it found both files but not which is current.' },
      { by: 'Conductor', text: 'Rerouted 3 times without an answer - stopped to save runs.' },
    ],
    minutesAgo: 95,
    engineerReply: { ok: false, text: "Not something I can build - this is a judgement call about which document is current." },
  },
  {
    id: 'rq-4',
    agentId: 'inbox',
    summary: 'Needs permission to read the shared accounts@ inbox',
    detail:
      'Supplier invoices are going to accounts@ rather than your inbox, so I miss them when triaging. Read-only delegated access to that mailbox would let me file and flag invoices the same way I do for yours.',
    trail: [
      { by: 'Conductor', text: 'No agent can read accounts@.' },
      { by: 'Fleet Engineer', text: 'Proposed a read-only mailbox tool - the approval expired.' },
    ],
    minutesAgo: 30,
    engineerReply: { ok: true, text: 'Built a read-only accounts@ mailbox tool and gave it to Inbox Triage.' },
  },
];
