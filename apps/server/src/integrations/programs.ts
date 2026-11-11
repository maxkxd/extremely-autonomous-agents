import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, cp, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { safeFetch } from '../runner/net.js';
import { DATA_DIR } from '../paths.js';

// Programs a code plugin runs (docs/integrations.md, "Programs"): ffmpeg,
// yt-dlp, Python... The agency fetches its own, each behind one person's
// approval (engineer.install_program), instead of the app or its container
// image shipping them. They go in the agency's data folder - on the cloud host,
// its volume, so they're kept across redeploys - and only plugin processes get
// them on their PATH. Each install records a SHA-256 of every file; on start
// they're checked again, and one that changed is left off the PATH until it is
// installed again.
//
// Installed programs are NOT sandboxed: a plugin with commands: true starts
// them, and they can do whatever this agency's user can. The card says so.

const ROOT = join(DATA_DIR, 'programs');
const MANIFEST = join(ROOT, 'programs.json');
const run = promisify(execFile);
const MAX_DOWNLOAD = 1024 * 1024 * 1024; // 1 GB
const WIN = process.platform === 'win32';

export type ProgramSource =
  // A file attached to a release on GitHub: a single program, or a .zip / .tar.gz / .tar.xz of one.
  | { kind: 'github_release'; url: string; repo: string; tag: string; asset: string }
  // A package from PyPI, installed with the Python this agency installed (program "python").
  | { kind: 'pypi'; package: string }
  // A package from npm (registry.npmjs.org), installed with npm into its own folder; its
  // commands are JavaScript, run with this agency's own Node (kit.command gives the way).
  | { kind: 'npm'; package: string };

export type InstallSpec = {
  name: string;
  version: string;
  source: ProgramSource;
  // The download's SHA-256 (github_release): given, or read from the release.
  sha256?: string;
  // The program's commands: file names to find in what was downloaded (".exe" added on Windows).
  bins: string[];
  // Run after installing, to show it works: `<first bin> <check_args>`.
  checkArgs?: string[];
};

export type Installed = {
  name: string;
  version: string;
  source: ProgramSource;
  sha256: string | null;
  bins: string[];
  // Folders put on plugins' PATH, relative to programs/.
  pathDirs: string[];
  // Each file of the install and its SHA-256, relative to programs/ (none for a PyPI package: it's in Python's).
  dir: string | null;
  files: Record<string, string>;
  installedAt: number;
  by: string | null;
  check: string | null;
  // An npm package's commands: name -> its script, relative to programs/ (run with Node).
  scripts?: Record<string, string>;
};
type Manifest = { programs: Record<string, Installed> };

export const NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,60}$/;
const BIN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,60}$/;
const SHA = /^[a-f0-9]{64}$/;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]{0,213}$/;

// --- Where it comes from ----------------------------------------------------------

// https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>, and nothing else.
export function parseReleaseUrl(raw: string): Extract<ProgramSource, { kind: 'github_release' }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`"${raw}" isn't an address.`);
  }
  const m = u.protocol === 'https:' && u.host === 'github.com' && !u.search && !u.hash ? u.pathname.match(/^\/([\w.-]+)\/([\w.-]+)\/releases\/download\/([^/]+)\/([^/]+)$/) : null;
  if (!m) throw new Error(`Programs come from a release on GitHub: https://github.com/<owner>/<repo>/releases/download/<tag>/<file>. "${raw}" isn't one.`);
  const [, owner, repo, tag, asset] = m;
  if (tag === 'latest' || /latest/i.test(decodeURIComponent(tag))) throw new Error('Pin a release: name its tag, not "latest", so what a person approves is what gets installed.');
  return { kind: 'github_release', url: u.toString(), repo: `${owner}/${repo}`, tag: decodeURIComponent(tag), asset: decodeURIComponent(asset) };
}

export function checkSpec(s: InstallSpec) {
  if (!NAME.test(s.name)) throw new Error(`"${s.name}" isn't a program name: lowercase letters, digits, . _ - (e.g. ffmpeg).`);
  if (!VERSION.test(s.version)) throw new Error(`"${s.version}" isn't a version: give the exact one (e.g. 7.1, 2025.10.22).`);
  if (s.sha256 !== undefined && !SHA.test(s.sha256.toLowerCase())) throw new Error('sha256 is 64 hexadecimal characters.');
  if (s.source.kind === 'github_release') {
    if (!s.bins.length) throw new Error('Name the program\'s commands in bins (e.g. ["ffmpeg", "ffprobe"]).');
  } else if (s.source.kind === 'pypi' && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(s.source.package)) throw new Error(`"${s.source.package}" isn't a PyPI package name.`);
  else if (s.source.kind === 'npm' && !NPM_NAME.test(s.source.package)) throw new Error(`"${s.source.package}" isn't an npm package name.`);
  if (s.source.kind === 'npm' && !/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(s.version)) throw new Error(`"${s.version}" isn't an exact npm version (e.g. 3.3.3).`);
  for (const b of s.bins) if (!BIN.test(b)) throw new Error(`"${b}" isn't a command name.`);
  if ((s.checkArgs ?? []).some(a => typeof a !== 'string' || a.length > 40)) throw new Error('check_args are a few short words, e.g. ["-version"].');
}

