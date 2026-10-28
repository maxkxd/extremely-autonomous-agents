// Approval tools: how a human-approved tool call shows up on the Approvals page.
//
// When an agent calls a tool that's marked "needs human approval", the call
// doesn't run - it becomes an approval card. Each such tool declares, once,
// what its card looks like. Only the {placeholders} change per call; they're
// filled from the arguments the agent called the tool with.
//
//   wantsTo  - the sentence after "<Agent> wants to". Hardcoded per tool.
//              "archive {count} emails" + { count: 38 }
//              -> "Inbox Triage wants to archive 38 emails"
//   headers  - the labelled lines (To, Subject, ...). Labels are hardcoded per
//              tool; each value is a template filled from the call.
//   body     - whether the tool has one big body block at all (hardcoded), and
//              if so, the template for it (usually just one argument).
//   expiresAfterHours - how long a human has to answer. Hardcoded per tool;
//              if it runs out, the action does not happen.
//
// Templates use {argName}. Every placeholder must be an argument the tool is
// actually called with; a missing one renders as "?" and logs a warning.

export type ApprovalTool = {
  wantsTo: string;
  headers: { label: string; value: string }[];
  body: string | null; // null = this tool's card never has a body
  expiresAfterHours: number;
};

export type ToolArgs = Record<string, string | number>;

// Placeholder tools for the example approvals; real ones get added as the
// agents' human-approved tools are built.
export const APPROVAL_TOOLS = {
  'email.send': {
    wantsTo: 'send an email',
    headers: [
      { label: 'To', value: '{to}' },
      { label: 'Subject', value: '{subject}' },
    ],
    body: '{body}',
    expiresAfterHours: 4,
  },
  'email.archive': {
    wantsTo: 'archive {count} emails',
    headers: [
      { label: 'What', value: '{description}' },
      { label: 'From', value: '{senders}' },
    ],
    body: null,
    expiresAfterHours: 12,
  },
  'linkedin.connect': {
    wantsTo: 'send a LinkedIn connection request',
    headers: [{ label: 'To', value: '{name} - {headline}' }],
    body: '{note}',
    expiresAfterHours: 4,
  },
  'blog.publish': {
    wantsTo: 'publish a blog post',
    headers: [
      { label: 'Title', value: '{title}' },
      { label: 'Where', value: '{site}' },
    ],
    body: '{excerpt}',
    expiresAfterHours: 20,
  },
} satisfies Record<string, ApprovalTool>;

export type ApprovalToolId = keyof typeof APPROVAL_TOOLS;

function fill(template: string, args: ToolArgs, tool: string): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => {
    if (args[name] === undefined) {
      console.warn(`Approval tool "${tool}": no "${name}" argument for "${template}"`);
      return '?';
    }
    return String(args[name]);
  });
}

// What an approval card shows, built from the tool's definition + the call's args.
export function renderApproval(toolId: ApprovalToolId, args: ToolArgs) {
  const tool: ApprovalTool = APPROVAL_TOOLS[toolId];
  return {
    action: `wants to ${fill(tool.wantsTo, args, toolId)}`,
    fields: tool.headers.map(h => ({ label: h.label, value: fill(h.value, args, toolId) })),
    body: tool.body === null ? null : fill(tool.body, args, toolId),
    expiresAfterHours: tool.expiresAfterHours,
  };
}
