import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readMeta } from '../files.js';
import { FLEET_ENGINEER, loadAgent } from './agent.js';
import { all, one } from './db.js';
import { postToRequest } from './engineer.js';
import { openBridge } from './mcp.js';
import { execute, toolsFor, type Wake } from './tools.js';

// Send to your IDE (docs/requests.md): a request handed to the person's own AI
// IDE, for work the agency can't do itself. Its folder gets REQUEST.md (the
// request and its conversation, and what to do) and an MCP config giving the
// IDE the Fleet Engineer's tools - so what it builds still goes through drafts,
// the security review and the person's approval. Claude Code and Codex start
// in a terminal with the task; Cursor and Antigravity open the folder.

export const IDES = {
  'claude-code': { name: 'Claude Code', command: 'claude', terminal: true },
  codex: { name: 'Codex', command: 'codex', terminal: true },
  cursor: { name: 'Cursor', command: 'cursor', terminal: false },
  antigravity: { name: 'Antigravity', command: 'antigravity', terminal: false },
} as const;
export type Ide = keyof typeof IDES;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'ide');
const PROMPT = 'Read REQUEST.md in this folder and work through it.';
const bridges = new Map<number, () => void>();

const onPath = (command: string) =>
  promisify(execFile)(process.platform === 'win32' ? 'where' : 'which', [command]).then(
    () => true,
    () => false,
  );

async function brief(r: { id: number; agent_id: string; what: string; why: string; evidence: string | null; expected_effect: string | null }, mcpUrl: string) {
  const agent = await loadAgent(r.agent_id);
  const owner = (await readMeta(r.agent_id))?.owner ?? 'the person';
  const thread = all<{ from_who: string; text: string }>('SELECT from_who, text FROM request_messages WHERE request_id = ? ORDER BY id', r.id);
  return `# Agency request #${r.id}, from ${agent?.name ?? r.agent_id}

${owner} sent this request here from Extremely Autonomous Agents, their AI agency app, because it needs work the agency can't do on its own. Do it for them.

## What the agent needs
${r.what}

**Why:** ${r.why}${r.evidence ? `\n\n**What it tried / what shows it:** ${r.evidence}` : ''}${r.expected_effect ? `\n\n**What changes once it has it:** ${r.expected_effect}` : ''}

${thread.length ? `## The conversation so far (the Fleet Engineer and ${owner})\n\n${thread.map(m => `**${m.from_who === 'you' ? owner : 'Fleet Engineer'}:** ${m.text}`).join('\n\n')}\n\n` : ''}## How to work on it

You have the agency's own tools through its MCP server ("agency", already set up for this folder - approve it when asked). They are the Fleet Engineer's:

- \`engineer__list_requests\`, \`engineer__read_agent\` - the request, and the agent it's for (its Charter and tools).
- \`engineer__list_integrations\`, \`engineer__read_integration\` - what's connected; read \`brave-search\` (HTTP), \`github\` and \`gmail\` as examples of the format.
- \`engineer__write_integration\`, \`engineer__write_plugin\` - save an integration as a draft (it shows in the app's Settings; nothing can call it yet).
- \`engineer__ask_for_connection\` - ask ${owner} for a key; it goes in the app's Settings -> Connectors, never in a file or chat.
- \`engineer__test_integration\` - call a draft's tools for real.
- \`engineer__publish_integration\` - propose it going live: ${owner} approves it in the app.
- \`engineer__reply_to_request\` - tell ${owner}, on the request, what you did or need.

If the work is something else (code in a repository, a setting on this computer), do it here as you normally would, then say what you did with \`engineer__reply_to_request\`.

Agency MCP server: ${mcpUrl} (local to this computer; it ends when the app restarts - send the request to your IDE again for a new one).
`;
}

export async function sendToIde(requestId: number, ide: Ide, wake: Wake): Promise<{ opened: boolean; folder: string; prompt: string; ide: string }> {
  const r = one<{ id: number; agent_id: string; what: string; why: string; evidence: string | null; expected_effect: string | null; status: string }>(
    'SELECT * FROM requests WHERE id = ?',
    requestId,
  );
  if (!r || r.status !== 'open') throw new Error('That request is closed.');
  const which = IDES[ide];
  if (!which) throw new Error('Unknown IDE.');
  const engineer = await loadAgent(FLEET_ENGINEER);
  if (!engineer) throw new Error("The Fleet Engineer isn't set up yet.");

  // The IDE works as the Fleet Engineer: same tools, same tiers, same approvals.
  bridges.get(requestId)?.();
  const { specs, ids } = toolsFor(engineer);
  const runId = `ide-${requestId}-${Date.now().toString(36)}`;
  const ctx = { agent: engineer, runId, level: 0, now: () => Date.now(), fleet: async () => [], wake };
  const bridge = openBridge({ tools: specs, call: async c => execute(ctx, c, ids).then(o => ({ content: o.content, error: o.error })) });
  bridges.set(requestId, bridge.close);

  const folder = join(ROOT, `request-${requestId}`);
  await mkdir(folder, { recursive: true });
  const mcp = JSON.stringify({ mcpServers: { agency: { type: 'http', url: bridge.url } } }, null, 2);
  await writeFile(join(folder, 'REQUEST.md'), await brief(r, bridge.url));
  await writeFile(join(folder, '.mcp.json'), mcp); // Claude Code
  await mkdir(join(folder, '.cursor'), { recursive: true });
  await writeFile(join(folder, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { agency: { url: bridge.url } } }, null, 2)); // Cursor

  let opened = false;
  if (process.platform === 'win32' && (await onPath(which.command))) {
    if (which.terminal) {
      // A terminal window in the folder, the IDE started on the task.
      const launcher = join(folder, 'start.cmd');
      await writeFile(launcher, `@echo off\r\ncd /d "%~dp0"\r\n${which.command} "${PROMPT}"\r\n`);
      // Verbatim: start's quoted window title must reach cmd as written.
      spawn('cmd.exe', ['/c', `start "Request ${requestId}" "${launcher}"`], { cwd: folder, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    } else {
      spawn('cmd.exe', ['/c', `${which.command} "${folder}"`], { cwd: folder, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
    }
    opened = true;
  }
  postToRequest(requestId, 'you', `Sent to ${which.name}.`);
  return { opened, folder, prompt: PROMPT, ide: which.name };
}
