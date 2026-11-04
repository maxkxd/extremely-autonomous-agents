import { existsSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { DATA_DIR } from '../paths.js';
import { registerTools, type ToolDef } from './tools.js';

// Files and folders on the computer the agency runs on - outside the agents' own
// workspaces: reports into the person's Documents, a folder a team shares, a
// server set aside for the agents. Every call waits for a person's approval
// (catalog.ts) unless they lower it on the Tools page.
//
// Whatever the tier, never: the agency's own data (its keys and sign-ins, every
// agent's memory and workspace), credential stores, browsers' profiles, or key
// files - a silent read tool would otherwise hand every connected account to
// whatever reads the page an agent was given.

const MAX_WRITE = 2_000_000;
const MAX_READ = 60_000;

const home = homedir();
const FORBIDDEN_DIRS = [
  DATA_DIR,
  ...['.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.claude', '.codex', '.config/gcloud', '.config/gh', '.mozilla'].map(d => join(home, d)),
  ...['AppData/Local/Google/Chrome/User Data', 'AppData/Local/Microsoft/Edge/User Data', 'AppData/Local/BraveSoftware', 'AppData/Roaming/Mozilla', 'AppData/Roaming/Claude']
    .map(d => join(home, d)),
  ...['Library/Application Support/Google/Chrome', 'Library/Application Support/Firefox', 'Library/Keychains', 'Library/Application Support/Claude'].map(d => join(home, d)),
];
const FORBIDDEN_FILES = /^(\.env(\..*)?|\.netrc|\.git-credentials|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|kdbx|keychain))$/i;

const lower = process.platform === 'win32' || process.platform === 'darwin' ? (p: string) => p.toLowerCase() : (p: string) => p;
const inside = (child: string, parent: string) => {
  const r = relative(lower(parent), lower(child));
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

// The real path (links followed) of what's there, or of its nearest existing folder.
function real(p: string): string {
  let at = p;
  const rest: string[] = [];
  while (!existsSync(at)) {
    const up = dirname(at);
    if (up === at) return p;
    rest.unshift(basename(at));
    at = up;
  }
  try {
    return join(realpathSync.native(at), ...rest);
  } catch {
    return p;
  }
}

// "~/Documents/Reports/x.md" or a full path -> an allowed absolute path, or an error.
export function computerPath(path: unknown): string {
  let p = String(path ?? '').trim();
  if (!p) throw new Error('Give the full path, like "~/Documents/Reports/2026-11-02 payouts.md".');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = join(home, p.slice(1));
  if (!isAbsolute(p)) throw new Error(`Give a full path (starting with ~ for the home folder, or the drive or /), not "${p}". Your own workspace is files.*.`);
  const full = normalize(resolve(p));
  for (const candidate of [full, real(full)]) {
    if (FORBIDDEN_DIRS.some(d => inside(candidate, d) || inside(candidate, real(d))))
      throw new Error("That's somewhere agents never go, whatever their permissions: the agency's own data, or where keys, passwords and browser sign-ins are kept.");
    if (FORBIDDEN_FILES.test(basename(candidate))) throw new Error("That's a key or secrets file, which agents never read or write, whatever their permissions.");
  }
  return full;
}

export const COMPUTER_TOOLS: ToolDef[] = [
  {
    id: 'computer_files.read_file',
    tier: 'T2',
    description:
      'Read a text file anywhere on this computer the person allows (not your workspace - that is files.read_file). Full path; ~ is the home folder.',
    schema: { type: 'object', properties: { path: { type: 'string', description: 'Full path, e.g. "~/Documents/Prices.csv"' } }, required: ['path'] },
    impl: async a => {
      const full = computerPath(a.path);
      const s = await stat(full).catch(() => null);
      if (!s) throw new Error(`Nothing at ${full}.`);
      if (s.isDirectory()) throw new Error(`${full} is a folder - computer_files.list_folder lists it.`);
      const buf = await readFile(full);
      if (buf.subarray(0, 8000).includes(0)) throw new Error(`${full} isn't a text file (${s.size.toLocaleString()} bytes).`);
      const text = buf.toString('utf8');
      return text.length > MAX_READ ? `${text.slice(0, MAX_READ)}\n[cut off at ${MAX_READ.toLocaleString()} characters of ${text.length.toLocaleString()}]` : text;
    },
  },
  {
    id: 'computer_files.write_file',
    tier: 'T2',
    description:
      "Save a file anywhere on this computer the person allows - a report into their Documents, a sheet into a shared folder. Creates the folders on the way; replaces the file unless append is true. Not your working notes (that's files.write_file).",
    schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Full path, e.g. "~/Documents/Payout reports/2026-11-02.md"' },
        content: { type: 'string', description: 'The whole file (or what to add, with append)' },
        append: { type: 'boolean', description: 'Add to the end instead of replacing' },
      },
      required: ['path', 'content'],
    },
    impl: async a => {
      const full = computerPath(a.path);
      const content = String(a.content ?? '');
      if (content.length > MAX_WRITE) throw new Error(`Too large (${content.length.toLocaleString()} characters); keep it under ${MAX_WRITE.toLocaleString()}.`);
      if ((await stat(full).catch(() => null))?.isDirectory()) throw new Error(`${full} is a folder; give a file name inside it.`);
      await mkdir(dirname(full), { recursive: true });
      if (a.append) await appendFile(full, content);
      else await writeFile(full, content);
      // Its name and folder, as a person would say it: no full path, no size.
      return `${a.append ? 'Added to' : 'Saved'} "${basename(full)}" in the ${basename(dirname(full))} folder.`;
    },
  },
  {
    id: 'computer_files.list_folder',
    tier: 'T2',
    description: "List what's in a folder on this computer: names, sizes, when each changed. Full path; ~ is the home folder.",
    schema: { type: 'object', properties: { path: { type: 'string', description: 'Full path, e.g. "~/Documents"' } }, required: ['path'] },
    impl: async a => {
      const full = computerPath(a.path);
      const entries = await readdir(full, { withFileTypes: true }).catch(() => {
        throw new Error(`No folder at ${full}.`);
      });
      const rows = await Promise.all(
        entries.slice(0, 500).map(async e => {
          const s = await stat(join(full, e.name)).catch(() => null);
          return e.isDirectory() ? `${e.name}${sep}` : `${e.name} - ${(s?.size ?? 0).toLocaleString()} bytes, changed ${s ? s.mtime.toISOString().slice(0, 16).replace('T', ' ') : '?'}`;
        }),
      );
      return rows.length ? `${full}\n${rows.join('\n')}${entries.length > 500 ? `\n...and ${entries.length - 500} more` : ''}` : `${full} is empty.`;
    },
  },
];
registerTools(COMPUTER_TOOLS);
