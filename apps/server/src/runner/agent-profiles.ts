import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from '../paths.js';
import { addManagedProfile, browserConn, connectPageUrl, linkLoaded, linkReady, managedProfile, managedProfiles, numberHolder, onBrowserOnline, pairCode, setReservedNumbers, takenNumbers } from './browser-link.js';
import { moveProfilePasswords } from './passwords.js';

// Agents' profiles (docs/browser-extension.md, "Agent profiles"): browser profile
// folders the app owns, <data>/browser-profiles/<n>, which it opens itself as normal
// browsers - Edge or Chromium with the EXTREMELY extension loaded from the app - so
// agents never wait for a person to open one. Browser number n is folder n's (the
// password store is keyed by it), and the extension in it pairs itself into that
// number from the connect page the browser starts on.
//
// Never with a DevTools port: Google refuses every sign-in in a browser started with
// --remote-debugging-port. The browser is started like any other, detached, and stays
// open when the app quits, with whatever pages it has for the person.
//
// Branded Chrome (137 and later) ignores --load-extension, so it can't be one; with only
// Chrome on the computer the person pairs a browser themselves (Connect a browser).

export const PROFILES_DIR = join(DATA_DIR, 'browser-profiles');
export const profileName = (n: number) => `Agents' profile ${n}`;
// Waiting for a browser it started to come online. A first start of Edge (and its
// extension) on Windows can take 20 s.
const OPEN_MS = 40_000;
// A paired profile's extension says hello by itself; if it hasn't by then, its token
// may be gone (the extension's storage cleared), so the connect page pairs it again.
const PAIRED_WAIT_MS = 20_000;
// After a failed open: not tried again for this long (a person's Open button still can).
const BACKOFF_MS = 10 * 60_000;

const log = (...a: unknown[]) => console.log('[agent-profiles]', ...a);
const logError = (...a: unknown[]) => console.error('[agent-profiles]', ...a);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- Tests change these (agent-profiles.test.ts, agent-profiles-e2e.test.ts) --------------

type Spawn = (exe: string, args: string[], opts: SpawnOptions) => ChildProcess;
let spawnFn: Spawn = nodeSpawn;
let testExe: ProfileBrowser | null = null;
let extraArgs: string[] = [];
let openMs = OPEN_MS;
let pairedWaitMs = PAIRED_WAIT_MS;
export const _testing = {
  setSpawn: (fn: Spawn) => void (spawnFn = fn),
  setBrowser: (b: ProfileBrowser | null) => void (testExe = b),
  setExtraArgs: (args: string[]) => void (extraArgs = args),
  setWaits: (open: number, paired: number) => void ((openMs = open), (pairedWaitMs = paired)),
  reset: () => void (failed.clear(), opening.clear()),
};

// --- Which browser opens them ---------------------------------------------------------------

export type ProfileBrowser = { exe: string; kind: 'edge' | 'chromium' };

