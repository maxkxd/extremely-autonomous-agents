import { lstat, readdir, readlink, rm, stat, statfs } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { programsRoot } from '../integrations/programs.js';
import { DATA_DIR } from '../paths.js';
import { cleanUpBrowsers } from './browser.js';

// The disk the agency keeps filling with things it can make again. On the cloud
// host the volume reached 86%: programs' download caches, each agents' browser's
// disk caches, and the old copies a move left beside the agency. Cleared at
// start, once a day, and whenever the volume is 80% full (checked every 10
// minutes, at most once an hour), and only these - never a sign-in or cookie, the
// database, the vault, an installed program, or a plugin's output:
//
//   <data>/programs/.npm-cache and /.cache   npm's and the programs' caches (programs.ts programEnv)
//   <data>/browser-profiles/<n>/             Cache, Code Cache, GPUCache, Service Worker/CacheStorage and the
//                                            shader caches (Dawn, Gr, Shader), and Chrome's component_crx_cache,
//                                            in the profile's folder and in its Default
//   <data's folder>/<data>.replaced-*        a replaced agency's folder, once it's a few days old
//   <tmp>/eaa-upload-* and <tmp>/eaa-run-*   a run's uploaded file and its scratch folder, once two days old
//
// A profile whose browser is open is left alone (its caches are in use): each
// sweep closes the browsers no run is using first, the way host.clean_up does,
// and the start-up sweep runs before any has opened.

const DAY = 86_400_000;
const HOUR = 3_600_000;
export const REPLACED_AFTER_DAYS = 3;
export const TEMP_AFTER_DAYS = 2;
export const FULL_AT = 0.8; // the volume's share in use that starts a sweep between the daily ones
export const FULL_CHECK_MS = 10 * 60_000;
export const FULL_SWEEP_EVERY_MS = HOUR;
const PROFILE_CACHES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  join('Service Worker', 'CacheStorage'),
  'DawnCache',
  'GraphiteDawnCache',
  'GrShaderCache',
  'ShaderCache',
  'component_crx_cache',
];
const TEMP_FOLDERS = /^eaa-(upload|run)-/;

async function bytesIn(path: string): Promise<number> {
  const s = await lstat(path).catch(() => null);
  if (!s) return 0;
  // A link counts as itself: removing it never touches what it points at.
  if (!s.isDirectory()) return s.size;
  let total = 0;
  for (const name of await readdir(path).catch(() => [] as string[])) total += await bytesIn(join(path, name));
  return total;
}

// Removes a file or folder, and says how many bytes that freed (0 when it wasn't there or couldn't go).
async function clear(path: string): Promise<number> {
  if (!(await lstat(path).catch(() => null))) return 0;
  const bytes = await bytesIn(path);
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch (e) {
    console.error(`[sweep] Couldn't clear ${basename(path)}: ${(e as Error).message}`);
    return 0;
  }
  return bytes;
}

