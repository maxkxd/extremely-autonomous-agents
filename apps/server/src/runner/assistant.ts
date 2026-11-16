import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { routerUrl } from './mcp-router.js';
import { DATA_DIR } from '../paths.js';

// MCP, connect your AI assistant (Settings > Connectors, docs/mcp-server.md):
// every agency this person can reach, in the AI app they already use, in one
// click. It's one address on this computer (mcp-router.ts) for whoever uses
// this app - the host or not - acting as them in each organization.
//   Claude Desktop - added to its settings (claude_desktop_config.json), as a tiny
//     program that passes Claude's messages to that address and back; it shows
//     once Claude Desktop restarts, and open, it would write over the change,
//     so it's restarted first when the person says so. (Its Windows Store app
//     opens no .mcpb extension files, so not those.)
//   Claude Code - its own `claude mcp add`, for every project (user scope).
//   Cursor, VS Code - their MCP install links.
// The address is on this computer, so it works while this app is running, and
// only on this computer. ChatGPT, claude.ai and Microsoft Copilot can't reach
// an address on someone's computer, so they aren't offered.

export const ASSISTANTS = {
  'claude-desktop': { name: 'Claude Desktop' },
  'claude-code': { name: 'Claude Code' },
  cursor: { name: 'Cursor' },
  vscode: { name: 'VS Code' },
} as const;
export type Assistant = keyof typeof ASSISTANTS;

const ROOT = join(DATA_DIR, 'assistant');
const run = promisify(execFile);

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
// as it was. Unreadable settings are never written over. Earlier connections
// (one per organization, before one address covered them all) are dropped, so
// the tools don't show twice.
export function withAgency(text: string | null, key: string, server: ClaudeServer): string {
  const config = text?.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  const servers = Object.fromEntries(Object.entries((config.mcpServers ?? {}) as Record<string, unknown>).filter(([k]) => !k.startsWith(OLD_KEY)));
  return JSON.stringify({ ...config, mcpServers: { ...servers, [key]: server } }, null, 2);
}

// Whether Claude Desktop is open (not Claude Code, also a "claude" program).
// Open, it writes back its own copy of its settings and drops what was added.
// Can't tell: taken as closed.
const DESKTOP_EXE = /\\(WindowsApps\\Claude_[^\\]+\\app|AnthropicClaude\\app-[^\\]+)\\Claude\.exe$/i;
async function claudeDesktopOpen(): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object { $_.Path }'], { windowsHide: true });
      return stdout.split(/\r?\n/).some(p => DESKTOP_EXE.test(p.trim()));
    }
    if (process.platform === 'darwin') return !!(await run('pgrep', ['-f', '/Claude.app/Contents/MacOS/Claude'])).stdout.trim();
  } catch {
    // None found (pgrep), or no way to look.
  }
  return false;
}
export const isClaudeDesktop = (path: string) => DESKTOP_EXE.test(path);

// Quits Claude Desktop (only it, never Claude Code) and waits until it's gone.
async function quitClaudeDesktop() {
  if (process.platform === 'win32') {
    const script = `Get-Process claude -ErrorAction SilentlyContinue | Where-Object { $_.Path -match '${DESKTOP_EXE.source.replace(/'/g, "''")}' } | Stop-Process -Force`;
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).catch(() => {});
  } else if (process.platform === 'darwin') await run('osascript', ['-e', 'quit app "Claude"']).catch(() => {});
  for (let i = 0; i < 40; i++) {
    if (!(await claudeDesktopOpen())) return;
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error("Claude Desktop didn't close. Quit it yourself (right-click its icon by the clock, then Quit), then click Connect Claude Desktop again.");
}