type Fetcher = (url: string, init?: { headers?: Record<string, string>; timeoutMs?: number }) => Promise<{ res: Response }>;
// Public addresses only, every redirect checked (GitHub sends downloads on to its file host).
const viaSafeFetch: Fetcher = async (url, init) => ({ res: (await safeFetch(url, init)).res as unknown as Response });
let fetcher: Fetcher = viaSafeFetch;
// Tests: a stand-in for the network.
export const setProgramFetcher = (f: Fetcher | null) => void (fetcher = f ?? viaSafeFetch);

async function getJson(url: string): Promise<unknown> {
  const { res } = await fetcher(url, { headers: { accept: 'application/json', 'user-agent': 'extremely-agency' } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}.`);
  return res.json();
}

type Asset = { name: string; size: number; digest?: string | null; browser_download_url: string };

// The download's checksum from the release itself: GitHub's own digest of the
// file, else a checksum file published with it (SHA2-256SUMS, checksums.sha256,
// <file>.sha256...). One given must match.
export async function releaseChecksum(src: Extract<ProgramSource, { kind: 'github_release' }>, given?: string): Promise<{ sha256: string; size: number | null; how: string }> {
  const rel = (await getJson(`https://api.github.com/repos/${src.repo}/releases/tags/${encodeURIComponent(src.tag)}`).catch(e => {
    throw new Error(`Couldn't find release ${src.tag} of github.com/${src.repo}: ${(e as Error).message}`);
  })) as { assets?: Asset[] };
  const assets = rel.assets ?? [];
  const asset = assets.find(a => a.name === src.asset);
  if (!asset) throw new Error(`Release ${src.tag} of github.com/${src.repo} has no file "${src.asset}". Its files: ${assets.map(a => a.name).slice(0, 30).join(', ') || 'none'}.`);
  let found: string | null = null;
  let how = '';
  if (asset.digest && /^sha256:[a-f0-9]{64}$/i.test(asset.digest)) {
    found = asset.digest.slice(7).toLowerCase();
    how = 'GitHub\'s checksum of the release file';
  } else {
    const sums = assets.filter(a => /sha256|sha2-256|checksum/i.test(a.name) && a.size < 2_000_000);
    for (const s of sums) {
      const { res } = await fetcher(s.browser_download_url, { headers: { 'user-agent': 'extremely-agency' } });
      if (!res.ok) continue;
      const text = await res.text();
      for (const line of text.split('\n')) {
        const m = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
        if (m && (m[2].trim() === src.asset || m[2].trim().endsWith(`/${src.asset}`))) found = m[1].toLowerCase();
        // <file>.sha256 holding only the hash.
        if (!found && s.name === `${src.asset}.sha256` && /^[a-f0-9]{64}$/i.test(line.trim())) found = line.trim().toLowerCase();
      }
      if (found) {
        how = `the release's ${s.name}`;
        break;
      }
    }
  }
  if (given && found && given.toLowerCase() !== found) throw new Error(`The sha256 given doesn't match the release's (${found}). Check which file you meant.`);
  if (!found && !given) throw new Error(`Release ${src.tag} of github.com/${src.repo} publishes no checksum for ${src.asset}. Give sha256, from the project's own release notes or site.`);
  return { sha256: (found ?? given)!.toLowerCase(), size: asset.size ?? null, how: found ? how : 'given by the Agency Engineer from the project' };
}

