import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { mcpUrlFor } from './agency-mcp.js';
import { DATA_DIR } from '../paths.js';

// Your AI assistant (docs/requests.md): the agency in the AI app a person
// already uses, connected in one click from Settings > Connectors.
//   Claude Desktop - an extension file (.mcpb) the app opens, and Claude Desktop
//     asks to install it. Inside, a tiny program that passes Claude's messages
//     to this agency's MCP address (agency-mcp.ts) and back.
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

// The program inside the extension: newline-separated JSON-RPC from Claude on
// stdin, each posted to the agency, its answer back on stdout. Plain Node, no
// packages (Claude Desktop runs it with its own Node).
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

// A zip with its files stored as they are (no compression): all an .mcpb needs.
export function zip(files: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, f.data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(f.data.length, 20);
    entry.writeUInt32LE(f.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + f.data.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, dir, end]);
}

// The Claude Desktop extension for this address (manifest spec 0.3).
export function claudeExtension(url: string): Buffer {
  const manifest = {
    manifest_version: '0.3',
    name: 'extremely-autonomous-agents',
    display_name: 'Extremely Autonomous Agents',
    version: '1.0.0',
    description: 'Your agency: its agents, requests, approvals and tools. Works while the Extremely Autonomous Agents app is open on this computer.',
    author: { name: 'Extremely Autonomous Agents' },
    server: {
      type: 'node',
      entry_point: 'server/index.js',
      mcp_config: { command: 'node', args: ['${__dirname}/server/index.js'], env: { AGENCY_MCP_URL: url } },
    },
  };
  return zip([
    { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) },
    { name: 'server/index.js', data: Buffer.from(BRIDGE) },
  ]);
}

// Cursor's one-click MCP install link for this address.
export const cursorLink = (url: string) =>
  `cursor://anysphere.cursor-deeplink/mcp/install?name=agency&config=${encodeURIComponent(Buffer.from(JSON.stringify({ url })).toString('base64'))}`;

// Connects the agency to the person's AI assistant: opens the install for it.
// Returns what was opened, so the app can say what to do if nothing appears.
export async function connectAssistant(app: Assistant): Promise<{ opened: string; assistant: string }> {
  const which = ASSISTANTS[app];
  if (!which) throw new Error('That AI assistant isn’t one the app can connect.');
  const url = mcpUrlFor();
  if (app === 'cursor') {
    const link = cursorLink(url);
    openWithSystem(link);
    return { opened: link, assistant: which.name };
  }
  await mkdir(ROOT, { recursive: true });
  const file = join(ROOT, 'Extremely Autonomous Agents.mcpb');
  await writeFile(file, claudeExtension(url));
  openWithSystem(file);
  return { opened: file, assistant: which.name };
}
