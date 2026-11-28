import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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
let runningFn: ((dir: string) => Promise<boolean>) | null = null;
export const _testing = {
  setSpawn: (fn: Spawn) => void (spawnFn = fn),
  setBrowser: (b: ProfileBrowser | null) => void (testExe = b),
  setExtraArgs: (args: string[]) => void (extraArgs = args),
  setWaits: (open: number, paired: number) => void ((openMs = open), (pairedWaitMs = paired)),
  setCloser: (fn: (dir: string) => Promise<boolean>) => void (closeFn = fn),
  close: (dir: string, force = false) => closeBrowserIn(dir, undefined, force),
  setRunning: (fn: ((dir: string) => Promise<boolean>) | null) => void (runningFn = fn),
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
  const shipped = bundledBrowser();
  if (shipped) return { found: shipped };
  const edge = edgePaths().find(p => existsSync(p));
  if (edge) return { found: { exe: edge, kind: 'edge' } };
  const chromium = chromiumPaths().find(p => existsSync(p));
  if (chromium) return { found: { exe: chromium, kind: 'chromium' } };
  if (chromePaths().some(p => existsSync(p)))
    return { none: "Only Google Chrome is on this computer, and Chrome doesn't load the EXTREMELY extension into the agents' own profiles. Install Microsoft Edge for those, or connect your Chrome (Connect a browser)." };
  return { none: 'There is no Microsoft Edge or Chromium on this computer to open the agents\' own profiles in.' };
}

// The browser shipped with the app (EAA_BROWSER_DIR, set by the desktop app; made by
// apps/electron/scripts/stage-browser.cjs): Chrome for Testing, which still loads an
// extension given on the command line, where branded Chrome (137+) and Edge stop.
// The same on every computer, whichever browser the person uses.
export function bundledBrowser(dir = process.env.EAA_BROWSER_DIR?.trim()): ProfileBrowser | null {
  if (!dir) return null;
  try {
    const info = JSON.parse(readFileSync(join(dir, 'BROWSER.json'), 'utf8')) as { exe?: unknown };
    const exe = typeof info.exe === 'string' ? join(dir, info.exe) : '';
    return exe && existsSync(exe) ? { exe, kind: 'chromium' } : null;
  } catch {
    return null; // none shipped for this computer (NONE.txt), or a development build
  }
}

// A profile folder Edge made opens in Edge again while Edge is here: its sign-ins
// are sealed with Edge's own keys, so another browser would find it signed out.
// Every new profile opens in profileBrowser() (the shipped browser first).
export function madeByEdge(dir: string): boolean {
  try {
    return 'edge' in (JSON.parse(readFileSync(join(dir, 'Local State'), 'utf8')) as object);
  } catch {
    return false;
  }
}

// Chromium's sandbox runs its network service as an app container, which reads the
// browser's own folder as "ALL APPLICATION PACKAGES". Program Files lets it; a per-user
// install folder doesn't, and then the network service crashes over and over and the
// extension never connects. Chrome's own installer grants it; so does this, for the
// shipped browser, once each time the app starts (refused in Program Files without
// admin rights, where it's already allowed).
const sandboxReadable = new Set<string>();
async function letSandboxRead(exe: string) {
  const shipped = process.env.EAA_BROWSER_DIR?.trim();
  if (process.platform !== 'win32' || process.env.NODE_TEST_CONTEXT || !shipped || sandboxReadable.has(shipped) || !resolve(exe).startsWith(resolve(shipped))) return;
  sandboxReadable.add(shipped);
  await new Promise<void>(done => {
    const p = nodeSpawn('icacls', [shipped, '/grant', '*S-1-15-2-1:(OI)(CI)(RX)', '*S-1-15-2-2:(OI)(CI)(RX)', '/T', '/C', '/Q'], { stdio: 'ignore', windowsHide: true });
    p.on('error', e => (logError('could not let the browser sandbox read its folder:', e.message), done()));
    p.on('exit', () => done());
  });
}