export async function pypiRelease(pkg: string, version: string): Promise<{ summary: string }> {
  const info = (await getJson(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/${encodeURIComponent(version)}/json`).catch(e => {
    throw new Error(`PyPI has no ${pkg} ${version}: ${(e as Error).message}`);
  })) as { info?: { summary?: string; yanked?: boolean } };
  if (info.info?.yanked) throw new Error(`${pkg} ${version} was withdrawn (yanked) on PyPI: pick another version.`);
  return { summary: info.info?.summary ?? '' };
}

// An exact version on the npm registry, and the fingerprint npm checks its download against.
export async function npmRelease(pkg: string, version: string): Promise<{ description: string; integrity: string; tarball: string; bins: string[] }> {
  const name = pkg.startsWith('@') ? `@${encodeURIComponent(pkg.slice(1))}` : encodeURIComponent(pkg);
  const info = (await getJson(`https://registry.npmjs.org/${name}/${encodeURIComponent(version)}`).catch(e => {
    throw new Error(`npm has no ${pkg} ${version}: ${(e as Error).message}`);
  })) as { description?: string; deprecated?: string; bin?: string | Record<string, string>; dist?: { integrity?: string; tarball?: string } };
  if (info.deprecated) throw new Error(`${pkg} ${version} is deprecated on npm ("${String(info.deprecated).slice(0, 120)}"): pick another version or package.`);
  if (!info.dist?.integrity || !info.dist.tarball) throw new Error(`npm lists no download for ${pkg} ${version}.`);
  const bins = typeof info.bin === 'string' ? [pkg.split('/').pop()!] : Object.keys(info.bin ?? {});
  return { description: info.description ?? '', integrity: info.dist.integrity, tarball: info.dist.tarball, bins };
}

// --- The manifest, and what's on the PATH -----------------------------------------

async function readManifest(): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(MANIFEST, 'utf8')) as Manifest;
  } catch {
    return { programs: {} };
  }
}
async function writeManifest(m: Manifest) {
  await mkdir(ROOT, { recursive: true });
  await writeFile(`${MANIFEST}.tmp`, JSON.stringify(m, null, 2));
  await rename(`${MANIFEST}.tmp`, MANIFEST);
}

// Checked on start: name -> ok, or why it isn't.
const verified = new Map<string, true | string>();

export async function listPrograms(): Promise<(Installed & { state: 'ok' | 'unchecked' | string })[]> {
  const m = await readManifest();
  return Object.values(m.programs).map(p => {
    const v = verified.get(p.name);
    return { ...p, state: v === true ? 'ok' : (v ?? 'unchecked') };
  });
}

// How a plugin starts each program that checked out (kit.command): a program's own
// file, or for an npm package's command, this agency's Node and the script.
export async function programCommands(): Promise<Record<string, string[]>> {
  const m = await readManifest();
  const out: Record<string, string[]> = {};
  for (const p of Object.values(m.programs)) {
    if (verified.get(p.name) !== true) continue;
    // A PyPI package's commands are in its Python's folders.
    const dirs = p.source.kind === 'pypi' ? (m.programs.python?.pathDirs ?? []) : p.pathDirs;
    if (p.scripts) for (const [bin, rel] of Object.entries(p.scripts)) out[bin] = [process.execPath, join(ROOT, rel)];
    else
      for (const bin of p.bins)
        for (const d of dirs) {
          const f = await locate([join(ROOT, d)], bin);
          if (f) {
            out[bin] = [f];
            break;
          }
        }
  }
  return out;
}

// For plugin processes (sandbox.ts): the folders of programs that checked out, before the rest of PATH.
let pathDirs: string[] = [];
export const programPathDirs = () => pathDirs;
export function withProgramsOnPath(path: string | undefined): string {
  return [...pathDirs, ...(path ? [path] : [])].join(delimiter);
}
async function refreshPath() {
  const m = await readManifest();
  pathDirs = [...new Set(Object.values(m.programs).filter(p => verified.get(p.name) === true).flatMap(p => p.pathDirs.map(d => join(ROOT, d))))];
}


async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}
async function hashTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      const rel = relative(ROOT, full).split(sep).join('/');
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out[rel] = await hashFile(full);
      // A link is recorded by where it points.
      else if (e.isSymbolicLink()) out[rel] = `link:${relative(dirname(full), await realpath(full)).split(sep).join('/')}`;
    }
  };
  await walk(dir);
  return out;
}

// Every file as installed, nothing added or changed. Returns why not, or null.
async function changed(p: Installed): Promise<string | null> {
  if (!p.dir) return null;
  const now = await hashTree(join(ROOT, p.dir)).catch(() => null);
  if (!now) return 'its files are missing';
  const was = p.files;
  const diff = [...Object.keys(was).filter(k => now[k] !== was[k]), ...Object.keys(now).filter(k => !(k in was))];
  return diff.length ? `${diff.length} file${diff.length > 1 ? 's' : ''} changed since it was installed (${diff.slice(0, 3).join(', ')})` : null;
}

// On start: every program checked against what was installed. One that changed
// stays off the PATH; told is how the Agency Engineer hears.
let firstCheck: Promise<void> | null = null;
let queue: Promise<unknown> = Promise.resolve();
// One install, removal or check at a time: each reads the record, works for minutes
// and writes it back, so two at once would lose one's changes.
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => {});
  return next;
}
// Plugins wait for this (sandbox.ts): until programs are checked, none is offered,
// and a plugin would quietly get another copy of the same command from the PATH.
export const programsChecked = (): Promise<void> => (firstCheck ??= verifyPrograms().catch(() => {}));

