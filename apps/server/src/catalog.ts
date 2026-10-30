// The tool catalogue the agent builder picks from (docs/agent-creation.md).
// Each tool has a DEFAULT tier; the builder can tier it differently for one
// agent when the Charter gives a reason.
//   T0 - just runs (reads, research, scratch files)
//   T1 - runs, and posts a notice to the agent's DM channel (reversible internal writes)
//   T2 - waits in Approvals until a person decides; expires if nobody does
//        (anything visible outside the organisation, or hard to undo)
// There is no "never" tier: a tool left out of TOOLS.yaml can't be called.

export type Tier = 'T0' | 'T1' | 'T2';
export type CatalogTool = { name: string; does: string; tier: Tier };
export type CatalogServer = { server: string; what: string; tools: CatalogTool[] };

const t = (name: string, tier: Tier, does: string): CatalogTool => ({ name, tier, does });

export const CATALOG: CatalogServer[] = [
  {
    server: 'web',
    what: 'Public web, logged out',
    tools: [
      t('web_search', 'T0', 'Search the public web'),
      t('fetch_page', 'T0', 'Read one public page'),
      t('browse', 'T0', 'Click through public sites in a blank throwaway browser (no sign-ins): open, click, type, scroll'),
    ],
  },
  {
    server: 'signed_in_browser',
    what: "The agents' own browser profile, signed in to the sites the person chose - acts as the person",
    tools: [
      t('open', 'T0', 'Open a page in the signed-in agent profile and read it'),
      t('scroll', 'T0', 'Scroll the current page'),
      t('back', 'T0', 'Go back a page'),
      t('click', 'T2', 'Click a button or link as the person (only lower the tier when the Charter limits what it may click)'),
      t('type', 'T2', 'Type into a field as the person (only lower the tier when the Charter limits what it may type)'),
    ],
  },
  {
    server: 'gmail',
    what: 'Email (Gmail or Outlook)',
    tools: [
      t('list_messages', 'T0', 'Search the inbox'),
      t('read_message', 'T0', 'Read one email or thread'),
      t('create_draft', 'T1', 'Save a draft reply, unsent'),
      t('modify_labels', 'T1', 'Add or remove labels'),
      t('archive_messages', 'T1', 'Archive emails (recoverable)'),
      t('send_to_me', 'T1', 'Email the account owner only (digests, reports)'),
      t('send_email', 'T2', 'Send an email'),
    ],
  },
  {
    server: 'calendar',
    what: 'Calendar',
    tools: [
      t('list_events', 'T0', 'See events in a date range'),
      t('find_free_time', 'T0', 'Find open slots across calendars'),
      t('create_event', 'T2', 'Create an event and invite people'),
      t('update_event', 'T2', 'Move or change an event others are invited to'),
    ],
  },
  {
    server: 'slack',
    what: 'Team chat (Slack)',
    tools: [
      t('read_channel', 'T0', 'Read recent messages in a channel'),
      t('post_message', 'T1', 'Post in an internal channel'),
      t('dm_person', 'T1', 'Send a teammate a direct message'),
    ],
  },
  {
    server: 'linkedin',
    what: 'LinkedIn, signed in as a person',
    tools: [
      t('search_people', 'T0', 'Search for people by keywords and filters'),
      t('view_profile', 'T0', 'Read a profile'),
      t('send_connection_request', 'T2', 'Send a connection request with a note'),
      t('send_message', 'T2', 'Message a connection'),
      t('like_post', 'T2', 'Like a post'),
      t('comment_on_post', 'T2', 'Comment on a post'),
    ],
  },
  {
    server: 'enrich',
    what: 'Company and contact enrichment',
    tools: [
      t('lookup_company', 'T0', 'Size, industry and details for a company domain'),
      t('lookup_person', 'T0', 'Role and work email for a person at a company'),
    ],
  },
  {
    server: 'crm',
    what: 'CRM (HubSpot, Zoho, Salesforce)',
    tools: [
      t('search_records', 'T0', 'Find leads, contacts, companies or deals'),
      t('get_record', 'T0', 'Read one record with its history'),
      t('create_record', 'T1', 'Add a lead, contact, company or deal'),
      t('update_record', 'T1', 'Change fields on a record'),
      t('delete_record', 'T2', 'Delete a record'),
    ],
  },
  {
    server: 'helpdesk',
    what: 'Support tickets (Zendesk, Zoho Desk, Intercom)',
    tools: [
      t('list_tickets', 'T0', 'List tickets by status or queue'),
      t('get_ticket', 'T0', 'Read a ticket and its thread'),
      t('add_internal_note', 'T1', 'Add a note only staff can see'),
      t('set_ticket_status', 'T1', 'Change status, priority or assignee'),
      t('reply_to_customer', 'T2', 'Send a reply the customer sees'),
    ],
  },
  {
    server: 'xero',
    what: 'Accounting (Xero, QuickBooks)',
    tools: [
      t('list_bank_transactions', 'T0', 'Bank feed transactions since a date'),
      t('list_invoices', 'T0', 'Invoices by status'),
      t('update_transaction', 'T1', 'Code a transaction to an account'),
      t('create_invoice_draft', 'T1', 'Create an invoice as a draft'),
      t('send_invoice', 'T2', 'Approve and email an invoice'),
      t('create_payment', 'T2', 'Record or make a payment'),
    ],
  },
  {
    server: 'stripe',
    what: 'Payments (Stripe)',
    tools: [
      t('list_payments', 'T0', 'Charges and payouts'),
      t('list_customers', 'T0', 'Customers and their subscriptions'),
      t('create_refund', 'T2', 'Refund a charge'),
    ],
  },
  {
    server: 'github',
    what: 'Code (GitHub)',
    tools: [
      t('list_repos', 'T0', 'The repositories it can reach'),
      t('list_issues', 'T0', 'List or search issues and PRs'),
      t('get_issue', 'T0', 'Read an issue and its comments'),
      t('get_pull_request', 'T0', 'Read a PR: diff, files, reviews, checks'),
      t('read_file', 'T0', 'Read a file or folder in a repository'),
      t('create_review', 'T1', 'Review a PR with comments (never approves)'),
      t('comment_on_issue', 'T1', 'Comment on an issue or PR'),
      t('create_branch', 'T1', 'Create its own branch (agent/...)'),
      t('commit_files', 'T1', 'Commit to its own branch (agent/...) only'),
      t('create_pull_request', 'T1', 'Open a PR from its branch'),
      t('merge_pull_request', 'T2', 'Merge a PR'),
    ],
  },
  {
    server: 'docs',
    what: 'Documents and spreadsheets in its own folder (Google Drive)',
    tools: [
      t('read_document', 'T0', 'Read a doc, sheet or PDF'),
      t('create_document', 'T0', 'Create a doc in its own folder'),
      t('update_document', 'T0', 'Edit a doc it owns'),
      t('append_to_document', 'T0', 'Add to the end of a doc it owns'),
      t('update_sheet', 'T0', 'Write rows to a sheet it owns'),
      t('share_document', 'T2', 'Share a doc with someone outside the organisation'),
    ],
  },
  {
    server: 'cms',
    what: 'Website content (WordPress, Webflow, Sanity)',
    tools: [
      t('create_draft', 'T1', 'Create a draft post or page'),
      t('update_draft', 'T1', 'Edit a draft'),
      t('publish_post', 'T2', 'Publish a post or page'),
    ],
  },
  {
    server: 'social',
    what: 'Social media scheduling (Buffer)',
    tools: [
      t('list_posts', 'T0', 'Scheduled and sent posts'),
      t('get_metrics', 'T0', 'Engagement for recent posts'),
      t('schedule_post', 'T2', 'Schedule a post to a channel'),
    ],
  },
  {
    server: 'ads',
    what: 'Paid ads (Google Ads, Meta Ads)',
    tools: [
      t('get_campaign_metrics', 'T0', 'Spend, clicks and conversions'),
      t('create_ad_draft', 'T1', 'Draft an ad, not live'),
      t('update_budget', 'T2', 'Change a campaign budget'),
      t('set_campaign_status', 'T2', 'Pause or launch a campaign'),
    ],
  },
  {
    server: 'analytics',
    what: 'Product and web analytics (PostHog, GA)',
    tools: [t('query', 'T0', 'Run a read-only analytics query')],
  },
];