function browserFor(dir: string): { found: ProfileBrowser } | { none: string } {
  if (!process.env.NODE_TEST_CONTEXT && madeByEdge(dir)) {
    const edge = edgePaths().find(p => existsSync(p));
    if (edge) return { found: { exe: edge, kind: 'edge' } };
  }
  return profileBrowser();
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

// Edge 158 (like Chrome before it) switches off an extension loaded with
// --load-extension and remembers it as off ("unsupported developer extension"):
// the extension never runs, and the profile only shows "Not connected". FLAGS stop
// that happening again; a profile it already happened to still has the record,
// which is dropped here so the extension loads as new. Only the record of an
// extension from the command line goes: its files and storage (its pairing) stay.
const COMMAND_LINE = 8; // Chromium's ManifestLocation::kCommandLine
const UNSUPPORTED_DEVELOPER_EXTENSION = 1 << 24; // Chromium's disable_reason.h
const offAsDeveloper = (reasons: unknown) =>
  (Array.isArray(reasons) ? reasons : [reasons]).some(r => (Number(r) & UNSUPPORTED_DEVELOPER_EXTENSION) !== 0);

async function securePrefs(dir: string): Promise<{ file: string; prefs: Record<string, any>; off: string[] } | null> {
  const file = join(dir, 'Default', 'Secure Preferences');
  let prefs: Record<string, any>;
  try {
    prefs = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null; // none yet, or unreadable: left to the browser
  }
  const settings: Record<string, any> = prefs.extensions?.settings ?? {};
  return { file, prefs, off: Object.keys(settings).filter(id => settings[id]?.location === COMMAND_LINE && offAsDeveloper(settings[id]?.disable_reasons)) };
}

// Whether the browser has the extension switched off (read while it runs: it writes this at once).
export async function extensionSwitchedOff(dir: string): Promise<boolean> {
  return !!(await securePrefs(dir))?.off.length;
}

export async function forgetDisabledExtension(dir: string) {
  const got = await securePrefs(dir);
  if (!got?.off.length) return;
  const { file, prefs, off } = got;
  const settings: Record<string, any> = prefs.extensions.settings;
  for (const id of off) {
    delete settings[id];
    delete prefs.protection?.macs?.extensions?.settings?.[id];
  }
  await writeFile(file, JSON.stringify(prefs)).then(
    () => log(`${dir}: the browser had switched the extension off; it loads again`),
    e => logError(`could not write ${file}:`, errText(e)),
  );
}

// Behind the person's windows, an agent's tab mustn't slow down like a hidden one.
// And the extension given on the command line stays on: newer Edge and Chrome turn
// it off unless these features are disabled (forgetDisabledExtension).
const FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--disable-features=DisableLoadExtensionCommandLineSwitch,ExtensionDisableUnsupportedDeveloper,ExtensionsDisableUnsupportedDeveloperExtensions',
];

export function launchArgs(dir: string, ext: string, url?: string): string[] {
  const args = [`--user-data-dir=${dir}`, `--load-extension=${ext}`, ...FLAGS, ...extraArgs, ...(url ? [url] : [])];
  if (args.some(a => /remote-debugging/i.test(a))) throw new Error("An agents' profile never opens with a debugging port (Google refuses sign-in there).");
  return args;
}