// In the same queue as installs: a check never hashes a folder an install is replacing.
export function verifyPrograms(told?: (name: string, why: string) => void): Promise<void> {
  const check = oneAtATime(() => verifyNow(told));
  firstCheck ??= check.catch(() => {});
  return check;
}
// On start, before anything else: downloads a restart cut short are cleared, the
// installed programs checked, and "node" made for the desktop app's scripts.
export function startPrograms(told?: (name: string, why: string) => void): Promise<void> {
  const start = oneAtATime(async () => {
    await clearStaging();
    await nodeShim().catch(() => {});
    await verifyNow(told);
  });
  firstCheck ??= start.catch(() => {});
  return start;
}
async function verifyNow(told?: (name: string, why: string) => void): Promise<void> {
  const m = await readManifest();
  // A PyPI package lives in Python's folder: it's as good as Python.
  for (const p of Object.values(m.programs).filter(p => p.dir)) {
    const why = await changed(p).catch(e => (e as Error).message);
    verified.set(p.name, why ?? true);
    if (why) told?.(p.name, why);
  }
  for (const p of Object.values(m.programs).filter(p => !p.dir)) {
    const host = m.programs[(p.source as { python?: string }).python ?? 'python'];
    verified.set(p.name, host && verified.get(host.name) === true ? true : 'the Python it was installed into is missing or changed');
  }
  await refreshPath();
}

// --- Installing --------------------------------------------------------------------

async function download(url: string, to: string, sha256: string) {
  const { res } = await fetcher(url, { headers: { 'user-agent': 'extremely-agency' }, timeoutMs: 20 * 60_000 });
  if (!res.ok || !res.body) throw new Error(`Downloading it failed: ${new URL(url).host} answered ${res.status}.`);
  const h = createHash('sha256');
  let size = 0;
  const count = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > MAX_DOWNLOAD) return cb(new Error('The download is larger than 1 GB.'));
      h.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), count, createWriteStream(to));
  const got = h.digest('hex');
  if (got !== sha256) throw new Error(`The download's checksum is ${got}, not the approved ${sha256}: nothing was installed.`);
}

// Unpacks with the system's own tar (Windows 10 and later have one that also takes .zip).
async function unpack(file: string, asset: string, into: string, bin: string) {
  await mkdir(into, { recursive: true });
  const lower = asset.toLowerCase();
  const tar = WIN ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  try {
    if (/\.(tar\.(gz|xz|bz2)|tgz|txz)$/.test(lower)) await run(tar, ['-xf', file, '-C', into], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    else if (lower.endsWith('.zip')) await (WIN || process.platform === 'darwin' ? run(tar, ['-xf', file, '-C', into], { timeout: 10 * 60_000 }) : run('unzip', ['-q', file, '-d', into], { timeout: 10 * 60_000 }));
    else {
      // A single program: named as its command.
      const target = join(into, WIN && !bin.endsWith('.exe') ? `${bin}.exe` : bin);
      await rename(file, target);
      await chmod(target, 0o755);
    }
  } catch (e) {
    const msg = (e as { stderr?: string; message: string }).stderr?.trim() || (e as Error).message;
    throw new Error(`Unpacking ${asset} failed: ${msg.slice(0, 300)}${/xz/i.test(msg) ? ' (this host has no xz to unpack .tar.xz: pick the .zip or .tar.gz of the same release, if there is one)' : ''}`);
  }
}

// Windows can refuse to move a folder for a moment after a program in it ran
// (its scanner still has the file open): tried again, then copied instead.
async function moveInto(from: string, to: string) {
  for (let i = 0; i < 5; i++) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise(r => setTimeout(r, 300 * (i + 1)));
    }
  }
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
}

async function findBins(dir: string, bins: string[]): Promise<Map<string, string>> {
  const want = new Map(bins.map(b => [WIN && !/\.(exe|cmd|bat)$/i.test(b) ? `${b}.exe`.toLowerCase() : WIN ? b.toLowerCase() : b, b]));
  const found = new Map<string, string>();
  const walk = async (d: string, depth: number) => {
    if (depth > 6) return;
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full, depth + 1);
      else {
        const b = want.get(WIN ? e.name.toLowerCase() : e.name);
        // The shallowest one wins (a "bin/ffmpeg" over a copy deeper in docs).
        if (b && (!found.has(b) || full.split(sep).length < found.get(b)!.split(sep).length)) found.set(b, full);
      }
    }
  };
  await walk(dir, 0);
  const missing = bins.filter(b => !found.has(b));
  if (missing.length) throw new Error(`The download has no ${missing.join(', ')}${WIN ? ' (.exe)' : ''}: is it the build for this computer (${process.platform}, ${process.arch})?`);
  if (!WIN) for (const f of found.values()) await chmod(f, 0o755).catch(() => {});
  return found;
}

