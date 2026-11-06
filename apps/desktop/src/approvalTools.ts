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
    wantsTo: 'give {for_agent_name} {name}',
    headers: [
      { label: 'Tools', value: '{tools_list}', optional: true },
      { label: 'Wakes it on', value: '{events_list}', optional: true },
    ],
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
  // The Agency Doctor: a rule for an agent that keeps going wrong the same way.
  'doctor.propose_rule': {
    wantsTo: "add a rule to {agent_name}'s instructions",
    headers: [{ label: 'Why', value: '{why}' }],
    body: '{rule}',
    expiresAfterHours: 168,
  },
  // Files on this computer (runner/computer.ts): every use waits for approval by default.
  'computer_files.write_file': {
    wantsTo: 'save a file on this computer',
    headers: [{ label: 'Path', value: '{path}' }],
    body: '{content}',
    expiresAfterHours: 24,
  },
  'computer_files.read_file': {
    wantsTo: 'read a file on this computer',
    headers: [{ label: 'Path', value: '{path}' }],
    body: null,
    expiresAfterHours: 24,
  },
  'computer_files.list_folder': {
    wantsTo: 'look in a folder on this computer',
    headers: [{ label: 'Folder', value: '{path}' }],
    body: null,
    expiresAfterHours: 24,
  },
  // The agents' signed-in browser: acting as the person.
  // The decisive clicks: what it does, in the agent's words.
  'signed_in_browser.click_to_pay': {
    wantsTo: 'pay for something, in its browser',
    headers: [],
    body: '{what}',
    expiresAfterHours: 24,
  },
  'signed_in_browser.click_to_post': {
    wantsTo: 'post publicly as the business, in its browser',
    headers: [],
    body: '{what}',
    expiresAfterHours: 24,
  },
  'signed_in_browser.click_to_start_tool': {
    wantsTo: 'start using a new business tool, in its browser',
    headers: [],
    body: '{what}',
    expiresAfterHours: 24,
  },
  'signed_in_browser.click': {
    wantsTo: 'click something as you, in the signed-in browser',
    headers: [],
    body: null,
    expiresAfterHours: 24,
  },
  'signed_in_browser.type': {
    wantsTo: 'type something as you, in the signed-in browser',
    headers: [],
    body: '{text}',
    expiresAfterHours: 24,
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

// A card an integration's author wrote (the server's integration definition,
// cards:), for a tool the app has no card of its own for.
export type IntegrationCard = {
  wants_to: string;
  headers?: { label: string; value: string; optional?: boolean }[];
  body?: string | null;
  expires_after_hours?: number;
};

// Objects reach the card as their JSON (App.tsx), so {body.subject} parses it back.
const parsed = (v: unknown): unknown => {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

// {name} or {name.field.deeper}: undefined when any step isn't there.
function lookup(args: ToolArgs, path: string): unknown {
  let v: unknown = args;
  for (const step of path.split('.')) {
    v = parsed(v);
    if (v === null || typeof v !== 'object') return undefined;
    v = (v as Record<string, unknown>)[step];
  }
  return v;
}

const shown = (v: unknown): string =>
  v === undefined || v === null ? '' : typeof v === 'object' ? (Array.isArray(v) && v.every(x => typeof x !== 'object') ? v.join(', ') : JSON.stringify(v)) : String(v);

function fill(template: string, args: ToolArgs, tool: string): string {
  return template.replace(/\{(\w+(?:\.\w+)*)\}/g, (_, path: string) => {
    const v = lookup(args, path);
    if (v === undefined) {
      console.warn(`Approval tool "${tool}": no "${path}" argument for "${template}"`);
      return '?';
    }
    return shown(v);
  });
}

// "cms.publish_post" -> "Publish post": a tool by what it does, never its id.
const plainTool = (toolId: string) => {
  const w = (toolId.split('.').pop() ?? toolId).replace(/[_-]+/g, ' ').trim();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

// "toAddress" / "to_address" -> "To", "contentType" -> "Content type": a field by what it is.
function plainLabel(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase().split(/\s+/);
  // to / from / cc / bcc / reply to + address or email: just the first part.
  const lead = ['to', 'from', 'cc', 'bcc', 'reply'].includes(words[0]) && /^(address|addresses|email|emails)$/.test(words[words.length - 1]);
  const kept = lead ? words.slice(0, -1) : words;
  const label = kept.join(' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// Values that carry nothing for the person deciding: empty, or a request's
// plumbing (an account id of "me", a content type, an encoding).
const empty = (v: unknown) => v === undefined || v === null || v === '' || (typeof v === 'object' && Object.keys(v as object).length === 0);
const plumbing = (key: string, v: unknown) => {
  const k = key.toLowerCase().replace(/[_-]/g, '');
  return /(contenttype|encoding|charset|mailformat)$/.test(k) || (/id$/.test(k) && typeof v === 'string' && /^(me|self|default|primary)$/i.test(v));
};

// Every leaf of the arguments, objects (or JSON in a string) unpacked, as a path
// a template can use - {body.toAddress} - with nothing empty or plumbing.
function leaves(args: ToolArgs): { path: string; key: string; value: unknown }[] {
  const out: { path: string; key: string; value: unknown }[] = [];
  const walk = (v: unknown, path: string, key: string, depth: number) => {
    const p = parsed(v);
    if (p !== null && typeof p === 'object' && !Array.isArray(p) && depth < 3) {
      for (const [k, x] of Object.entries(p)) walk(x, `${path}.${k}`, k, depth + 1);
      return;
    }
    if (empty(p) || plumbing(key, p)) return;
    out.push({ path, key, value: p });
  };
  // Keys starting "_" are the app's own (_why, shown apart), not the tool's.
  for (const [k, v] of Object.entries(args)) if (!k.startsWith('_')) walk(v, k, k, 0);
  return out;
}

// What an approval card shows, built from the tool's definition + the call's args.
// A tool without a card (an MCP server's, one the Agency Engineer added, and no card
// written for it): every argument, unpacked, as a line; the longest text as the body.
function generic(toolId: string, args: ToolArgs): ApprovalTool {
  const all = leaves(args);
  const long = all.filter(l => typeof l.value === 'string' && l.value.length > 120).sort((a, b) => String(b.value).length - String(a.value).length)[0]?.path;
  // Two leaves with the same name (body.subject and query.subject): the full path tells them apart.
  const named = (key: string) => all.filter(l => l.key === key).length > 1;
  return {
    wantsTo: `use its "${plainTool(toolId)}" tool`,
    headers: all.filter(l => l.path !== long).map(l => ({ label: named(l.key) ? plainLabel(l.path.replace(/\./g, ' ')) : plainLabel(l.key), value: `{${l.path}}` })),
    body: long ? `{${long}}` : null,
    expiresAfterHours: 24,
  };
}

const fromIntegration = (card: IntegrationCard): ApprovalTool => ({
  wantsTo: card.wants_to,
  headers: card.headers ?? [],
  body: card.body ?? null,
  expiresAfterHours: card.expires_after_hours ?? 24,
});

const given = (template: string, args: ToolArgs) => [...template.matchAll(/\{(\w+(?:\.\w+)*)\}/g)].every(m => !empty(lookup(args, m[1])));

// The app's own card first, then the one the integration's author wrote, then the generic one.
export function renderApproval(toolId: string, args: ToolArgs, card?: IntegrationCard | null) {
  const own = (APPROVAL_TOOLS as Record<string, ApprovalTool>)[toolId];
  const tool: ApprovalTool = own ?? (card ? fromIntegration(card) : generic(toolId, args));
  return {
    action: `wants to ${fill(tool.wantsTo, args, toolId)}`,
    // The agent's own reason first, when it gave one.
    fields: [
      ...(typeof args._why === 'string' && args._why.trim() ? [{ label: 'Why', value: args._why.trim() }] : []),
      ...tool.headers.filter(h => !h.optional || given(h.value, args)).map(h => ({ label: h.label, value: fill(h.value, args, toolId) })),
    ],
    body: tool.body === null ? null : fill(tool.body, args, toolId),
    expiresAfterHours: tool.expiresAfterHours,
  };
}