// Adds the agency to Claude Desktop's settings, while it's closed (it reads them
// when it starts, and writes its own back while it runs), then opens it. Open:
// restarted when the person said so (restart), else they're asked.
async function addToClaudeDesktop(url: string, key: string, restart: boolean): Promise<'done' | 'needs-restart'> {
  const files = await claudeConfigs();
  if (!files.length) throw new Error("Claude Desktop isn't installed on this computer, or hasn't been opened yet. Install it from claude.com/download, open it once, then try again.");
  if (await claudeDesktopOpen()) {
    if (!restart) return 'needs-restart';
    await quitClaudeDesktop();
  }
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
  // Open again, with the agency among its connectors.
  openWithSystem('claude://claude.ai/new');
  return 'done';
}

// Claude Code's own command line, wherever it's installed: on PATH, or its
// native installer's place (~/.local/bin), which an app started before it was
// installed may not have on its PATH.
async function claudeCli(): Promise<string | null> {
  const home = homedir();
  const places = process.platform === 'win32' ? [join(home, '.local', 'bin', 'claude.exe')] : [join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
  try {
    const { stdout } = await run(process.platform === 'win32' ? 'where.exe' : 'which', ['claude'], { windowsHide: true });
    const first = stdout.split(/\r?\n/).map(l => l.trim()).find(Boolean);
    if (first) return first;
  } catch {
    // not on PATH
  }
  for (const p of places) if (await readFile(p).then(() => true, () => false)) return p;
  return null;
}

export const claudeCodeCommand = (url: string, key = KEY) => `claude mcp add --transport http --scope user ${key} ${url}`;

// Adds the agency to Claude Code for every project (user scope), replacing an
// earlier one. It shows in Claude Code sessions started after this.
async function addToClaudeCode(url: string) {
  const cli = await claudeCli();
  if (!cli) throw new Error(`Claude Code isn't installed on this computer. Install it from claude.com/claude-code, or run this where it is: ${claudeCodeCommand(url)}`);
  // npm's claude.cmd needs a shell on Windows; the address and key have no spaces or quotes.
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli);
  const opts = { windowsHide: true, shell, timeout: 30_000 };
  const exe = shell ? `"${cli}"` : cli;
  await run(exe, ['mcp', 'remove', '--scope', 'user', KEY], opts).catch(() => {});
  try {
    await run(exe, ['mcp', 'add', '--transport', 'http', '--scope', 'user', KEY, url], opts);
  } catch (e) {
    const why = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split(/\r?\n/)[0];
    throw new Error(`Claude Code couldn't add it (${why}). Run this in a terminal instead: ${claudeCodeCommand(url)}`);
  }
}

// VS Code's one-click MCP install link for this address.
export const vscodeLink = (url: string, name = KEY) => `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name, type: 'http', url }))}`;

// Cursor's one-click MCP install link for this address.
export const cursorLink = (url: string, name = KEY) =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url })).toString('base64'))}`;

// The name it goes by in the AI assistant. Earlier ones started with OLD_KEY
// (one per organization), and are replaced.
const KEY = 'extremely';
const OLD_KEY = 'extremely-autonomous-agents';

// done: added (Claude Desktop, Claude Code). asked: its install link opened, and
// the app asks the person to click Install (Cursor, VS Code). needs-restart:
// Claude Desktop is open, and the person is asked whether to restart it.
export type Connected = { assistant: string; status: 'done' | 'asked' | 'needs-restart' };

// Connects every agency this person can reach to their AI assistant.
// restart: Claude Desktop is open and the person said to restart it.
export async function connectAssistant(app: Assistant, restart = false, url = routerUrl()): Promise<Connected> {
  const which = ASSISTANTS[app];
  if (!which) throw new Error('That AI assistant isn’t one the app can connect.');
  if (app === 'cursor' || app === 'vscode') {
    openWithSystem(app === 'cursor' ? cursorLink(url) : vscodeLink(url));
    return { assistant: which.name, status: 'asked' };
  }
  if (app === 'claude-code') {
    await addToClaudeCode(url);
    return { assistant: which.name, status: 'done' };
  }
  return { assistant: which.name, status: await addToClaudeDesktop(url, KEY, restart) };
}
