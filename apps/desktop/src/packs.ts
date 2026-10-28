import type { Department } from './data';

// Agent packs offered on the New agent page: a set of agents that work well
// together for one job. Placeholder catalogue - more get added over time.
export type PackAgent = { name: string; department: Department; does: string };
export type AgentPack = { id: string; name: string; tagline: string; agents: PackAgent[] };

export const AGENT_PACKS: AgentPack[] = [
  {
    id: 'sales',
    name: 'Sales',
    tagline: 'Find the right people and start the conversation.',
    agents: [
      { name: 'Lead Research', department: 'sales', does: 'Finds and qualifies prospects that fit your ideal customer.' },
      { name: 'Outreach', department: 'sales', does: 'Writes and sends personal first messages and follow-ups.' },
    ],
  },
  {
    id: 'marketing',
    name: 'Marketing',
    tagline: 'Keep every channel busy without babysitting it.',
    agents: [
      { name: 'Paid Ads', department: 'marketing', does: 'Runs and tunes ad campaigns against a budget you set.' },
      { name: 'Social Media', department: 'marketing', does: 'Plans, writes and schedules posts across your accounts.' },
      { name: 'SEO', department: 'marketing', does: 'Finds keywords, fixes pages and writes content that ranks.' },
    ],
  },
  {
    id: 'reliability',
    name: 'Reliability',
    tagline: 'Know when things break - and get them fixed.',
    agents: [
      { name: 'Bug Triage', department: 'engineering', does: 'Sorts new errors and bug reports, dedupes them and files the real ones.' },
      { name: 'Infrastructure Monitor', department: 'engineering', does: 'Watches uptime, costs and alerts, and escalates what matters.' },
    ],
  },
  {
    id: 'support',
    name: 'Customer Support',
    tagline: 'Fast, consistent answers for your customers.',
    agents: [
      { name: 'Support Desk', department: 'operations', does: 'Answers common tickets and hands the rest to a person.' },
      { name: 'Customer Success', department: 'operations', does: 'Checks in on new customers and spots who is at risk.' },
    ],
  },
  {
    id: 'finance',
    name: 'Finance',
    tagline: 'Books kept, invoices chased, numbers ready.',
    agents: [
      { name: 'Bookkeeper', department: 'finance', does: 'Codes transactions and reconciles accounts.' },
      { name: 'Accounts Receivable', department: 'finance', does: 'Sends invoices and chases the late ones politely.' },
    ],
  },
  {
    id: 'research',
    name: 'Research',
    tagline: 'Stay on top of your market without the reading.',
    agents: [
      { name: 'Market Research', department: 'research', does: 'Writes briefs on markets, trends and numbers, with sources.' },
      { name: 'Competitor Watch', department: 'research', does: 'Tracks competitors and tells you when something changes.' },
    ],
  },
  {
    id: 'content',
    name: 'Content',
    tagline: 'A steady stream of writing in your voice.',
    agents: [
      { name: 'Content Writer', department: 'marketing', does: 'Drafts blog posts, case studies and landing pages.' },
      { name: 'Newsletter', department: 'marketing', does: 'Turns your week into a newsletter people open.' },
    ],
  },
  {
    id: 'operations',
    name: 'Operations',
    tagline: 'The admin that eats your day, handled.',
    agents: [
      { name: 'Inbox Triage', department: 'operations', does: 'Labels, files and drafts replies so your inbox stays clear.' },
      { name: 'Scheduler', department: 'operations', does: 'Books meetings and keeps your calendar sane.' },
    ],
  },
  {
    id: 'engineering',
    name: 'Engineering',
    tagline: 'Extra hands on the codebase.',
    agents: [
      { name: 'Code Reviewer', department: 'engineering', does: 'Reviews pull requests for bugs and risky changes.' },
      { name: 'Docs Writer', department: 'engineering', does: 'Keeps your docs in step with the code.' },
    ],
  },
  {
    id: 'recruiting',
    name: 'Recruiting',
    tagline: 'From open role to shortlist.',
    agents: [
      { name: 'Sourcer', department: 'operations', does: 'Finds candidates that match the role.' },
      { name: 'Screener', department: 'operations', does: 'Reviews applications and books first interviews.' },
    ],
  },
];