// Fleet plumbing every agent gets, whatever its job. The builder never picks
// these; they're added to every TOOLS.yaml.
export const BASELINE: { server: string; tool: CatalogTool }[] = [
  ['tasks', t('list_my_tasks', 'T0', 'What it owes - step 1 of every run')],
  ['tasks', t('complete_task', 'T1', 'Close a task with its result')],
  ['tasks', t('delegate_task', 'T1', 'Hand work to another agent')],
  ['requests', t('request_resource', 'T1', 'Ask a person for something only a person can give (a key, an account, spend)')],
  ['requests', t('list_my_requests', 'T0', 'Its open requests')],
  ['memory', t('remember', 'T0', 'Save a note to its own memory for future runs')],
  ['files', t('write_file', 'T0', 'Write a file in its own workspace (work it builds up)')],
  ['files', t('read_file', 'T0', 'Read a file from its own workspace')],
  ['files', t('list_files', 'T0', 'List its workspace')],
  ['ops', t('book_next_run', 'T0', 'Book its own next run')],
].map(([server, tool]) => ({ server: server as string, tool: tool as CatalogTool }));

export const toolId = (server: string, name: string) => `${server}.${name}`;

// How a person sees a tool: by what it does, never its id ("web.web_search" ->
// "Web search"), and its level by name, never T0-T2.
export const LEVEL_WORD: Record<Tier, string> = { T0: 'silent', T1: 'logged', T2: 'approval' };
export function toolTitle(id: string) {
  const w = (id.split('.').slice(1).join(' ') || id).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
}
export const toolsForPeople = (tools: { id: string; tier: string }[]) =>
  tools.map(t => `${toolTitle(t.id)} (${LEVEL_WORD[t.tier as Tier] ?? t.tier})`).join(', ');