async function tryIt(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { stdout, stderr } = await run(bin, args, { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env });
    return (stdout || stderr).trim().split('\n')[0]?.slice(0, 200) ?? '';
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string; code?: unknown; signal?: unknown };
    const said = [err.stdout ?? '', err.stderr ?? ''].join('\n').trim();
    // It started and answered, just not happily (many tools have no --version): it runs here.
    // Not: couldn't start (ENOENT, a build for another system), killed, or the system's
    // "can't run this" (126/127: missing libraries, not executable).
    const ran = typeof err.code === 'number' && err.code !== 126 && err.code !== 127 && !err.signal && !/error while loading shared libraries|cannot execute|exec format error|is not a valid Win32|not compatible with the version of Windows/i.test(said);
    if (ran) return said.split('\n')[0]?.slice(0, 200) || `(it ran, and exited with code ${err.code})`;
    throw new Error(`It was downloaded but doesn't run here: ${(said || err.message).slice(0, 300)}`);
  }
}

// Python's folder for console commands (pip puts yt-dlp's there).
// Where a Python keeps things (sysconfig): 'scripts' for its packages' commands, 'purelib' for packages.
type PythonPath = (python: string, which: 'scripts' | 'purelib') => Promise<string>;
const askPython: PythonPath = async (python, which) =>
  (await run(python, ['-c', `import sysconfig; print(sysconfig.get_path('${which}'))`], { timeout: 30_000, windowsHide: true, env: plainEnv() })).stdout.trim();
let pythonPath: PythonPath = askPython;
// Tests: a stand-in Python.
export const setPythonPath = (f: PythonPath | null) => void (pythonPath = f ?? askPython);
const scriptsDir = (python: string) => pythonPath(python, 'scripts');

// Every .py compiled once, as installed, and recorded: Python compiles its first few
// modules before anything can tell it not to, so a run then has nothing to add. Some
// files never compile (Python's own tests of bad syntax), so the exit code isn't the answer.
type Compile = (python: string, dir: string) => Promise<void>;
const compileAll: Compile = async (python, dir) => {
  await run(python, ['-m', 'compileall', '-q', '-j', '0', dir], { timeout: 10 * 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, env: { ...plainEnv(), PYTHONDONTWRITEBYTECODE: '' } }).catch(() => {});
};
let precompile: Compile = compileAll;
// Tests: a stand-in Python compiles nothing.
export const setPythonCompile = (f: Compile | null) => void (precompile = f ?? compileAll);