// Whether a browser has the profile open. Chrome on Linux (and macOS) locks a profile with a link
// naming the machine and process that has it (browser.ts clearStaleLock): one from another machine,
// or from a process that's gone, is nobody's. Windows has no such link: left alone.
export async function profileInUse(dir: string): Promise<boolean> {
  if (process.platform === 'win32') return true;
  const lock = await readlink(join(dir, 'SingletonLock')).catch(() => null);
  if (!lock) return false;
  const at = lock.lastIndexOf('-');
  if (lock.slice(0, at) !== hostname()) return false;
  try {
    process.kill(Number(lock.slice(at + 1)), 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type SweepResult = { freed: number; programs: number; browsers: number; replaced: number; keptOpen: number[] };

export async function sweepDisk(o: { dataDir: string; programsDir: string; now?: number; inUse?: (profileDir: string) => Promise<boolean> }): Promise<SweepResult> {
  const now = o.now ?? Date.now();
  const inUse = o.inUse ?? profileInUse;
  const r: SweepResult = { freed: 0, programs: 0, browsers: 0, replaced: 0, keptOpen: [] };

  for (const name of ['.npm-cache', '.cache']) r.programs += await clear(join(o.programsDir, name));

  const profiles = join(o.dataDir, 'browser-profiles');
  for (const e of await readdir(profiles, { withFileTypes: true }).catch(() => [])) {
    // The agents' profiles are the numbered folders (a person's sign-in window has its own).
    if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue;
    const dir = join(profiles, e.name);
    if (await inUse(dir)) {
      r.keptOpen.push(Number(e.name));
      continue;
    }
    for (const root of [dir, join(dir, 'Default')]) for (const cache of PROFILE_CACHES) r.browsers += await clear(join(root, cache));
  }

  // A folder's change time moves when it is renamed, which its modified time doesn't: the later of the two
  // is when it was set aside, or last touched.
  const parent = dirname(o.dataDir);
  const prefix = `${basename(o.dataDir)}.replaced-`;
  for (const e of await readdir(parent, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !e.name.startsWith(prefix)) continue;
    const full = join(parent, e.name);
    const s = await stat(full).catch(() => null);
    if (!s || now - Math.max(s.mtimeMs, s.ctimeMs) < REPLACED_AFTER_DAYS * DAY) continue;
    r.replaced += await clear(full);
  }

  r.freed = r.programs + r.browsers + r.replaced;
  return r;
}

// The temporary folders a run leaves in the system's temp folder (an uploaded file, a Claude Code
// scratch folder): only those two kinds by name, and only once TEMP_AFTER_DAYS old. Returns the bytes freed.
export async function sweepTemp(o: { tmpDir?: string; now?: number } = {}): Promise<number> {
  const dir = o.tmpDir ?? tmpdir();
  const now = o.now ?? Date.now();
  let freed = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!e.isDirectory() || !TEMP_FOLDERS.test(e.name)) continue;
    const full = join(dir, e.name);
    const s = await stat(full).catch(() => null);
    if (!s || now - s.mtimeMs < TEMP_AFTER_DAYS * DAY) continue;
    freed += await clear(full);
  }
  return freed;
}

type Statfs = (path: string) => Promise<{ blocks: number; bfree: number; bavail: number }>;

// How full the volume holding `path` is, the way df shows it (null when it can't be read).
export async function diskFraction(path: string, read: Statfs = p => statfs(p)): Promise<number | null> {
  try {
    const s = await read(path);
    const used = s.blocks - s.bfree;
    const total = used + s.bavail;
    return total > 0 ? used / total : null;
  } catch {
    return null;
  }
}

// A sweep between the daily ones: the volume is FULL_AT or more full, and none has run in the last hour.
export const sweepDue = (fraction: number | null, lastSweepAt: number, now: number) => fraction != null && fraction >= FULL_AT && now - lastSweepAt >= FULL_SWEEP_EVERY_MS;

const size = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`);
let lastSweepAt = 0;

async function sweepAndLog(when: string) {
  lastSweepAt = Date.now();
  const r = await sweepDisk({ dataDir: DATA_DIR, programsDir: programsRoot() });
  const temp = await sweepTemp();
  console.log(
    `[sweep] ${when}: freed ${size(r.freed + temp)} (programs' caches ${size(r.programs)}, browsers' caches ${size(r.browsers)}, old agency copies ${size(r.replaced)}, temporary folders ${size(temp)})${r.keptOpen.length ? `; left alone, browser open: profile${r.keptOpen.length === 1 ? '' : 's'} ${r.keptOpen.join(', ')}` : ''}.`,
  );
}

const FIRST_SWEEP_MS = 60_000; // not while the agency is still starting
let started = false;
export function startDiskSweep() {
  if (started) return;
  started = true;
  const failed = (e: unknown) => console.error('[sweep] Clearing caches failed:', (e as Error).message);
  setTimeout(() => void sweepAndLog('At start').catch(failed), FIRST_SWEEP_MS).unref();
  setInterval(
    () =>
      void (async () => {
        // The agents' browsers stay open for weeks, with their caches: the ones no run is using are closed first.
        await cleanUpBrowsers().catch(() => {});
        await sweepAndLog('Daily');
      })().catch(failed),
    DAY,
  ).unref();
  // Between the daily sweeps: the volume went from nothing to 86% in a day, so a full one doesn't wait.
  setInterval(
    () =>
      void (async () => {
        const before = await diskFraction(DATA_DIR);
        if (!sweepDue(before, lastSweepAt, Date.now())) return;
        await cleanUpBrowsers().catch(() => {});
        await sweepAndLog(`Volume ${Math.round(before! * 100)}% full`);
        const after = await diskFraction(DATA_DIR);
        // Nothing left to clear: what fills it now is data (the database, plugins' output, sign-ins). Said as an error so host.health shows it.
        if (after != null && after >= 0.9) console.error(`[sweep] The volume is still ${Math.round(after * 100)}% full after clearing the caches: what is left is data the sweep never touches.`);
      })().catch(failed),
    FULL_CHECK_MS,
  ).unref();
}