// Each area by what a person connects for it, for "Connect ..." requests.
export const CONNECT_LABEL: Record<string, string> = {
  web: 'a web search provider',
  signed_in_browser: "the agents' signed-in browser",
  gmail: 'email (Gmail or Outlook)',
  calendar: 'a calendar',
  slack: 'Slack',
  linkedin: 'LinkedIn',
  enrich: 'a contact enrichment service',
  crm: 'a CRM (HubSpot, Zoho, Salesforce)',
  helpdesk: 'a help desk (Zendesk, Zoho Desk, Intercom)',
  xero: 'accounting (Xero, QuickBooks)',
  stripe: 'Stripe',
  github: 'GitHub',
  docs: 'Google Drive',
  cms: 'the website CMS (WordPress, Webflow, Sanity)',
  social: 'social scheduling (Buffer)',
  ads: 'an ads account (Google Ads, Meta Ads)',
  analytics: 'analytics (PostHog, GA)',
};

export const CATALOG_INDEX = new Map(
  CATALOG.flatMap(s => s.tools.map(tool => [toolId(s.server, tool.name), { ...tool, server: s.server }] as const)),
);

// The catalogue as the builder reads it in its prompt.
export function catalogForPrompt(): string {
  return CATALOG.map(
    s => `## ${s.server} - ${s.what}\n` + s.tools.map(tool => `- ${toolId(s.server, tool.name)} [${tool.tier}] ${tool.does}`).join('\n'),
  ).join('\n\n');
}