// What every program the agency installed runs with - its check, pip, npm and its
// install scripts here, and plugins' programs (sandbox.ts) - never the server's own
// environment, which holds its keys:
// - the system's basics, and the installed programs first on the PATH;
// - this agency's Node as "node" (the desktop app's is Electron's, with no node command);
// - caches (a browser npm tools fetch, say) kept with the programs - on the cloud host,
//   in the volume - not in a home folder a redeploy wipes;
// - Python writing no compiled files, so every file stays as installed and checked.
const CACHE = join(ROOT, '.cache');
const NODE_SHIM = join(ROOT, '.node');
export function programEnv(): Record<string, string> {
  // The system's basics, and how this computer reaches the internet (a proxy, its own certificates).
  const keep = ['PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'SystemDrive', 'windir', 'ComSpec', 'ProgramData', 'PROCESSOR_ARCHITECTURE', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'LANG', 'TZ', 'ELECTRON_RUN_AS_NODE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'REQUESTS_CA_BUNDLE'];
  const env: Record<string, string> = Object.fromEntries(keep.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]!]));
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = [...(process.env.ELECTRON_RUN_AS_NODE ? [NODE_SHIM] : []), ...pathDirs, ...(process.env[pathKey] ? [process.env[pathKey]!] : [])].join(delimiter);
  return { ...env, XDG_CACHE_HOME: CACHE, PUPPETEER_CACHE_DIR: join(CACHE, 'puppeteer'), PLAYWRIGHT_BROWSERS_PATH: join(CACHE, 'ms-playwright'), PYTHONDONTWRITEBYTECODE: '1' };
}
const plainEnv = (): NodeJS.ProcessEnv => programEnv();
// "node" for scripts that start it by name, on the desktop app (Electron's Node).
async function nodeShim() {
  if (!process.env.ELECTRON_RUN_AS_NODE) return;
  await mkdir(NODE_SHIM, { recursive: true });
  if (WIN) await writeFile(join(NODE_SHIM, 'node.cmd'), `@set ELECTRON_RUN_AS_NODE=1\r\n@"${process.execPath}" %*\r\n`);
  else {
    await writeFile(join(NODE_SHIM, 'node'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`);
    await chmod(join(NODE_SHIM, 'node'), 0o755);
  }
}

// Installs what a person approved (engineer.install_program): downloaded and
// checked against the approved checksum, unpacked into its own folder, its
// files recorded, tried once. A version already there is replaced only once
// the new one works.

export type InstallResult = Installed & { dropped?: string[] };
export function installProgram(spec: InstallSpec, by: string | null = null): Promise<InstallResult> {
  checkSpec(spec);
  return oneAtATime(() => installNow(spec, by));
}
async function installNow(spec: InstallSpec, by: string | null): Promise<InstallResult> {
  const m = await readManifest();
  await mkdir(ROOT, { recursive: true });
  if (spec.source.kind === 'pypi') return installPypi(spec, m, by);
  if (spec.source.kind === 'npm') return installNpm(spec, m, by);

  const src = spec.source;
  if (!spec.sha256 || !SHA.test(spec.sha256)) throw new Error('No checksum was approved for it.');
  const dirRel = `${spec.name}/${spec.version}`;
  const staging = join(ROOT, '.staging', `${spec.name}-${Date.now().toString(36)}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const file = join(staging, 'download');
    await download(src.url, file, spec.sha256);
    const unpacked = join(staging, 'files');
    await unpack(file, src.asset, unpacked, spec.bins[0]);
    const bins = await findBins(unpacked, spec.bins);
    const check = await tryIt(bins.get(spec.bins[0])!, spec.checkArgs ?? ['--version'], plainEnv());
    // Into place.
    const final = join(ROOT, dirRel);
    await rm(final, { recursive: true, force: true });
    await mkdir(dirname(final), { recursive: true });
    await moveInto(unpacked, final);
    const dirs = [...new Set([...bins.values()].map(f => relative(ROOT, join(final, relative(unpacked, dirname(f)))).split(sep).join('/')))];
    const entry: Installed = {
      name: spec.name,
      version: spec.version,
      source: src,
      sha256: spec.sha256,
      bins: spec.bins,
      pathDirs: dirs,
      dir: dirRel,
      files: await hashTree(final),
      installedAt: Date.now(),
      by,
      check,
    };
    // Python: its console commands' folder too (where pip puts them), made now so it's recorded.
    if (spec.name === 'python') {
      // Asked of the Python in its place (the one it was tried as has moved), and not
      // quietly skipped: without it, nothing pip installs would be found.
      const python = join(final, relative(unpacked, bins.get(spec.bins[0])!));
      const scripts = await scriptsDir(python).catch(e => {
        throw new Error(`Python installed, but didn't say where its packages' commands go: ${(e as Error).message.slice(0, 200)}`);
      });
      if (scripts) {
        await mkdir(scripts, { recursive: true }).catch(() => {});
        const rel = relative(ROOT, scripts).split(sep).join('/');
        if (!rel.startsWith('..') && !entry.pathDirs.includes(rel)) entry.pathDirs.push(rel);
      }
      // Python itself told to write no compiled files (a .pth runs at every start),
      // whatever environment a plugin starts it with: its files stay as checked.
      const site = await pythonPath(python, 'purelib');
      await mkdir(site, { recursive: true });
      await writeFile(join(site, 'zz_agency_no_bytecode.pth'), 'import sys; sys.dont_write_bytecode = True\n');
      await precompile(python, final);
      entry.files = await hashTree(final);
    }
    const old = m.programs[spec.name];
    m.programs[spec.name] = entry;
    // A new Python has none of the old one's packages: they're gone with it, and said so.
    const dropped = spec.name === 'python' && old ? Object.values(m.programs).filter(p => p.source.kind === 'pypi').map(p => p.name) : [];
    for (const d of dropped) {
      delete m.programs[d];
      verified.delete(d);
    }
    await writeManifest(m);
    if (old?.dir && old.dir !== dirRel) await rm(join(ROOT, old.dir), { recursive: true, force: true }).catch(() => {});
    verified.set(spec.name, true);
    await refreshPath();
    return dropped.length ? { ...entry, dropped } : entry;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function installPypi(spec: InstallSpec, m: Manifest, by: string | null): Promise<Installed> {
  const pkg = (spec.source as { package: string }).package;
  const python = m.programs.python;
  if (!python?.dir || verified.get('python') !== true) throw new Error('Python isn\'t installed (or changed since): install the program "python" first (engineer.install_program).');
  const pyExe = await locate(python.pathDirs.map(d => join(ROOT, d)), python.bins[0]);
  if (!pyExe) throw new Error('The Python program is missing: install the program "python" again.');
  const env = plainEnv();
  try {
    // --isolated: no pip.ini/pip.conf or PIP_ settings of this computer's - only pypi.org, as approved.
    await run(pyExe, ['-m', 'pip', 'install', '--isolated', '--index-url', 'https://pypi.org/simple', '--disable-pip-version-check', '--no-input', '--no-cache-dir', '--only-binary=:all:', `${pkg}==${spec.version}`], { timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env });
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    // pip may have left part of it: Python's record is taken again either way.
    await precompile(pyExe, join(ROOT, python.dir));
    python.files = await hashTree(join(ROOT, python.dir));
    await writeManifest(m);
    throw new Error(`pip couldn't install ${pkg} ${spec.version}: ${(err.stderr?.trim().split('\n').slice(-3).join(' ') || err.message).slice(0, 400)}`);
  }
  // Python's files now include the package (compiled, like the rest): recorded as approved.
  await precompile(pyExe, join(ROOT, python.dir));
  python.files = await hashTree(join(ROOT, python.dir));
  const scripts = python.pathDirs.map(d => join(ROOT, d));
  let check: string | null = null;
  if (spec.bins.length) {
    const binPath = await locate(scripts, spec.bins[0]);
    if (!binPath) throw new Error(`${pkg} installed, but it has no command "${spec.bins[0]}".`);
    check = await tryIt(binPath, spec.checkArgs ?? ['--version'], env);
  }
  const entry: Installed = { name: spec.name, version: spec.version, source: { kind: 'pypi', package: pkg }, sha256: null, bins: spec.bins, pathDirs: [], dir: null, files: {}, installedAt: Date.now(), by, check };
  m.programs[spec.name] = entry;
  await writeManifest(m);
  verified.set(spec.name, true);
  await refreshPath();
  return entry;
}

// npm itself: the one beside this computer's Node, else (the desktop app runs on
// Electron's Node, which has none) fetched once from the npm registry, checked
// against the fingerprint the registry publishes for it.
const NPM_VERSION = '11.21.2';
// Tests: as the desktop app, with no npm beside its Node.
let ownNpm = false;
export const useOwnNpm = (on: boolean) => void (ownNpm = on);
async function npmCli(): Promise<string> {
  const near = [join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  if (!ownNpm) for (const f of near) if (await stat(f).then(s => s.isFile()).catch(() => false)) return f;
  const dir = join(ROOT, '.npm-cli', NPM_VERSION);
  const cli = join(dir, 'package', 'bin', 'npm-cli.js');
  if (await stat(cli).then(s => s.isFile()).catch(() => false)) return cli;
  const rel = await npmRelease('npm', NPM_VERSION);
  const [algo, b64] = rel.integrity.split('-');
  if (algo !== 'sha512') throw new Error(`npm's download is fingerprinted with ${algo}, not sha512.`);
  const { res } = await fetcher(rel.tarball, { timeoutMs: 5 * 60_000 });
  if (!res.ok) throw new Error(`Downloading npm failed: ${res.status}.`);
  const body = Buffer.from(await res.arrayBuffer());
  if (createHash('sha512').update(body).digest('base64') !== b64) throw new Error("npm's download doesn't match the registry's fingerprint: nothing was installed.");
  const staging = join(ROOT, '.staging', `npm-${Date.now().toString(36)}`);
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(join(staging, 'npm.tgz'), body);
    await unpack(join(staging, 'npm.tgz'), 'npm.tgz', join(staging, 'files'), 'npm');
    await rm(dir, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    await moveInto(join(staging, 'files'), dir);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  return cli;
}

// Runs this agency's Node: the packaged desktop app's is Electron's, which needs to be told.
const nodeEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ ...plainEnv(), ...extra });

async function installNpm(spec: InstallSpec, m: Manifest, by: string | null): Promise<Installed> {
  const pkg = (spec.source as { package: string }).package;
  const dirRel = `${spec.name}/${spec.version}`;
  const staging = join(ROOT, '.staging', `${spec.name}-${Date.now().toString(36)}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    const cli = await npmCli();
    await nodeShim();
    // No .npmrc of this computer's (another registry, tokens): only registry.npmjs.org, as approved.
    // Two different files that don't exist (npm refuses one file loaded as both).
    const env = nodeEnv({ npm_config_cache: join(ROOT, '.npm-cache'), npm_config_userconfig: join(ROOT, '.npmrc-user-none'), npm_config_globalconfig: join(ROOT, '.npmrc-global-none'), npm_config_registry: 'https://registry.npmjs.org/', npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false' });
    await writeFile(join(staging, 'package.json'), '{ "private": true }\n');
    try {
      await run(process.execPath, [cli, 'install', `${pkg}@${spec.version}`, '--prefix', staging, '--registry=https://registry.npmjs.org/', '--omit=dev', '--no-audit', '--no-fund', '--save-exact'], { timeout: 15 * 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env });
    } catch (e) {
      const err = e as { stderr?: string; message: string };
      throw new Error(`npm couldn't install ${pkg} ${spec.version}: ${(err.stderr?.trim().split('\n').filter(l => /ERR/.test(l)).slice(-3).join(' ') || err.message).slice(0, 400)}`);
    }
    // Its commands, from its own package.json.
    const own = JSON.parse(await readFile(join(staging, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8')) as { bin?: string | Record<string, string> };
    const binMap: Record<string, string> = typeof own.bin === 'string' ? { [pkg.split('/').pop()!]: own.bin } : (own.bin ?? {});
    const wanted = spec.bins.length ? spec.bins : Object.keys(binMap);
    const missing = wanted.filter(b => !binMap[b]);
    if (missing.length) throw new Error(`${pkg} has no command ${missing.join(', ')}. Its commands: ${Object.keys(binMap).join(', ') || 'none'}.`);
    const final = join(ROOT, dirRel);
    const scripts = Object.fromEntries(wanted.map(b => [b, `${dirRel}/node_modules/${pkg}/${binMap[b].replace(/^\.\//, '')}`]));
    let check: string | null = null;
    if (wanted.length) check = await tryIt(process.execPath, [join(staging, 'node_modules', ...pkg.split('/'), binMap[wanted[0]]), ...(spec.checkArgs ?? ['--version'])], nodeEnv());
    await rm(final, { recursive: true, force: true });
    await mkdir(dirname(final), { recursive: true });
    await moveInto(staging, final);
    const entry: Installed = { name: spec.name, version: spec.version, source: { kind: 'npm', package: pkg }, sha256: null, bins: wanted, pathDirs: [], dir: dirRel, files: await hashTree(final), installedAt: Date.now(), by, check, scripts };
    const old = m.programs[spec.name];
    m.programs[spec.name] = entry;
    await writeManifest(m);
    if (old?.dir && old.dir !== dirRel) await rm(join(ROOT, old.dir), { recursive: true, force: true }).catch(() => {});
    verified.set(spec.name, true);
    await refreshPath();
    return entry;
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

async function locate(dirs: string[], bin: string): Promise<string | null> {
  for (const d of dirs)
    for (const name of WIN ? [`${bin}.exe`, bin] : [bin]) {
      const f = join(d, name);
      if (await stat(f).then(s => s.isFile()).catch(() => false)) return f;
    }
  return null;
}

// Gone from the PATH and the data folder.
export const removeProgram = (name: string) => oneAtATime(() => removeNow(name));
async function removeNow(name: string): Promise<boolean> {
  const m = await readManifest();
  const p = m.programs[name];
  if (!p) return false;
  delete m.programs[name];
  await writeManifest(m);
  if (p.dir) await rm(join(ROOT, p.dir), { recursive: true, force: true }).catch(() => {});
  verified.delete(name);
  await refreshPath();
  return true;
}

export const programsRoot = () => ROOT;

// Installs a person approved that haven't finished: kept on disk, so a restart
// (a redeploy mid-download) picks them back up instead of losing them.
const PENDING = join(ROOT, 'pending.json');
export type PendingInstall = { id: string; spec: InstallSpec; by: string | null; requestId: number | null; at: number };
export async function pendingInstalls(): Promise<PendingInstall[]> {
  return JSON.parse(await readFile(PENDING, 'utf8').catch(() => '[]')) as PendingInstall[];
}
let pendingWrites: Promise<unknown> = Promise.resolve();
const editPending = (fn: (l: PendingInstall[]) => PendingInstall[]) =>
  (pendingWrites = pendingWrites.catch(() => {}).then(async () => {
    await mkdir(ROOT, { recursive: true });
    const next = fn(await pendingInstalls());
    await writeFile(`${PENDING}.tmp`, JSON.stringify(next, null, 2));
    await rename(`${PENDING}.tmp`, PENDING);
  }));
export const addPending = (p: PendingInstall) => editPending(l => [...l.filter(x => x.id !== p.id), p]);
export const dropPending = (id: string) => editPending(l => l.filter(x => x.id !== id));
// Half-done downloads from before a restart.
export const clearStaging = () => rm(join(ROOT, '.staging'), { recursive: true, force: true }).catch(() => {});
