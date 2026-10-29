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
  // optional: left off the card when the call didn't give its arguments
  headers: { label: string; value: string; optional?: boolean }[];
  body: string | null; // null = this tool's card never has a body
  expiresAfterHours: number;
};

export type ToolArgs = Record<string, string | number>;

// Placeholder tools for the example approvals; real ones get added as the
// agents' human-approved tools are built.
export const APPROVAL_TOOLS = {
  // Real tools (Gmail).
  'gmail.send_email': {
    wantsTo: 'send an email',
    headers: [
      { label: 'To', value: '{to}' },
      { label: 'Cc', value: '{cc}', optional: true },
      { label: 'Bcc', value: '{bcc}', optional: true },
      { label: 'Subject', value: '{subject}' },
    ],
    body: '{body}',
    expiresAfterHours: 24,
  },
  // The Agency Engineer: a draft integration going live, and tools for an agent.
  'engineer.publish_integration': {
    wantsTo: 'make {name} live for {for_agent_name}',
    headers: [{ label: 'Wakes it on', value: '{events_list}', optional: true }],
    body: '{review}',
    expiresAfterHours: 168,
  },
  'engineer.give_events': {
    wantsTo: 'wake {for_agent_name} on events',
    headers: [{ label: 'Events', value: '{events_list}' }],
    body: '{why}',
    expiresAfterHours: 168,
  },
  'engineer.give_tools': {
    wantsTo: 'give {for_agent_name} tools',
    headers: [{ label: 'Tools', value: '{tools_list}' }],
    body: '{why}',
    expiresAfterHours: 168,
  },
  'github.merge_pull_request': {
    wantsTo: 'merge pull request #{number} in {repo}',
    headers: [
      { label: 'Pull request', value: '{title}' },
      { label: 'How', value: '{method}', optional: true },
    ],
    body: null,
    expiresAfterHours: 24,
  },
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
  // The Agency Engineer asking to build a tool it designed for a request.
  'tool.build': {
    wantsTo: 'build a new tool for {forAgent}: {toolName}',
    headers: [
      { label: 'What it does', value: '{does}' },
      { label: 'Access', value: '{access}' },
    ],
    body: null,
    expiresAfterHours: 24,
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
// A tool without its own card (an MCP server's, one the Agency Engineer added):
// every argument as a line, the longest text as the body.
function generic(toolId: string, args: ToolArgs): ApprovalTool {
  const long = Object.entries(args).filter(([, v]) => typeof v === 'string' && v.length > 120).sort((a, b) => String(b[1]).length - String(a[1]).length)[0]?.[0];
  return {
    wantsTo: `use ${toolId}`,
    headers: Object.keys(args)
      .filter(k => k !== long)
      .map(k => ({ label: k.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), value: `{${k}}` })),
    body: long ? `{${long}}` : null,
    expiresAfterHours: 24,
  };
}

const given = (template: string, args: ToolArgs) => [...template.matchAll(/\{(\w+)\}/g)].every(m => args[m[1]] !== undefined && args[m[1]] !== '');

export function renderApproval(toolId: string, args: ToolArgs) {
  const tool: ApprovalTool = (APPROVAL_TOOLS as Record<string, ApprovalTool>)[toolId] ?? generic(toolId, args);
  return {
    action: `wants to ${fill(tool.wantsTo, args, toolId)}`,
    fields: tool.headers.filter(h => !h.optional || given(h.value, args)).map(h => ({ label: h.label, value: fill(h.value, args, toolId) })),
    body: tool.body === null ? null : fill(tool.body, args, toolId),
    expiresAfterHours: tool.expiresAfterHours,
  };
}