const programFiles = () => [process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.ProgramFiles ?? 'C:\\Program Files', process.env.LOCALAPPDATA ?? ''].filter(Boolean);
function edgePaths(): string[] {
  if (process.platform === 'win32') return programFiles().map(p => join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  if (process.platform === 'darwin') return ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge'];
}
function chromiumPaths(): string[] {
  if (process.platform === 'win32') return [join(process.env.LOCALAPPDATA ?? '', 'Chromium', 'Application', 'chrome.exe'), ...programFiles().map(p => join(p, 'Chromium', 'Application', 'chrome.exe'))];
  if (process.platform === 'darwin') return ['/Applications/Chromium.app/Contents/MacOS/Chromium'];
  return ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
}
function chromePaths(): string[] {
  if (process.platform === 'win32') return programFiles().map(p => join(p, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  if (process.platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
}

// The Edge or Chromium that opens agents' profiles, or why there's none. EAA_PROFILE_BROWSER
// names one outright (a Chromium somewhere else).
export function profileBrowser(): { found: ProfileBrowser } | { none: string } {
  if (process.env.NODE_TEST_CONTEXT) return testExe ? { found: testExe } : { none: 'No browser in tests.' };
  const named = process.env.EAA_PROFILE_BROWSER?.trim();
  if (named && existsSync(named)) return { found: { exe: named, kind: /edge/i.test(named) ? 'edge' : 'chromium' } };
  const edge = edgePaths().find(p => existsSync(p));
  if (edge) return { found: { exe: edge, kind: 'edge' } };
  const chromium = chromiumPaths().find(p => existsSync(p));
  if (chromium) return { found: { exe: chromium, kind: 'chromium' } };
  if (chromePaths().some(p => existsSync(p)))
    return { none: "Only Google Chrome is on this computer, and Chrome doesn't load the EXTREMELY extension into the agents' own profiles. Install Microsoft Edge for those, or connect your Chrome (Connect a browser)." };
  return { none: 'There is no Microsoft Edge or Chromium on this computer to open the agents\' own profiles in.' };
}

// The extension the profiles load: the copy the installer ships (EAA_EXTENSION_DIR, set
// by the desktop app), else apps/person-chrome beside this source in development.
export function extensionDir(): string | null {
  const dir = process.env.EAA_EXTENSION_DIR?.trim() || resolve(dirname(fileURLToPath(import.meta.url)), '../../../person-chrome');
  return existsSync(join(dir, 'manifest.json')) ? dir : null;
}

// Whether the app can open profiles here at all, and if not why (for the UI and agents).
export function profilesAvailable(): { ok: true; kind: ProfileBrowser['kind'] } | { ok: false; why: string } {
  const b = profileBrowser();
  if ('none' in b) return { ok: false, why: b.none };
  if (!extensionDir()) return { ok: false, why: "The EXTREMELY extension isn't with the app (reinstall it), so the agents' own profiles can't open." };
  return { ok: true, kind: b.found.kind };
}

// --- The folders ------------------------------------------------------------------------------

const looksLikeProfile = (dir: string) => existsSync(join(dir, 'Local State')) || existsSync(join(dir, 'Default'));
function numberedFolders(): string[] {
  try {
    return readdirSync(PROFILES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
      .map(d => d.name)
      .sort((a, b) => Number(a) - Number(b));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') logError('could not list the profile folders:', errText(e));
    return [];
  }
}
const adoptedFolders = () => new Set(managedProfiles().map(m => m.dir));
// Profile folders no browser number points at yet: their number is theirs (setReservedNumbers).
const unnumbered = () => {
  const adopted = adoptedFolders();
  return numberedFolders().filter(f => !adopted.has(f) && looksLikeProfile(join(PROFILES_DIR, f)));
};
setReservedNumbers(() => unnumbered().map(Number));

// The next number for a new agents' profile: free in the link, and no folder by that
// name already (one with nothing of a profile in it, that no browser points at, is reused).
function nextNumber(): number {
  const taken = takenNumbers();
  const adopted = adoptedFolders();
  const reserved = new Set(unnumbered().map(Number));
  for (let n = 1; ; n++) {
    if (taken.has(n) || reserved.has(n) || adopted.has(String(n))) continue;
    const dir = join(PROFILES_DIR, String(n));
    if (!existsSync(dir) || !looksLikeProfile(dir)) return n;
  }
}

export const profileDir = (n: number): string | null => {
  const m = managedProfile(n);
  return m ? join(PROFILES_DIR, m.dir) : null;
};

// Folders from before (when the app ran its own browsers on them, with a debug port)
// become agents' profiles: folder n is browser n. If a person's browser was paired as n
// first, the folder takes the next free number and its accounts in the password store
// (the ones made before that pairing) go with it, so numbers and accounts stay matched.
export async function adoptProfileFolders(): Promise<{ adopted: number[]; renumbered: { folder: string; n: number; passwords: number }[] }> {
  await linkReady();
  const out = { adopted: [] as number[], renumbered: [] as { folder: string; n: number; passwords: number }[] };
  for (const folder of unnumbered()) {
    const k = Number(folder);
    const holder = numberHolder(k);
    const n = holder ? nextNumber() : k;
    const kind = (() => {
      const b = profileBrowser();
      return 'found' in b && b.found.kind === 'chromium' ? 'chrome' : 'edge';
    })();
    await addManagedProfile({ n, dir: folder, name: profileName(n), kind }).catch(e => logError(`could not save browser ${n} for folder ${folder}:`, errText(e)));
    if (!holder) {
      out.adopted.push(n);
      log(`profile folder ${folder} is the agents' profile ${n}`);
      continue;
    }
    // Only a person's browser has accounts of its own under k: an agents' profile with
    // another folder (which shouldn't happen) keeps them.
    const passwords = holder.managed ? 0 : moveProfilePasswords(k, n, holder.created);
    out.renumbered.push({ folder, n, passwords });
    log(`profile folder ${folder} is the agents' profile ${n}: browser ${k} is ${holder.managed ? 'another agents\' profile' : "a person's browser"}${passwords ? `; ${passwords} saved account(s) moved from browser ${k} to ${n}` : ''}`);
  }
  return out;
}

// A new agents' profile: its number taken at once (two callers get two), its folder made.
export function createProfile(): number {
  if (!linkLoaded()) throw new Error('The agency is still starting. Try again in a moment.');
  const can = profilesAvailable();
  if (!can.ok) throw new Error(can.why);
  const n = nextNumber();
  mkdirSync(join(PROFILES_DIR, String(n)), { recursive: true });
  void addManagedProfile({ n, dir: String(n), name: profileName(n), kind: can.kind === 'chromium' ? 'chrome' : 'edge' }).catch(e => logError(`could not save browser ${n}:`, errText(e)));
  log(`made the agents' profile ${n}`);
  return n;
}

// --- Is its browser running? --------------------------------------------------------------------

const children = new Map<number, ChildProcess>(); // the browsers started this time, by number

// On Windows a running browser holds <dir>/lockfile open (it can't be deleted); one that
// crashed leaves nothing, or a file that deletes. Elsewhere SingletonLock is a link to
// "<host>-<pid>": a lock from another machine (a container started again) or a process
// that's gone is stale, and left there the browser would refuse the folder.
export async function profileRunning(dir: string): Promise<boolean> {
  if (process.platform === 'win32') {
    const lock = join(dir, 'lockfile');
    if (!existsSync(lock)) return false;
    try {
      await rm(lock);
      log(`cleared a stale lock in ${dir}`);
      return false;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
      if (code !== 'EPERM' && code !== 'EBUSY') logError(`could not check the lock in ${dir} (${code}); taken as running`);
      return true;
    }
  }
  const link = await readlink(join(dir, 'SingletonLock')).catch(() => null);
  if (!link) return false;
  const at = link.lastIndexOf('-');
  const [host, pid] = [link.slice(0, at), Number(link.slice(at + 1))];
  let alive = host === hostname() && pid > 0;
  if (alive)
    try {
      process.kill(pid, 0);
    } catch (e) {
      alive = (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  if (alive) return true;
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) await rm(join(dir, f), { force: true });
  log(`cleared a stale lock in ${dir} (from ${host}, pid ${pid})`);
  return false;
}

// Before a start: it opens without "restore pages?" after a crash, and never offers to
// save passwords (the password store does that). Only a file it can read is changed: a
// profile's settings are never replaced with a blank set.
async function tidyPreferences(dir: string) {
  const file = join(dir, 'Default', 'Preferences');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') logError(`could not read ${file}:`, errText(e));
    return; // a new profile: the browser makes its own
  }
  let prefs: Record<string, any>;
  try {
    prefs = JSON.parse(text);
  } catch {
    logError(`${file} isn't JSON; left as it is`);
    return;
  }
  prefs.profile = { ...(prefs.profile ?? {}), exit_type: 'Normal', exited_cleanly: true, password_manager_enabled: false };
  prefs.credentials_enable_service = false;
  await writeFile(file, JSON.stringify(prefs)).catch(e => logError(`could not write ${file}:`, errText(e)));
}

// Behind the person's windows, an agent's tab mustn't slow down like a hidden one.
const FLAGS = ['--no-first-run', '--no-default-browser-check', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

export function launchArgs(dir: string, ext: string, url?: string): string[] {
  const args = [`--user-data-dir=${dir}`, `--load-extension=${ext}`, ...FLAGS, ...extraArgs, ...(url ? [url] : [])];
  if (args.some(a => /remote-debugging/i.test(a))) throw new Error("An agents' profile never opens with a debugging port (Google refuses sign-in there).");
  return args;
}

function start(n: number, exe: string, dir: string, ext: string, url?: string): ChildProcess {
  // Its own process (group): not ended with the app, like a browser the person opened.
  const proc = spawnFn(exe, launchArgs(dir, ext, url), { detached: true, stdio: 'ignore', windowsHide: false });
  proc.unref?.();
  children.set(n, proc);
  proc.on('error', e => logError(`browser ${n} failed to start:`, e.message));
  proc.on('exit', (code, signal) => {
    if (children.get(n) === proc) children.delete(n);
    if (code) logError(`browser ${n} exited (code ${code}${signal ? `, ${signal}` : ''})`);
    else log(`browser ${n} exited${signal ? ` (${signal})` : ''}`);
  });
  log(`opened browser ${n} (pid ${proc.pid ?? '?'})${url ? ' on its connect page' : ''}`);
  return proc;
}
const alive = (p?: ChildProcess) => !!p && p.exitCode === null && p.signalCode === null;

// --- Opening one, and waiting for it to come online -------------------------------------------

// Whether a browser is online, and news of one coming online. The link by default;
// browser.ts sets its own (its tests stand in for the link).
type OnlineSource = { isOnline: (n: number) => boolean; subscribe: (fn: (n: number) => void) => () => void };
let source: OnlineSource = { isOnline: n => !!browserConn(n), subscribe: fn => onBrowserOnline(n => fn(n)) };
export const setOnlineSource = (s: OnlineSource) => void (source = s);

function waitOnline(n: number, ms: number, failedEarly?: Promise<Error>): Promise<boolean> {
  if (source.isOnline(n)) return Promise.resolve(true);
  return new Promise((done, fail) => {
    let off = () => {};
    const timer = setTimeout(() => (off(), done(false)), Math.max(0, ms));
    off = source.subscribe(m => {
      if (m !== n) return;
      clearTimeout(timer);
      off();
      done(true);
    });
    void failedEarly?.then(e => (clearTimeout(timer), off(), fail(e)));
  });
}

const opening = new Map<number, Promise<void>>();
const failed = new Map<number, { at: number; error: string }>();

// Why a profile can't be opened right now, or null when it can (sync: for choosing a browser).
export function cantOpen(n: number): string | null {
  const m = managedProfile(n);
  if (!m) return `Browser ${n} isn't one of the agents' profiles.`;
  if (!existsSync(join(PROFILES_DIR, m.dir))) return `The folder of the agents' profile ${n} is gone from this computer.`;
  const can = profilesAvailable();
  if (!can.ok) return can.why;
  const f = failed.get(n);
  if (f && Date.now() - f.at < BACKOFF_MS) return f.error;
  return null;
}
export const failedRecently = (n: number) => {
  const f = failed.get(n);
  return f && Date.now() - f.at < BACKOFF_MS ? f.error : null;
};

// Opens agents' profile n and resolves once it's online; two callers share one opening.
// After one that failed, the same error for BACKOFF_MS without trying (force: a person
// pressed Open, so it's tried again).
export function openProfile(n: number, o: { force?: boolean } = {}): Promise<void> {
  if (source.isOnline(n)) return Promise.resolve();
  let p = opening.get(n);
  if (p) return p;
  const recent = failedRecently(n);
  if (recent && !o.force) return Promise.reject(new Error(recent));
  p = openNow(n).then(
    () => void failed.delete(n),
    e => {
      failed.set(n, { at: Date.now(), error: errText(e) });
      throw e;
    },
  );
  const mine = p;
  opening.set(n, mine);
  void mine.finally(() => opening.get(n) === mine && opening.delete(n)).catch(() => {});
  return mine;
}

async function openNow(n: number): Promise<void> {
  const m = managedProfile(n);
  if (!m) throw new Error(`Browser ${n} isn't one of the agents' profiles.`);
  const dir = join(PROFILES_DIR, m.dir);
  if (!existsSync(dir)) throw new Error(`The folder of the agents' profile ${n} is gone from this computer.`);
  const b = profileBrowser();
  if ('none' in b) throw new Error(b.none);
  const ext = extensionDir();
  if (!ext) throw new Error("The EXTREMELY extension isn't with the app (reinstall it), so the agents' own profiles can't open.");
  const { exe, kind } = b.found;
  const name = kind === 'edge' ? 'Edge' : 'Chromium';
  const deadline = Date.now() + openMs;
  const connectUrl = () => connectPageUrl(pairCode({ browser: n, local: true }).link);

  const running = alive(children.get(n)) || (await profileRunning(dir));
  let paired = m.paired;
  let proc: ChildProcess | undefined;
  if (!running) {
    await tidyPreferences(dir);
    proc = start(n, exe, dir, ext, paired ? undefined : connectUrl());
  } else if (!paired) {
    // Already open but not paired: the connect page goes to that browser (a second
    // start on the same folder hands its address over and quits).
    start(n, exe, dir, ext, connectUrl());
  } else log(`browser ${n} is already running; waiting for its extension`);
  // A browser that couldn't start at all (a missing or broken program) says so at once.
  const failedEarly = proc ? new Promise<Error>(r => proc!.once('error', e => r(new Error(`${name} couldn't start: ${e.message}`)))) : undefined;

  if (await waitOnline(n, Math.min(paired ? pairedWaitMs : openMs, deadline - Date.now()), failedEarly)) return;
  if (paired && Date.now() < deadline) {
    // Its pairing may be gone from the extension: the connect page pairs it again.
    log(`browser ${n} didn't say hello in ${Math.round(pairedWaitMs / 1000)} s; pairing it again`);
    paired = false;
    start(n, exe, dir, ext, connectUrl());
    if (await waitOnline(n, deadline - Date.now(), failedEarly)) return;
  }
  const exited = proc && !alive(proc) ? ` ${name} closed again (code ${proc.exitCode ?? proc.signalCode}).` : '';
  throw new Error(
    `The agents' profile ${n} opened in ${name}, but the EXTREMELY extension in it didn't connect within ${Math.round(openMs / 1000)} s.${exited} ${name} may not allow the app to load the extension (a work computer's policy, or a newer ${name} that blocks it). Press Open in Settings > Connectors > Browser to try again, or Connect a browser to pair one yourself.`,
  );
}

// At start: the folders from before, numbered (after the link has read its list).
if (!process.env.NODE_TEST_CONTEXT) void adoptProfileFolders().catch(e => logError('numbering the profile folders failed:', errText(e)));
