import { execFile, spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readMeta } from '../files.js';
import { loadAgent } from './agent.js';
import { agencyMcpUrl } from './agency-mcp.js';
import { all, one } from './db.js';
import { DATA_DIR } from '../paths.js';

// Send to your IDE (docs/requests.md): a request handed to the person's own AI
// IDE. Its folder gets REQUEST.md (the request, its conversation, what to do)
// and an MCP config for the agency's own MCP server (agency-mcp.ts): everything
// the Agency Engineer and the agent builder can do, approved in the IDE call by
// call. Claude Code and Codex start in a terminal with the task; Cursor and
// Antigravity open the folder.

export const IDES = {
  'claude-code': { name: 'Claude Code', command: 'claude', terminal: true },
  codex: { name: 'Codex', command: 'codex', terminal: true },
  cursor: { name: 'Cursor', command: 'cursor', terminal: false },
  antigravity: { name: 'Antigravity', command: 'antigravity', terminal: false },
} as const;
export type Ide = keyof typeof IDES;

const ROOT = join(DATA_DIR, 'ide');
const PROMPT = 'Read REQUEST.md in this folder and work through it.';

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

${thread.length ? `## The conversation so far (the Agency Engineer and ${owner})\n\n${thread.map(m => `**${m.from_who === 'you' ? owner : 'Agency Engineer'}:** ${m.text}`).join('\n\n')}\n\n` : ''}## How to work on it

You have the whole agency through its MCP server ("agency", already set up for this folder - approve it when asked). It acts for ${owner}, so changes apply straight away:

- Requests: \`list_requests\`, \`answer_request\` (done or rejected - say what you did).
- Agents: \`list_agents\`, \`read_agent\`, \`write_agent_file\` (CHARTER.md, TOOLS.yaml, KPI.yaml), \`set_agent_models\` (\`list_models\`), \`set_agent\`, \`create_agent\`, \`delete_agent\`, \`run_agent\`, \`give_tools\`.
- Integrations: \`list_integrations\`, \`read_integration\` (\`brave-search\`, \`github\`, \`gmail\` show the format), \`write_integration\` and \`write_plugin\` (drafts), \`test_integration\`, \`publish_integration\`, \`discard_integration\`.
- \`list_approvals\`: what's waiting on ${owner} in the app.

Keys and sign-ins go in the app's Settings -> Connectors, never in a file or chat: ask ${owner} to add one there. If the work is something else (code in a repository, a setting on this computer), do it here as you normally would, then close the request with \`answer_request\`.

Agency MCP server: ${mcpUrl} (on this computer only; while the app is running).
`;
}

export async function sendToIde(requestId: number, ide: Ide): Promise<{ opened: boolean; folder: string; prompt: string; ide: string }> {
  const r = one<{ id: number; agent_id: string; what: string; why: string; evidence: string | null; expected_effect: string | null; status: string }>(
    'SELECT * FROM requests WHERE id = ?',
    requestId,
  );
  if (!r || r.status !== 'open') throw new Error('That request is closed.');
  const which = IDES[ide];
  if (!which) throw new Error('Unknown IDE.');
  const url = agencyMcpUrl();

  const folder = join(ROOT, `request-${requestId}`);
  await mkdir(folder, { recursive: true });
  const mcp = JSON.stringify({ mcpServers: { agency: { type: 'http', url: url } } }, null, 2);
  await writeFile(join(folder, 'REQUEST.md'), await brief(r, url));
  await writeFile(join(folder, '.mcp.json'), mcp); // Claude Code
  await mkdir(join(folder, '.cursor'), { recursive: true });
  await writeFile(join(folder, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { agency: { url: url } } }, null, 2)); // Cursor

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
  return { opened, folder, prompt: PROMPT, ide: which.name };
}