function start(n: number, exe: string, dir: string, ext: string, url?: string): ChildProcess {
  // Its own process (group): not ended with the app, like a browser the person opened.
  // A Chromium without Google's API keys says so on a bar in every window; "no" keeps it quiet.
  const env = { ...process.env, GOOGLE_API_KEY: 'no', GOOGLE_DEFAULT_CLIENT_ID: 'no', GOOGLE_DEFAULT_CLIENT_SECRET: 'no' };
  const proc = spawnFn(exe, launchArgs(dir, ext, url), { detached: true, stdio: 'ignore', windowsHide: false, env });
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

// --- Closing one that's open with the extension switched off ------------------------------------

// A browser left open by an earlier version of the app (or Edge before FLAGS) can have
// the extension switched off: its connect page only ever says "Not connected", and
// opening it again would just add another. It's closed (asked first, as a person
// closing it would; forced after CLOSE_MS) and opened again with the extension on.
const CLOSE_MS = 15_000;
const runQuiet = (exe: string, args: string[]) =>
  new Promise<string>(done => {
    let out = '';
    const p = nodeSpawn(exe, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    p.stdout?.on('data', d => (out += d));
    p.on('error', () => done(''));
    p.on('exit', () => done(out));
  });

// The browser processes (not their helpers) running on this folder.
async function browserPids(dir: string, child?: ChildProcess): Promise<number[]> {
  const pids = new Set<number>();
  if (child?.pid && alive(child)) pids.add(child.pid);
  if (process.platform === 'win32') {
    const json = await runQuiet('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe' or Name='chromium.exe'\" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
    ]);
    let list: { ProcessId: number; CommandLine: string | null }[] = [];
    try {
      const parsed = JSON.parse(json || '[]');
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch {}
    const want = `--user-data-dir=${resolve(dir)}`.toLowerCase();
    for (const p of list) {
      // Edge starts itself again with the folder written --user-data-dir="...".
      const cmd = (p.CommandLine ?? '').toLowerCase().replaceAll('--user-data-dir="', '--user-data-dir=');
      if (cmd.includes('--type=')) continue;
      const at = cmd.indexOf(want);
      const next = at < 0 ? '' : cmd.charAt(at + want.length);
      if (at >= 0 && (next === '' || next === '"' || next === ' ')) pids.add(p.ProcessId);
    }
  } else {
    const link = await readlink(join(dir, 'SingletonLock')).catch(() => '');
    const pid = Number(link.slice(link.lastIndexOf('-') + 1));
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}

async function closeBrowserIn(dir: string, child?: ChildProcess, force = false): Promise<boolean> {
  const pids = await browserPids(dir, child);
  if (!pids.length) return false;
  const signal = async (force: boolean) => {
    for (const pid of pids)
      if (process.platform === 'win32') await runQuiet('taskkill', ['/PID', String(pid), ...(force ? ['/T', '/F'] : [])]);
      else
        try {
          process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch {}
  };
  const closed = async (ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 500))) if (!(await profileRunning(dir))) return true;
    return !(await profileRunning(dir));
  };
  if (!force) await signal(false);
  if (!force && (await closed(CLOSE_MS))) return true;
  await signal(true);
  return closed(5000);
}
let closeFn: (dir: string, child?: ChildProcess) => Promise<boolean> = closeBrowserIn;

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
  const b = browserFor(dir);
  if ('none' in b) throw new Error(b.none);
  const ext = extensionDir();
  if (!ext) throw new Error("The EXTREMELY extension isn't with the app (reinstall it), so the agents' own profiles can't open.");
  const { exe, kind } = b.found;
  await letSandboxRead(exe);
  const name = kind === 'edge' ? 'Edge' : 'Chromium';
  const deadline = Date.now() + openMs;
  const connectUrl = () => connectPageUrl(pairCode({ browser: n, local: true }).link);

  const isRunning = async () => alive(children.get(n)) || (await (runningFn ?? profileRunning)(dir));
  // Open with the extension switched off: closed, to open again with it on.
  const closeIfSwitchedOff = async () => {
    if (!(await extensionSwitchedOff(dir))) return false;
    log(`browser ${n} is open with the EXTREMELY extension switched off; closing it to open it again with the extension on`);
    if (await closeFn(dir, children.get(n))) return true;
    logError(`browser ${n} couldn't be closed; its extension stays off until it's closed`);
    return false;
  };
  let running = await isRunning();
  if (running && (await closeIfSwitchedOff())) running = false;
  let paired = m.paired;
  let proc: ChildProcess | undefined;
  if (!running) {
    await tidyPreferences(dir);
    await forgetDisabledExtension(dir);
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
    // Switched off since it started (or by a browser started before this app): closed and
    // opened afresh, not given another connect page that can only say "Not connected".
    if ((await isRunning()) && (await closeIfSwitchedOff())) {
      await tidyPreferences(dir);
      await forgetDisabledExtension(dir);
    }
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
