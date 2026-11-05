import { mkdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { agencyMcpUrl } from './agency-mcp.js';
import { getSetting, setSetting } from './db.js';
import { remoteMcpUrl } from './remote-mcp.js';
import { HOSTED_ORG } from '../hosting.js';

// Where the public MCP package (packages/agency-mcp, docs/mcp-server.md) finds
// this app: a small file in the person's own profile folder, listing their own
// agency's address and, for each organization they're in, the address that
// acts as them (remote-mcp.ts: carried by the app, through the relay for one
// hosted elsewhere). The same addresses Settings > Connectors already gives
// out, so it opens nothing new. Rewritten on start, when the app's
// organizations change (sign-out empties them) and when an address is replaced.

export type DirectoryOrg = { id: string; name: string; role: string };
export type Directory = { v: 1; app: string; updated: string; agencies: { id: string; name: string; role: string; url: string }[] };

const ORGS_KEY = 'mcp_directory_orgs';
const APP = 'Extremely Autonomous Agents';

// The same place on every computer of the kind, so the package needs no settings.
export function directoryPath(): string | null {
  if (process.env.EAA_MCP_DISCOVERY) return process.env.EAA_MCP_DISCOVERY;
  // Tests never write the real one; an organization's own agency process isn't the person's app.
  if (process.env.NODE_TEST_CONTEXT || HOSTED_ORG) return null;
  const home = homedir();
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(home, 'AppData', 'Roaming'))
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : (process.env.XDG_CONFIG_HOME ?? join(home, '.config'));
  return join(base, APP, 'agency-mcp.json');
}

export function mcpDirectory(now = Date.now()): Directory {
  const orgs = getSetting<DirectoryOrg[]>(ORGS_KEY, []);
  return {
    v: 1,
    app: APP,
    updated: new Date(now).toISOString(),
    agencies: [{ id: 'personal', name: 'Your agency', role: 'owner', url: agencyMcpUrl() }, ...orgs.map(o => ({ id: o.id, name: o.name, role: o.role, url: remoteMcpUrl(o.id) }))],
  };
}

export async function writeMcpDirectory() {
  const file = directoryPath();
  if (!file) return;
  try {
    await mkdir(dirname(file), { recursive: true });
    // Whole or not at all: the package may read it at any moment.
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(mcpDirectory(), null, 2), { mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    console.error("Couldn't write the AI assistant directory:", (e as Error).message);
  }
}

// The organizations the app shows (it knows them from sign-in; this server doesn't).
export async function setDirectoryOrgs(orgs: unknown) {
  const clean = (Array.isArray(orgs) ? orgs : [])
    .filter((o): o is DirectoryOrg => !!o && typeof o.id === 'string' && !!o.id.trim())
    .slice(0, 50)
    .map(o => ({ id: o.id.slice(0, 100), name: String(o.name ?? o.id).slice(0, 200), role: ['owner', 'admin', 'member'].includes(String(o.role)) ? String(o.role) : 'member' }));
  if (JSON.stringify(clean) !== JSON.stringify(getSetting<DirectoryOrg[]>(ORGS_KEY, []))) setSetting(ORGS_KEY, clean);
  await writeMcpDirectory();
  return { agencies: clean.length + 1 };
}
