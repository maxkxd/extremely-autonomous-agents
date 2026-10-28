// Agent DM channels (docs/agent-dms.md): one post per run, plus direct
// messages. Placeholder history for the UI only.

// One tool call in a run post. Field NAMES only, never values.
// status: ok / failed, or for a human-approved tool, decided by its approval:
// pending until it's approved (ok) or rejected / expired (failed).
export type ToolLine = { server: string; tool: string; fields: string[]; status: 'ok' | 'failed'; approvalId?: string };

export type RunPost = {
  kind: 'run';
  id: string; // short run id
  minutesAgo: number;
  trigger: 'scheduled' | 'self-booked' | 'your message' | 'handoff';
  outcome: 'succeeded' | 'failed';
  cost: number; // dollars
  seconds: number;
  text: string; // the run's final result text
  tools: ToolLine[];
};

export type YourMessage = { kind: 'you'; minutesAgo: number; text: string };

export type DmEntry = RunPost | YourMessage;

const run = (
  id: string,
  minutesAgo: number,
  trigger: RunPost['trigger'],
  seconds: number,
  cost: number,
  text: string,
  // [server, tool, fields, status?] - status 'failed', or an approval id (pending until decided)
  tools: [string, string, string[], string?][] = [],
  outcome: RunPost['outcome'] = 'succeeded',
): RunPost => ({
  kind: 'run',
  id,
  minutesAgo,
  trigger,
  outcome,
  cost,
  seconds,
  text,
  tools: tools.map(([server, tool, fields, st]) => ({
    server,
    tool,
    fields,
    status: st === 'failed' ? 'failed' : 'ok',
    approvalId: st && st !== 'failed' ? st : undefined,
  })),
});

export const DM_HISTORY: Record<string, DmEntry[]> = {
  inbox: [
    run('3a9f', 1510, 'scheduled', 71, 0.09, 'Triaged 44 new emails: 31 labelled, 9 archived, 4 flagged for you (two supplier invoices, a contract renewal, a calendar clash on Thursday).', [
      ['gmail', 'list_messages', ['query', 'max_results']],
      ['gmail', 'modify_labels', ['message_ids', 'add_labels']],
    ]),
    run('41c2', 250, 'scheduled', 64, 0.08, 'Triaged 28 new emails. Drafted replies to Dana (invoice timing) and the venue (Thursday clash) - both are waiting in Approvals.', [
      ['gmail', 'list_messages', ['query', 'max_results']],
      ['gmail', 'create_draft', ['to', 'subject', 'body']],
      ['gmail', 'send_email', ['to', 'subject', 'body'], 'ap-1'],
    ]),
    { kind: 'you', minutesAgo: 42, text: 'Why did the Northwind invoice get flagged instead of filed?' },
    run('4b77', 41, 'your message', 22, 0.03, "It came from a new sender address (ap@northwind-logistics.co rather than the usual northwindlogistics.com), so I flagged it instead of filing it in case it's a spoof. The domain checks out - it's their new billing system. I'll file their invoices automatically from now on."),
    run('4c10', 11, 'scheduled', 58, 0.07, 'Triaged 19 new emails: 15 labelled. Asked to archive 38 old newsletters - waiting on approval.', [
      ['gmail', 'list_messages', ['query', 'max_results']],
      ['gmail', 'modify_labels', ['message_ids', 'add_labels']],
      ['gmail', 'archive_messages', ['query', 'count'], 'ap-4'],
    ]),
  ],
  leads: [
    run('7e01', 2900, 'scheduled', 188, 0.42, 'Found 23 new prospects matching the ICP (ops leads at logistics firms, 200-2,000 staff). Enriched 19; 4 had no reachable profile.', [
      ['linkedin', 'search_people', ['keywords', 'filters']],
      ['enrich', 'lookup_company', ['domain']],
    ]),
    run('7f3a', 980, 'self-booked', 142, 0.36, 'Sent 12 connection requests (8 accepted so far from yesterday). Search is capped at ~30 useful profiles a day - filed a request for Sales Navigator.', [
      ['linkedin', 'send_connection_request', ['profile_id', 'note']],
      ['agency-requests', 'request_resource', ['what', 'why']],
    ]),
    run('8012', 27, 'scheduled', 95, 0.21, "Enrichment API timed out three times in a row, so I stopped this run rather than half-finish the batch. I'll retry on the next run.", [
      ['linkedin', 'search_people', ['keywords', 'filters']],
      ['enrich', 'lookup_company', ['domain'], 'failed'],
    ], 'failed'),
    run('8031', 23, 'self-booked', 61, 0.12, 'Retried enrichment (fine this time). Asked to connect with Priyanka Rao at Tidewater Freight - waiting on approval.', [
      ['enrich', 'lookup_company', ['domain']],
      ['linkedin', 'send_connection_request', ['profile_id', 'note'], 'ap-2'],
    ]),
  ],
  research: [
    run('2d11', 400, 'scheduled', 260, 0.61, 'Wrote the weekly market brief (6 sources). Two figures are older than 2024 - flagged in the brief and filed a request for a current data source.', [
      ['search', 'web_search', ['query']],
      ['docs', 'create_document', ['title', 'body']],
      ['agency-requests', 'request_resource', ['what', 'why']],
    ]),
    run('2e40', 4, 'scheduled', 210, 0.48, 'Summarised 14 new sources for the competitor tracker. Nothing material changed this week.', [
      ['search', 'web_search', ['query']],
      ['docs', 'append_to_document', ['document_id', 'body']],
    ]),
  ],
  writer: [
    run('5a02', 600, 'scheduled', 340, 0.88, "Drafted the October newsletter. Waiting on which brand guide is current before final formatting - filed a request.", [
      ['docs', 'create_document', ['title', 'body']],
      ['agency-requests', 'request_resource', ['what', 'why']],
    ]),
    run('5b90', 190, 'self-booked', 300, 0.79, 'Wrote the "five signs your asset register has gone stale" post. Publishing needs approval - it\'s in Approvals.', [
      ['cms', 'create_draft', ['title', 'body', 'tags']],
      ['cms', 'publish_post', ['post_id', 'site'], 'ap-3'],
    ]),
  ],
  books: [
    run('9001', 1440, 'scheduled', 120, 0.12, 'Coded 41 transactions and reconciled the operating account to the bank feed. One unmatched $412.50 card charge - left uncoded and noted on the transaction.', [
      ['xero', 'list_bank_transactions', ['account_id', 'since']],
      ['xero', 'update_transaction', ['transaction_id', 'account_code']],
    ]),
  ],
  reviewer: [
    run('c311', 300, 'handoff', 95, 0.33, 'Reviewed PR #212 (billing retry). Left 3 comments: one real bug (retry count resets on restart), two nits.', [
      ['github', 'get_pull_request', ['repo', 'number']],
      ['github', 'create_review', ['repo', 'number', 'comments']],
    ]),
    run('c3a8', 2, 'scheduled', 80, 0.22, 'Reviewed PR #215 (README typo). Approved - no code changes.', [
      ['github', 'get_pull_request', ['repo', 'number']],
      ['github', 'create_review', ['repo', 'number', 'event']],
    ]),
  ],
  fleet: [
    run('f001', 900, 'handoff', 45, 0.05, "Rerouted Content Writer's brand-guide request to Research Assistant (it can search the shared drive)."),
    run('f002', 120, 'handoff', 160, 0.19, "Can't build Sales Navigator search without a paid seat - sent Lead Finder's request to its owner with the steps.", [
      ['agency-requests', 'update_request', ['request_id', 'message']],
    ]),
  ],
};
