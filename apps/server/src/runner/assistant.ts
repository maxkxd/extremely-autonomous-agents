import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mcpUrlFor } from './agency-mcp.js';
import { DATA_DIR } from '../paths.js';

// Your AI assistant (docs/requests.md): the agency in the AI app a person
// already uses, connected in one click from Settings > Connectors.
//   Claude Desktop - added to its settings (claude_desktop_config.json), as a tiny
//     program that passes Claude's messages to this agency's MCP address
//     (agency-mcp.ts) and back; it shows once Claude Desktop restarts. (Its
//     Windows Store app opens no .mcpb extension files, so not those.)
//   Cursor - its MCP install link.
// The address is on this computer, so it works while this app is running, and
// only on this computer. ChatGPT, claude.ai and Microsoft Copilot can't reach
// an address on someone's computer, so they aren't offered.

export const ASSISTANTS = {
  'claude-desktop': { name: 'Claude Desktop' },
  cursor: { name: 'Cursor' },
} as const;
export type Assistant = keyof typeof ASSISTANTS;

const ROOT = join(DATA_DIR, 'assistant');

// Opens a file or link with whatever the computer opens it with.
export function openWithSystem(target: string) {
  if (process.platform === 'win32')
    // Verbatim: start's empty quoted window title must reach cmd as written.
    spawn('cmd.exe', ['/c', `start "" "${target}"`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
}

// The program Claude Desktop starts for the agency: newline-separated JSON-RPC
// from Claude on stdin, each posted to the agency, its answer back on stdout.
// Plain Node, no packages: it runs on this app's own runtime, so nobody needs Node.
const BRIDGE = `// Extremely Autonomous Agents: passes Claude's messages to your agency and back.
const url = process.env.AGENCY_MCP_URL;
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) forward(line);
  }
});
async function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: line });
    if (msg.id === undefined || res.status === 202) return;
    if (!res.ok) throw new Error(res.status === 404 ? 'this connection was replaced - connect your AI assistant again from the app' : 'HTTP ' + res.status);
    process.stdout.write((await res.text()).trim() + '\\n');
  } catch (e) {
    if (msg.id === undefined) return;
    const why = "Can't reach your agency. Open the Extremely Autonomous Agents app on this computer, then try again (" + e.message + ').';
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: why } }) + '\\n');
  }
}
`;

// Where Claude Desktop keeps its settings, newest layout first: the Windows
// Store app (Claude-Data), the classic Windows one, and macOS. Only folders
// that are there: an install that's never been opened has none.
async function claudeConfigs(): Promise<string[]> {
  const home = homedir();
  const found: string[] = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const data = join(local, 'Claude-Data');
    for (const d of await readdir(data).catch(() => [] as string[])) if (/^claude_/.test(d)) found.push(join(data, d, 'claude_desktop_config.json'));
    // The classic app's folder, unless the Store one has moved out of it.
    const roaming = join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Claude');
    const left = (await readdir(roaming).catch(() => null)) ?? null;
    if (left && !left.some(f => f.startsWith('.user-data-left'))) found.push(join(roaming, 'claude_desktop_config.json'));
  } else if (process.platform === 'darwin') {
    const dir = join(home, 'Library', 'Application Support', 'Claude');
    if (await readdir(dir).catch(() => null)) found.push(join(dir, 'claude_desktop_config.json'));
  }
  return found;
}

type ClaudeServer = { command: string; args: string[]; env: Record<string, string> };

// Its settings with the agency added (or its address updated), everything else
// as it was. Unreadable settings are never written over.
export function withAgency(text: string | null, key: string, server: ClaudeServer): string {
  const config = text?.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  return JSON.stringify({ ...config, mcpServers: { ...servers, [key]: server } }, null, 2);
}

// Adds the agency to Claude Desktop's settings. It shows once Claude Desktop is
// quit and opened again (it reads them when it starts).
async function addToClaudeDesktop(url: string, key: string) {
  const files = await claudeConfigs();
  if (!files.length) throw new Error("Claude Desktop isn't installed on this computer, or hasn't been opened yet. Install it from claude.com/download, open it once, then try again.");
  await mkdir(ROOT, { recursive: true });
  const bridge = join(ROOT, 'agency-bridge.js');
  await writeFile(bridge, BRIDGE);
  // This app's own runtime (Electron, run as Node), so nothing else is needed.
  const server: ClaudeServer = { command: process.execPath, args: [bridge], env: { ELECTRON_RUN_AS_NODE: '1', AGENCY_MCP_URL: url } };
  for (const file of files) {
    const text = await readFile(file, 'utf8').catch(() => null);
    let next: string;
    try {
      next = withAgency(text, key, server);
    } catch {
      throw new Error(`Claude Desktop's settings (${file}) couldn't be read, so they weren't changed.`);
    }
    // The first time, a copy of how they were.
    if (text !== null) await copyFile(file, `${file}.before-agency`, constants.COPYFILE_EXCL).catch(() => {});
    await writeFile(file, next);
  }
}

// Cursor's one-click MCP install link for this address.
export const cursorLink = (url: string, name = 'agency') =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url })).toString('base64'))}`;

// The name it goes by in the AI assistant: one per organization a teammate connects.
const keyFor = (org?: string) => `extremely-autonomous-agents${org ? `-${org.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : ''}`;

// Connects the agency to the person's AI assistant. url: another address than
// the agency's own (a teammate's, remote-mcp.ts; the caller checks it), for org.
export async function connectAssistant(app: Assistant, url = mcpUrlFor(), org?: string): Promise<{ opened: string; assistant: string; restart: boolean }> {
  const which = ASSISTANTS[app];
  if (!which) throw new Error('That AI assistant isn’t one the app can connect.');
  if (app === 'cursor') {
    const link = cursorLink(url, keyFor(org));
    openWithSystem(link);
    return { opened: link, assistant: which.name, restart: false };
  }
  await addToClaudeDesktop(url, keyFor(org));
  return { opened: 'settings', assistant: which.name, restart: true };
}
