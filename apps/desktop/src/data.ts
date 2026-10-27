// Placeholder data for the UI only - not the real agency roster.

export type Department = 'engineering' | 'marketing' | 'sales' | 'finance' | 'research' | 'operations';

export type Slice = { label: string; value: number };

export type Agent = {
  id: string;
  name: string;
  department: Department;
  owner: string; // member name; only shown when the user is in an organization
  // Per month (30 days); other time ranges are scaled from this for the placeholder UI.
  // Output is successful actions by type; cost is dollars by source.
  output: Slice[];
  cost: Slice[];
  runs: number;
  lastRun: { minutesAgo: number; outcome: 'succeeded' | 'failed' | 'running' };
  openApprovals: number;
  openRequests: number;
};

export type Organization = { name: string; members: string[] };

export type Account = { name: string; org: Organization | null };

// Preview the no-organization experience with ?noorg in the URL.
const noOrg = new URLSearchParams(window.location.search).has('noorg');

export const ACCOUNT: Account = {
  name: 'Max',
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
    openApprovals: 0,
    openRequests: 1,
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
    openApprovals: 2,
    openRequests: 0,
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
    openApprovals: 1,
    openRequests: 2,
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
    openApprovals: 0,
    openRequests: 0,
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
    openApprovals: 0,
    openRequests: 0,
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
    openApprovals: 0,
    openRequests: 1,
  },
];

export const totalOpenApprovals = AGENTS.reduce((n, a) => n + a.openApprovals, 0);
export const totalOpenRequests = AGENTS.reduce((n, a) => n + a.openRequests, 0);

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
