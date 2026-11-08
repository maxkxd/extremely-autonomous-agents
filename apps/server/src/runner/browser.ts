import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { Cdp, CdpPage, type Bounds } from './cdp.js';
import { checkUrl, isPrivateIp } from './net.js';
import { onApprovalSettled, onRunEnd, registerTools, type RunCtx, type ToolDef } from './tools.js';
import { one } from './db.js';
import { ACCOUNTS_PER_SITE, listPasswords, makePassword, passwordRow, profileFor, readPassword, savePassword, siteOf } from './passwords.js';
import { DATA_DIR } from '../paths.js';
import { deleteSecret, getSecret, setSecret } from '../vault.js';

// Browsing for agents (docs/integrations.md), on the Edge or Chrome already
// installed - nothing to download.
//
//   browser.*            a blank throwaway browser: no sign-ins, nothing kept
//   signed_in_browser.*  the agents' own profiles: separate, persistent browser
//                        profiles (never the person's own), signed in to sites by
//                        the person or by agents themselves - agents sign up for
//                        accounts, keeping each password in the password store
//                        (passwords.ts). Profile 1 first; a profile holds up to 10
//                        accounts on one site, and the next one gets a new profile.
//
// A page comes back as its text plus numbered buttons, links and fields; the agent
// clicks or types by number. Every request an agent's page makes is checked like any
// agent fetch: never this computer or its network.
//
// A profile is one browser, shared: every agent run using it gets its own window
// (on screen, to watch or click in) and the person gets theirs when they need it - a
// sign-in, a CAPTCHA - all at once, with the same sign-ins, nobody waiting for
// anybody (see "A profile's browser" below).

export const PROFILES_DIR = join(DATA_DIR, 'browser-profiles');
const OLD_PROFILE_DIR = join(DATA_DIR, 'browser-profile'); // one profile, before there could be more
const profileDir = (n: number) => join(PROFILES_DIR, String(n));
const TEXT_CHARS = 8_000;
const MAX_ELEMENTS = 80;

// --- Profiles -----------------------------------------------------------------------

let ready: Promise<void> | null = null;
function prepareDir() {
  ready ??= (async () => {
    await mkdir(PROFILES_DIR, { recursive: true });
    if (existsSync(OLD_PROFILE_DIR) && !existsSync(profileDir(1))) await rename(OLD_PROFILE_DIR, profileDir(1)).catch(() => {});
    await mkdir(profileDir(1), { recursive: true });
  })();
  return ready;
}

export async function listProfiles(): Promise<number[]> {
  await prepareDir();
  return (await readdir(PROFILES_DIR, { withFileTypes: true }))
    .filter(d => d.isDirectory() && /^\d+$/.test(d.name))
    .map(d => Number(d.name))
    .sort((a, b) => a - b);
}

async function knownProfile(raw: unknown): Promise<number> {
  const n = raw == null || raw === '' ? 1 : Number(raw);
  const have = await listProfiles();
  if (!have.includes(n)) throw new Error(`No browser profile ${String(raw)}. There ${have.length === 1 ? 'is profile 1' : `are profiles ${have.join(', ')}`}.`);
  return n;
}

// Where the browser last left its window, if it's mostly on the screen it was saved
// on. The hidden placeholder window the agents' browser once kept off to the left was
// saved as the profile's spot, so the person's window opened there, 30px showing.
type Placement = { left: number; top: number; right: number; bottom: number; work_area_left: number; work_area_top: number; work_area_right: number; work_area_bottom: number };
export function onScreen(w: Placement) {
  const across = Math.min(w.right, w.work_area_right) - Math.max(w.left, w.work_area_left);
  const down = Math.min(w.bottom, w.work_area_bottom) - Math.max(w.top, w.work_area_top);
  return across >= (w.right - w.left) / 2 && down >= (w.bottom - w.top) / 2 && w.top >= w.work_area_top - 20;
}

// Kept signed in across restarts: the browser restores its session cookies too
// (sites whose sign-in has no "remember me" otherwise forget it on close), and it
// never offers to save passwords - the store does that.
async function keepSignedIn(dir: string) {
  const file = join(dir, 'Default', 'Preferences');
  let prefs: Record<string, any> = {};
  try {
    prefs = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // a new profile
  }
  prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 1 };
  prefs.profile = { ...(prefs.profile ?? {}), exit_type: 'Normal', exited_cleanly: true, password_manager_enabled: false };
  prefs.credentials_enable_service = false;
  // Off the screen: forgotten, so the window opens where the browser places a new one.
  if (prefs.browser?.window_placement && !onScreen(prefs.browser.window_placement)) delete prefs.browser.window_placement;
  await mkdir(join(dir, 'Default'), { recursive: true });
  await writeFile(file, JSON.stringify(prefs));
  // And it really quits when its window closes: Edge keeps running in the background
  // by default, which left the profile "open" (and unusable by agents) for good.
  const stateFile = join(dir, 'Local State');
  let state: Record<string, any> = {};
  try {
    state = JSON.parse(await readFile(stateFile, 'utf8'));
  } catch {
    // a new profile
  }
  state.background_mode = { ...(state.background_mode ?? {}), enabled: false };
  await writeFile(stateFile, JSON.stringify(state));
}

// Chrome on Linux locks a profile with a link naming the machine and process that has it
// open. A container that started again is a new machine with the same folder, so Chrome
// takes its own old lock for another computer's and won't open the profile ("open in a
// browser window the app didn't start"). A lock from another machine, or from a process
// that's gone, is cleared before starting.
async function clearStaleLock(dir: string) {
  if (process.platform === 'win32') return;
  const lock = await readlink(join(dir, 'SingletonLock')).catch(() => null);
  if (!lock) return;
  const at = lock.lastIndexOf('-');
  const [host, pid] = [lock.slice(0, at), Number(lock.slice(at + 1))];
  let alive = host === hostname();
  if (alive)
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
  if (alive) return;
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) await rm(join(dir, f), { force: true });
}

// The Edge or Chrome on this computer - the same one for the person's window and the
// agents, so they share one profile format and its saved sign-ins.
export function browserExe(): string | null {
  const env = process.env;
  if (env.EAA_BROWSER && existsSync(env.EAA_BROWSER)) return env.EAA_BROWSER;
  const candidates =
    process.platform === 'win32'
      ? [
          join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return candidates.find(p => p && existsSync(p)) ?? null;
}
const noBrowser = () => new Error('No Edge or Chrome found on this computer. Install one, and agents can use it.');

// --- Starting a browser ------------------------------------------------------------

async function launch(headless: boolean): Promise<Browser> {
  const exe = browserExe();
  if (!exe) throw noBrowser();
  return chromium.launch({ executablePath: exe, headless, args: EXTRA_FLAGS });
}

// --- A profile's browser, shared -----------------------------------------------------
//
// A profile folder can only be open in one browser at a time, so there is one per
// profile and the agents share it, each run in its own window. It's the plain
// browser, started with a debugging address on this computer and driven over it one
// page at a time (cdp.ts). Agents' windows open on screen, behind what the person's
// doing - they can watch, and click in, any of them. It starts with no window at all
// (--no-startup-window), and keeps running with none between runs: there used to be a
// blank one kept off-screen so it wouldn't quit, which sat on the taskbar and couldn't
// be opened. It closes a minute after the last run.
//
// The person signs in elsewhere: Google refuses a browser started with a debugging
// address at all - attached to the page or not ("This browser or app may not be
// secure"; checked live) - so their window is the plain browser alone (see "A profile
// on the person's screen").

type Shared = {
  proc: ChildProcess;
  cdp: Cdp;
  runs: Set<string>; // runs with a window open in it
  idle?: ReturnType<typeof setTimeout>;
  opening?: number; // agents' pages being made right now
};
const shared = new Map<number, Promise<Shared>>();
const IDLE_CLOSE_MS = 60_000;
// Agents' windows one after another down and across, so each can be seen.
let opened = 0;
const agentBounds = (): Bounds => {
  const k = opened++ % 6;
  return { left: 120 + k * 40, top: 80 + k * 30, width: 1280, height: 900 };
};
// Behind other windows, a browser mustn't slow a page down like a hidden tab.
const PROFILE_FLAGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--no-startup-window',
];
// Where the machine needs more: in a container (docs/hosting-in-the-cloud.md),
// "--no-sandbox --password-store=basic --disable-dev-shm-usage" - no user
// namespaces for Chrome's sandbox, no keyring to lock cookies with, a small /dev/shm.
const EXTRA_FLAGS = (process.env.EAA_BROWSER_ARGS ?? '').split(/\s+/).filter(f => f.startsWith('--'));

const strayError = (n: number) =>
  new Error(`Browser profile ${n} is open in a browser window the app didn't start (one left from before an update, say). Close that window and try again.`);

async function profileBrowser(n: number): Promise<Shared> {
  let p = shared.get(n);
  if (!p) {
    p = startProfile(n);
    shared.set(n, p);
    p.catch(() => {
      if (shared.get(n) === p) shared.delete(n);
    });
  }
  return p;
}

async function startProfile(n: number): Promise<Shared> {
  const exe = browserExe();
  if (!exe) throw noBrowser();
  const dir = profileDir(n);
  await keepSignedIn(dir);
  // The one before it, still shutting down, goes first: two on one folder is twice the memory.
  await closing.get(n);
  await clearStaleLock(dir);
  // The browser writes its debugging port (and its address) here once it's listening.
  const portFile = join(dir, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const proc = spawn(exe, [`--user-data-dir=${dir}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', ...PROFILE_FLAGS, ...EXTRA_FLAGS], { stdio: 'ignore', windowsHide: false, detached: GROUPS });
  running.add(proc);
  let exited = false;
  proc.on('error', e => {
    exited = true;
    console.error(`[browser] Profile ${n} (agents) failed to start:`, e.message);
  });
  proc.on('exit', (code, signal) => {
    exited = true;
    running.delete(proc);
    if (code !== 0 && code !== null) console.error(`[browser] Profile ${n} (agents) exited (code ${code}${signal ? `, ${signal}` : ''}).`);
    else console.log(`[browser] Profile ${n} (agents) exited${signal ? ` (${signal})` : ''}.`);
  });
  let port = 0;
  let path = '';
  // Already open in a browser we didn't start: this one hands over to it and exits, with no port.
  for (let i = 0; i < 200 && !port && !exited; i++) {
    const [first, second] = (await readFile(portFile, 'utf8').catch(() => '')).split('\n').map(l => l.trim());
    if (/^\d+$/.test(first ?? '') && second?.startsWith('/devtools/browser/')) [port, path] = [Number(first), second];
    else await new Promise(r => setTimeout(r, 100));
  }
  if (!port) {
    proc.kill();
    throw exited ? strayError(n) : new Error(`Browser profile ${n} didn't start. Try again.`);
  }
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
  await restoreSessionCookies(cdp, n);
  await addCarriedCookies(cdp, n);
  const s: Shared = { proc, cdp, runs: new Set() };
  proc.on('exit', () => {
    clearTimeout(s.idle);
    // Only this browser's entry: a newer one may have started since.
    void shared.get(n)?.then(cur => cur === s && shared.delete(n), () => {});
  });
  cdp.onClose(() => void endBrowser(proc));
  return s;
}

// A browser asked to close that hasn't within CLOSE_DEADLINE_MS is ended, with
// everything it started: one stuck shutting down kept its memory for hours while
// the next run started another beside it. Off Windows each browser leads its own
// process group, so its renderers and GPU process go with it.
const GROUPS = process.platform !== 'win32';
const CLOSE_DEADLINE_MS = 10_000;
const closing = new Map<number, Promise<void>>();
export async function endBrowser(proc: ChildProcess, ask?: () => Promise<unknown>, deadline = CLOSE_DEADLINE_MS) {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const gone = new Promise<void>(r => proc.once('exit', () => r()));
  if (ask) await Promise.race([ask().catch(() => proc.kill()), gone]);
  else proc.kill();
  const timer = new Promise<'late'>(r => setTimeout(() => r('late'), deadline).unref());
  if ((await Promise.race([gone, timer])) !== 'late') return;
  console.error(`[browser] A browser (pid ${proc.pid}) didn't close in ${deadline / 1000} s; ending it.`);
  killTree(proc);
  await Promise.race([gone, new Promise(r => setTimeout(r, 2_000).unref())]);
}
function killTree(proc: ChildProcess) {
  try {
    if (GROUPS && proc.pid) process.kill(-proc.pid, 'SIGKILL');
    else proc.kill('SIGKILL');
  } catch {
    proc.kill('SIGKILL');
  }
}

// Nobody's using it: close it a minute later, sign-ins kept.
function closeWhenIdle(n: number, s: Shared) {
  clearTimeout(s.idle);
  if (s.runs.size) return;
  s.idle = setTimeout(() => {
    if (!s.runs.size) closeShared(n, s);
  }, IDLE_CLOSE_MS);
}
function closeShared(n: number, s: Shared) {
  clearTimeout(s.idle);
  void shared.get(n)?.then(cur => cur === s && shared.delete(n), () => {});
  const done = endBrowser(s.proc, async () => {
    await keepSessionCookies(s.cdp, n).catch(e => console.error(`[browser] Profile ${n}: keeping the session before closing failed:`, (e as Error).message));
    await s.cdp.send('Browser.close');
  });
  closing.set(n, done);
  void done.finally(() => closing.get(n) === done && closing.delete(n));
  return done;
}

// The app quitting takes the profiles' browsers with it.
const running = new Set<ChildProcess>();
process.on('exit', () => {
  for (const proc of running)
    try {
      if (GROUPS && proc.pid) process.kill(-proc.pid, 'SIGTERM');
      else proc.kill();
    } catch {
      proc.kill();
    }
});

// Nothing a page asks for on this computer or its network.
function allowUrl() {
  const verdicts = new Map<string, boolean>();
  return async (raw: string) => {
    if (raw.startsWith('data:') || raw.startsWith('blob:')) return true;
    try {
      const url = checkUrl(raw);
      let ok = verdicts.get(url.hostname);
      if (ok === undefined) {
        const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
        ok = addresses.length > 0 && !addresses.some(a => isPrivateIp(a.address));
        verdicts.set(url.hostname, ok);
      }
      return ok;
    } catch {
      return false;
    }
  };
}
async function guard(context: BrowserContext) {
  const allow = allowUrl();
  await context.route('**/*', async route => ((await allow(route.request().url())) ? route.continue() : route.abort('blockedbyclient')));
}

// --- Sessions, one per run, kind and profile ------------------------------------------

// What the tools drive: a profile's page over DevTools (cdp.ts), or a blank
// throwaway browser's page through Playwright, made to look the same.
type Driver = Pick<CdpPage, 'isClosed' | 'close' | 'goto' | 'ready' | 'url' | 'evaluate' | 'back' | 'click' | 'fill' | 'pressEnter' | 'options' | 'select' | 'wheel'>;
function playwrightDriver(page: Page): Driver {
  const el = (ref: number) => page.locator(`[data-eaa-ref="${ref}"]`).first();
  return {
    isClosed: () => page.isClosed(),
    close: () => page.close().catch(() => {}),
    goto: async url => void (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })),
    ready: async () => void (await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {})),
    url: async () => page.url(),
    evaluate: async <T,>(expression: string) => (await page.evaluate(expression)) as T,
    back: async () => void (await page.goBack({ timeout: 15_000 }).catch(() => {})),
    click: ref => el(ref).click({ timeout: 10_000 }),
    fill: (ref, text) => el(ref).fill(text, { timeout: 10_000 }),
    pressEnter: () => page.keyboard.press('Enter'),
    options: ref => el(ref).evaluate(e => (e instanceof HTMLSelectElement ? [...e.options].map(o => o.text.replace(/\s+/g, ' ').trim()) : null), null, { timeout: 10_000 }),
    select: async (ref, index) => void (await el(ref).selectOption({ index }, { timeout: 10_000 })),
    wheel: deltaY => page.mouse.wheel(0, deltaY),
  };
}

// blank: its own throwaway browser. profile: its own window in the profile's shared browser.
// cdp/agent: a profile's page, as the live view sees it (live-view.ts).
type Session = { kind: 'blank' | 'profile'; runId: string; profile: number; browser?: Browser; page: Driver; cdp?: CdpPage; agent?: { id: string; name: string } };
const sessions = new Map<string, Session>();

// Two tool calls at once share one opening, and one that finishes after its run
// ended closes again: either way a browser used to be left running with nobody's
// run to close it.
const sessionOpening = new Map<string, Promise<Session>>();
const endedRuns = new Set<string>();
async function session(ctx: RunCtx, kind: Session['kind'], profile = 1): Promise<Session> {
  const key = `${ctx.runId}:${kind}:${kind === 'profile' ? profile : 0}`;
  const existing = sessions.get(key);
  if (existing && !existing.page.isClosed()) {
    if (existing.cdp) await untilFree(existing.cdp);
    return existing;
  }
  if (existing) await closeSession(key);
  // A click a person approved runs on the page it was queued on, kept for it. With
  // that page gone a blank one would only fail ("no [13] on the page") - say why.
  if (ctx.approved)
    throw new Error("The page this click was on closed before it was approved (the agency restarted, or the page was closed), so nothing was clicked. Open the page again, redo the steps, and queue the click once more.");
  let p = sessionOpening.get(key);
  if (!p) {
    p = openSession(ctx, kind, profile, key);
    sessionOpening.set(key, p);
    void p.finally(() => sessionOpening.delete(key)).catch(() => {});
  }
  return p;
}
async function openSession(ctx: RunCtx, kind: Session['kind'], profile: number, key: string): Promise<Session> {
  let s: Session;
  if (kind === 'blank') {
    const browser = await launch(true);
    const context = await browser.newContext({ acceptDownloads: false, viewport: { width: 1280, height: 900 } });
    s = { kind, runId: ctx.runId, profile: 0, browser, page: playwrightDriver(await context.newPage()) };
    await guard(context);
  } else {
    const sh = await profileBrowser(profile);
    clearTimeout(sh.idle);
    sh.runs.add(ctx.runId);
    sh.opening = (sh.opening ?? 0) + 1;
    try {
      const page = await CdpPage.open(sh.cdp, agentBounds()).finally(() => sh.opening!--);
      await page.guard(allowUrl());
      s = { kind, runId: ctx.runId, profile, page, cdp: page, agent: { id: ctx.agent.id, name: ctx.agent.name } };
    } catch (e) {
      sh.runs.delete(ctx.runId);
      closeWhenIdle(profile, sh);
      throw e;
    }
  }
  sessions.set(key, s);
  if (endedRuns.has(ctx.runId)) {
    await closeSession(key);
    throw new Error('This run has ended.');
  }
  return s;
}

async function closeSession(key: string) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  if (s.cdp) release(s.cdp.targetId);
  if (s.kind === 'blank') return void (await Promise.race([s.browser?.close().catch(() => {}), new Promise(r => setTimeout(r, CLOSE_DEADLINE_MS).unref())]));
  const sh = await shared.get(s.profile)?.catch(() => null);
  if (sh) await keepSessionCookies(sh.cdp, s.profile).catch(() => {});
  await s.page.close().catch(() => {});
  if (!sh) return;
  sh.runs.delete(s.runId);
  await closeStrayPages(s.profile, sh).catch(() => 0);
  closeWhenIdle(s.profile, sh);
}

// Pages no run is driving: a site's popup or new tab ("Sign in with Google", a
// link that opens a window), left after the run that caused it ended. Each kept a
// renderer - and its memory - for as long as the browser ran, which with agents
// always working was for ever: twenty of them held 2.5 GB in the cloud. A popup
// whose run is still going stays (a sign-in completing in it). Checked when a run
// ends and with the leftovers sweep.
export function strayPages(targets: { targetId: string; type: string; openerId?: string }[], live: Set<string>) {
  return targets.filter(t => t.type === 'page' && !live.has(t.targetId) && !(t.openerId && live.has(t.openerId))).map(t => t.targetId);
}
async function closeStrayPages(n: number, sh: Shared) {
  if (sh.opening) return 0; // a page being made isn't a run's yet: next time
  const { targetInfos } = await sh.cdp.send<{ targetInfos: { targetId: string; type: string; openerId?: string }[] }>('Target.getTargets');
  if (sh.opening) return 0;
  const live = new Set([...sessions.values()].filter(x => x.profile === n && x.cdp && !x.cdp.isClosed()).map(x => x.cdp!.targetId));
  const stray = strayPages(targetInfos, live);
  for (const targetId of stray) await sh.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  return stray.length;
}

// A sign-in without "remember me" lives in session cookies, which the browser drops
// when it closes - so a run's sign-ins were gone by the next run. Kept in the vault
// (encrypted) when a run ends, and put back when the profile opens again.
const sessionKey = (n: number) => `browser:${n}:session-cookies`;
type KeptCookie = { name: string; value: string; domain: string; path: string; secure?: boolean; httpOnly?: boolean; sameSite?: string };
async function keepSessionCookies(cdp: Cdp, n: number) {
  const { cookies } = await cdp.send<{ cookies: (KeptCookie & { session?: boolean; expires?: number })[] }>('Storage.getCookies');
  const kept = cookies.filter(c => c.session || c.expires === -1).map(({ name, value, domain, path, secure, httpOnly, sameSite }) => ({ name, value, domain, path, secure, httpOnly, sameSite }));
  await setSecret(sessionKey(n), kept);
}
async function restoreSessionCookies(cdp: Cdp, n: number) {
  const kept = await getSecret<KeptCookie[]>(sessionKey(n)).catch(() => null);
  if (!kept?.length) return;
  const cookies = kept.map(({ name, value, domain, path, secure, httpOnly, sameSite }) => ({ name, value, domain, path, secure, httpOnly, ...(sameSite ? { sameSite } : {}) }));
  await cdp.send('Storage.setCookies', { cookies }).catch(() => {});
}

// Sign-ins carried over from another computer (scripts/move-org.ts): every cookie the
// profile had there, read through its browser's DevTools connection - a profile's
// cookie file can't be copied, it's locked to that computer's account. Added once,
// the first time the profile opens here; from then on they're this profile's own.
export const carriedKey = (n: number) => `browser:${n}:carried-cookies`;
async function addCarriedCookies(cdp: Cdp, n: number) {
  const carried = await getSecret<Record<string, unknown>[]>(carriedKey(n)).catch(() => null);
  if (!carried?.length) return;
  const now = Date.now() / 1000;
  const cookies = carried.filter(c => typeof c.expires !== 'number' || c.expires < 0 || c.expires > now);
  // One at a time past a batch that's refused, so one odd cookie doesn't lose the rest.
  await cdp.send('Storage.setCookies', { cookies }).catch(async () => {
    for (const c of cookies) await cdp.send('Storage.setCookies', { cookies: [c] }).catch(() => {});
  });
  await deleteSecret(carriedKey(n));
}

// --- The person's window has a folder of its own ----------------------------------------
//
// A profile's folder opens in one browser at a time, and Google won't sign anyone in
// to the agents' (it has a debugging connection). So the person's plain window runs
// on a copy - person-<n> beside the profile - seeded with the agents' sign-ins when
// it opens, and what they signed in to goes back to the agents' browser when it
// closes. The agents carry on meanwhile.
export const personDir = (n: number) => join(PROFILES_DIR, `person-${n}`);
const cookieParams = (c: Record<string, unknown>) => {
  const { name, value, domain, path, expires, httpOnly, secure, sameSite, priority, sourceScheme, sourcePort, partitionKey, session } = c;
  return {
    name,
    value,
    domain,
    path,
    httpOnly,
    secure,
    ...(sameSite ? { sameSite } : {}),
    ...(priority ? { priority } : {}),
    ...(sourceScheme ? { sourceScheme } : {}),
    ...(typeof sourcePort === 'number' ? { sourcePort } : {}),
    ...(partitionKey ? { partitionKey } : {}),
    ...(session || typeof expires !== 'number' || expires < 0 ? {} : { expires }),
  };
};
async function setAll(cdp: Cdp, cookies: Record<string, unknown>[]) {
  if (!cookies.length) return;
  // One at a time past a batch that's refused, so one odd cookie doesn't lose the rest.
  await cdp.send('Storage.setCookies', { cookies }).catch(async () => {
    for (const c of cookies) await cdp.send('Storage.setCookies', { cookies: [c] }).catch(() => {});
  });
}
// The folder in a browser of its own for a moment: no window, a debugging address on this computer.
async function withHeadless<T>(dir: string, fn: (cdp: Cdp) => Promise<T>): Promise<T> {
  const exe = browserExe();
  if (!exe) throw noBrowser();
  await mkdir(dir, { recursive: true });
  await clearStaleLock(dir);
  const portFile = join(dir, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const proc = spawn(exe, [`--user-data-dir=${dir}`, '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', ...EXTRA_FLAGS, 'about:blank'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  running.add(proc);
  try {
    let found = '';
    for (let i = 0; i < 150 && !/^\d+\n\/devtools\//.test(found); i++) {
      if (proc.exitCode !== null) throw new Error(`The browser on ${dir} closed straight away.`);
      found = (await readFile(portFile, 'utf8').catch(() => '')).replace(/\r/g, '');
      await sleep(100);
    }
    const [port, path] = found.split('\n').map(l => l.trim());
    if (!path) throw new Error(`The browser on ${dir} didn't start.`);
    const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
    try {
      return await fn(cdp);
    } finally {
      await cdp.send('Browser.close').catch(() => {});
    }
  } finally {
    const gone = new Promise<void>(r => (proc.exitCode !== null ? r() : proc.once('exit', () => r())));
    await Promise.race([gone, sleep(5_000)]);
    if (proc.exitCode === null) proc.kill();
    running.delete(proc);
  }
}
// Opening: the agents' sign-ins into the person's folder.
async function seedPersonDir(n: number) {
  const sh = await profileBrowser(n);
  const { cookies } = await sh.cdp.send<{ cookies: Record<string, unknown>[] }>('Storage.getCookies');
  closeWhenIdle(n, sh);
  await withHeadless(personDir(n), cdp => setAll(cdp, cookies.map(cookieParams)));
  return cookies.length;
}
// Closed: what they signed in to, into the agents' browser - straight in when it's
// open, or added the next time it opens.
async function carryBack(n: number) {
  const cookies = (await withHeadless(personDir(n), async cdp => (await cdp.send<{ cookies: Record<string, unknown>[] }>('Storage.getCookies')).cookies)).map(cookieParams);
  const sh = await shared.get(n)?.catch(() => null);
  if (sh && !sh.cdp.closed) {
    await setAll(sh.cdp, cookies);
    await keepSessionCookies(sh.cdp, n).catch(() => {});
  } else await setSecret(carriedKey(n), [...((await getSecret<Record<string, unknown>[]>(carriedKey(n)).catch(() => null)) ?? []), ...cookies]);
  console.log(`[browser] Profile ${n}: ${cookies.length} cookies from the person's window are in the agents' browser now.`);
}

// Leftovers, checked every few minutes where there's a `ps` (Linux: the cloud). A
// browser on an agents' profile folder that isn't the one the app is using, or a
// throwaway browser while no run has one open, is ended: nothing else would.
export function leftoverBrowsers(ps: string, self: number, ours: Set<number>, blankInUse: boolean) {
  const out: number[] = [];
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [pid, ppid, args] = [Number(m[1]), Number(m[2]), m[3]];
    if (ours.has(pid) || args.includes('--type=')) continue; // renderers and the like go with their browser
    const dir = /--user-data-dir=(\S+)/.exec(args)?.[1];
    if (!dir) continue;
    const agents = dir.startsWith(PROFILES_DIR) && /^\d+$/.test(dir.slice(PROFILES_DIR.length + 1));
    const blank = ppid === self && dir.includes('playwright_chromiumdev_profile') && !blankInUse;
    if (agents || blank) out.push(pid);
  }
  return out;
}
const SWEEP_MS = 5 * 60_000;
const psList = () => new Promise<string>(r => execFile('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 16 << 20 }, (err, out) => r(err ? '' : out)));
async function findLeftovers() {
  if (process.platform !== 'linux') return [];
  const ps = await psList();
  const ours = new Set<number>();
  for (const p of running) if (p.pid) ours.add(p.pid);
  for (const p of personProcs.values()) if (p.pid) ours.add(p.pid);
  const blankInUse = [...sessions.values()].some(x => x.kind === 'blank') || [...sessionOpening.keys()].some(k => k.includes(':blank:'));
  return leftoverBrowsers(ps, process.pid, ours, blankInUse);
}
async function endLeftovers() {
  const pids = await findLeftovers();
  for (const pid of pids) {
    console.error(`[browser] Ending a leftover browser (pid ${pid}).`);
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  return pids;
}
setInterval(() => {
  if (process.platform === 'linux') void endLeftovers();
  for (const [n, p] of shared) void p.then(sh => closeStrayPages(n, sh), () => 0).catch(() => 0);
}, SWEEP_MS).unref();

// What the Doctor and the Agency Engineer see of the browsers, and can clear (host.ts).
export async function browserCensus() {
  const agents: { profile: number; pid?: number; runs: number; pages: number; stray: number }[] = [];
  for (const [n, p] of shared) {
    const s = await p.catch(() => null);
    if (!s) continue;
    const { targetInfos } = await s.cdp.send<{ targetInfos: { targetId: string; type: string; openerId?: string }[] }>('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const live = new Set([...sessions.values()].filter(x => x.profile === n && x.cdp && !x.cdp.isClosed()).map(x => x.cdp!.targetId));
    agents.push({ profile: n, pid: s.proc.pid, runs: s.runs.size, pages: targetInfos.filter(t => t.type === 'page').length, stray: strayPages(targetInfos, live).length });
  }
  return {
    agents,
    personWindows: [...personProcs.entries()].map(([profile, p]) => ({ profile, pid: p.pid })),
    throwaway: [...sessions.values()].filter(x => x.kind === 'blank').length,
    leftovers: await findLeftovers(),
  };
}
// Leftovers ended, and agents' browsers no run is using closed now (sign-ins kept):
// each starts again fresh, with its memory back, when a run next needs it.
export async function cleanUpBrowsers() {
  const ended = await endLeftovers();
  const closed: number[] = [];
  let pages = 0;
  for (const [n, p] of [...shared]) {
    const s = await p.catch(() => null);
    if (!s) continue;
    if (s.runs.size) {
      pages += await closeStrayPages(n, s).catch(() => 0);
      continue;
    }
    await closeShared(n, s);
    closed.push(n);
  }
  return { ended, closed, pages };
}

// A click waiting for a person (click_to_pay, _post, _start_tool) keeps its page past
// the run that queued it - the form filled in, the numbers it was given - so the
// approved click lands where it was meant to. It closes once every one of that
// run's clicks is decided, or after a day.
const PARKED_MAX_MS = 24 * 3_600_000;
const waitingClick = (runId: string) =>
  !!one("SELECT 1 FROM approvals WHERE run_id = ? AND status = 'pending' AND tool LIKE 'signed_in_browser.click_to_%' LIMIT 1", runId);
const parked = new Map<string, ReturnType<typeof setTimeout>>();
async function closeSessions(runId: string) {
  endedRuns.add(runId);
  setTimeout(() => endedRuns.delete(runId), 30 * 60_000).unref();
  if (waitingClick(runId)) {
    if (!parked.has(runId)) parked.set(runId, setTimeout(() => void closeParked(runId, true), PARKED_MAX_MS).unref());
    return;
  }
  for (const key of [...sessions.keys()]) if (key.startsWith(`${runId}:`)) await closeSession(key);
}
onRunEnd(closeSessions);
async function closeParked(runId: string, anyway = false) {
  if (!parked.has(runId) || (!anyway && waitingClick(runId))) return;
  clearTimeout(parked.get(runId));
  parked.delete(runId);
  for (const key of [...sessions.keys()]) if (key.startsWith(`${runId}:`)) await closeSession(key);
}
onApprovalSettled(runId => closeParked(runId));

// --- What the agent sees --------------------------------------------------------------

// Runs in the page: numbers its visible buttons, links and fields, and reads
// its text. Plain JavaScript in a string, because the TypeScript loader adds
// helpers to compiled functions that don't exist inside the page.
// (A password field's value is never read: it may be one from the store.)
const SNAPSHOT_SCRIPT = `(() => {
  const max = ${MAX_ELEMENTS}, chars = ${TEXT_CHARS};
  document.querySelectorAll('[data-eaa-ref]').forEach(e => e.removeAttribute('data-eaa-ref'));
  const visible = e => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const tickable = e => e && e.tagName === 'INPUT' && (e.type === 'radio' || e.type === 'checkbox');
  const isSelect = e => e.tagName === 'SELECT';
  const label = e => (e.getAttribute('aria-label') || e.placeholder || e.getAttribute('title') || ((tickable(e) || isSelect(e)) && e.labels && e.labels[0] ? e.labels[0].innerText : '') || (isSelect(e) ? '' : e.innerText) || (e.type === 'password' || tickable(e) || isSelect(e) ? '' : e.value) || e.getAttribute('name') || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 80);
  const items = [];
  let n = 0;
  // A radio button or checkbox is often hidden behind a styled label: then its label
  // is what's listed, and clicking it ticks the box.
  for (const e of document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, label, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [contenteditable=true]')) {
    if (n >= max || !visible(e)) continue;
    const tag = e.tagName.toLowerCase();
    const control = tag === 'label' ? e.control : null;
    if (tag === 'label' && !(tickable(control) && !visible(control))) continue;
    n++;
    e.setAttribute('data-eaa-ref', String(n));
    const box = control || (tickable(e) ? e : null);
    const role = e.getAttribute('role');
    const kind = box ? (box.type === 'radio' ? 'radio option' : 'checkbox') + (box.checked ? ' (ticked)' : '')
      : role === 'radio' || role === 'checkbox' ? role + (e.getAttribute('aria-checked') === 'true' ? ' (ticked)' : '')
      : tag === 'a' || role === 'link' ? 'link'
      : tag === 'input' ? (e.type || 'text') + ' field'
      : tag === 'textarea' || e.getAttribute('contenteditable') === 'true' ? 'text box'
      : tag === 'select' ? 'dropdown' : 'button';
    const href = tag === 'a' ? ' -> ' + e.href : '';
    // A dropdown shows what's picked and what it offers (choose picks one).
    const opts = tag === 'select' ? [...e.options].map(o => o.text.replace(/\\s+/g, ' ').trim()).filter(Boolean) : [];
    const picked = tag === 'select' && e.selectedOptions[0] ? e.selectedOptions[0].text.replace(/\\s+/g, ' ').trim() : '';
    const choices = tag === 'select' ? ' = "' + picked + '"; options: ' + opts.slice(0, 15).map(o => '"' + o.slice(0, 40) + '"').join(', ') + (opts.length > 15 ? ' (+' + (opts.length - 15) + ' more)' : '') : '';
    items.push('[' + n + '] ' + kind + ' "' + label(e) + '"' + href + choices);
  }
  const text = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title, text: text.length > chars ? text.slice(0, chars) + '\\n[page text cut off - scroll to see more]' : text, items };
})()`;

// The page's text and its numbered interactive elements.
async function snapshot(page: Driver): Promise<string> {
  await page.ready();
  const view = await page.evaluate<{ title: string; text: string; items: string[] }>(SNAPSHOT_SCRIPT);
  return [`Title: ${view.title || '(none)'}`, `URL: ${await page.url()}`, '', view.text || '(no text)', '', view.items.length ? `What you can use (by number):\n${view.items.join('\n')}` : 'Nothing to click on this page.'].join('\n');
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- The tools ------------------------------------------------------------------------

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required });
const PROFILE_ARG = { type: 'number', description: 'Which browser profile (1 unless the account you need is in another - signed_in_browser.passwords says which)' };

function toolsFor(kind: Session['kind'], prefix: string, actTier: 'T0' | 'T1', where: string): ToolDef[] {
  const withProfile = (props: Record<string, unknown>) => (kind === 'profile' ? { ...props, profile: PROFILE_ARG } : props);
  const open = (ctx: RunCtx, a: Record<string, unknown>) => (kind === 'profile' ? knownProfile(a.profile).then(n => session(ctx, kind, n)) : session(ctx, kind));
  const click = async (a: Record<string, unknown>, ctx: RunCtx) => {
    const s = await open(ctx, a);
    await s.page.click(Number(a.ref));
    await wait(800);
    return snapshot(s.page);
  };
  return [
    {
      id: `${prefix}.open`,
      tier: 'T0',
      description: `Open a web address in ${where}. Returns the page's text and its buttons, links and fields, numbered.`,
      schema: obj(withProfile({ url: { type: 'string', description: 'The full address, starting http:// or https://' } }), ['url']),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        await s.page.goto(checkUrl(String(a.url ?? '')).toString());
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.click`,
      tier: actTier,
      description:
        kind === 'profile'
          ? `Click a numbered button or link on the current page in ${where}. Not the click that pays, posts publicly as the business, or starts a new business tool: those are click_to_pay, click_to_post and click_to_start_tool.`
          : `Click a numbered button or link on the current page in ${where}. Returns the page after the click.`,
      schema: obj(withProfile({ ref: { type: 'number', description: 'The number from the last page you saw' } }), ['ref']),
      impl: click,
    },
    {
      id: `${prefix}.type`,
      tier: actTier,
      description: `Type into a numbered field on the current page in ${where} (replacing what's there); submit presses Enter afterwards.${kind === 'profile' ? ' Never a password: type_password types one from the store.' : ''}`,
      schema: obj(withProfile({ ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }), ['ref', 'text']),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        await s.page.fill(Number(a.ref), String(a.text ?? ''));
        if (a.submit) await s.page.pressEnter();
        await wait(a.submit ? 1200 : 200);
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.choose`,
      tier: actTier,
      description: `Pick an option in a numbered dropdown on the current page in ${where}: the option as the page lists it (an exact match, or the one that contains what you give).`,
      schema: obj(withProfile({ ref: { type: 'number' }, option: { type: 'string', description: 'The option to pick, as listed' } }), ['ref', 'option']),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        const want = String(a.option ?? '').trim().toLowerCase();
        const options = await s.page.options(Number(a.ref));
        if (!options) throw new Error(`[${String(a.ref)}] isn't a dropdown. Click it instead, then click the option.`);
        const index = [options.findIndex(o => o.toLowerCase() === want), options.findIndex(o => o.toLowerCase().includes(want))].find(i => i >= 0);
        if (index == null) throw new Error(`No option like "${String(a.option)}". It has: ${options.slice(0, 30).map(o => `"${o}"`).join(', ')}`);
        await s.page.select(Number(a.ref), index);
        await wait(500);
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.scroll`,
      tier: 'T0',
      description: `Scroll the current page in ${where} down (or up) and see what's there.`,
      schema: obj(withProfile({ direction: { type: 'string', enum: ['down', 'up'] } }), []),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        await s.page.wheel(a.direction === 'up' ? -1600 : 1600);
        await wait(500);
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.back`,
      tier: 'T0',
      description: `Go back to the previous page in ${where}.`,
      schema: obj(withProfile({}), []),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        await s.page.back().catch(() => {});
        return snapshot(s.page);
      },
    },
    ...(kind === 'profile' ? profileOnly(where, click) : []),
  ];
}

// The clicks that always wait for a person (unless they lower them on the Tools page),
// the password store, and opening a profile on the person's screen.
function profileOnly(where: string, click: ToolDef['impl']): ToolDef[] {
  const decisive = (id: string, what: string): ToolDef => ({
    id: `signed_in_browser.${id}`,
    tier: 'T2',
    description: `The click that ${what}, in ${where}: a numbered button on the current page. Waits for the person's approval, unless they lowered it.`,
    schema: obj({ ref: { type: 'number', description: 'The number from the last page you saw' }, what: { type: 'string', description: 'For the person approving, in a sentence: exactly what this click does (the plan and price, the post, the tool)' }, profile: PROFILE_ARG }, ['ref', 'what']),
    impl: click,
  });
  return [
    decisive('click_to_pay', 'spends money (a purchase, a paid plan, a subscription)'),
    decisive('click_to_post', 'posts something publicly as the business (a post, a public reply, a review)'),
    decisive('click_to_start_tool', 'starts using a new business tool - a CRM, a help desk, an email platform - rather than an account to do your job'),
    {
      id: 'signed_in_browser.make_password',
      tier: 'T1',
      description: `Signing up for an account: makes a strong password and keeps it in the agency's password store - you never see it. Type it with signed_in_browser.type_password. Says which browser profile the account belongs in (a profile holds up to ${ACCOUNTS_PER_SITE} accounts on one site; past that, a new profile is made).`,
      schema: obj({ site: { type: 'string', description: 'The site the account is for, e.g. google.com, linkedin.com' }, username: { type: 'string', description: 'The username or email address for the account' }, note: { type: 'string', description: 'What the account is for, for the person' } }, ['site', 'username']),
      impl: async (a, ctx) => {
        const site = siteOf(String(a.site ?? ''));
        const username = String(a.username ?? '').trim();
        if (!username) throw new Error('Give the username or email address the account uses.');
        const { profile, isNew } = profileFor(site, await listProfiles());
        if (isNew) await mkdir(profileDir(profile), { recursive: true });
        const id = await savePassword({ site, username, password: makePassword(), profile, agentId: ctx.agent.id, note: a.note ? String(a.note) : null });
        return `Password #${id} made for ${username} at ${site} and kept in the store. Sign up in browser profile ${profile}${isNew ? ` (new: profile ${profile - 1} already has ${ACCOUNTS_PER_SITE} ${site} accounts)` : ''}: pass profile ${profile} to the signed_in_browser tools, and type the password with signed_in_browser.type_password, password_id "${id}".`;
      },
    },
    {
      id: 'signed_in_browser.type_password',
      tier: 'T1',
      description: 'Type a password from the store into a numbered password field (you never see it). submit presses Enter afterwards.',
      schema: obj({ ref: { type: 'number' }, password_id: { type: 'string', description: 'The password number from make_password or passwords' }, submit: { type: 'boolean' }, profile: PROFILE_ARG }, ['ref', 'password_id']),
      impl: async (a, ctx) => {
        const row = passwordRow(String(a.password_id ?? ''));
        const s = await session(ctx, 'profile', await knownProfile(a.profile ?? row?.profile));
        await s.page.fill(Number(a.ref), await readPassword(String(a.password_id ?? '')));
        if (a.submit) await s.page.pressEnter();
        await wait(a.submit ? 1500 : 200);
        return snapshot(s.page);
      },
    },
    {
      id: 'signed_in_browser.passwords',
      tier: 'T0',
      description: "The accounts in the agency's password store: site, username, password number and browser profile - never the passwords.",
      schema: obj({ site: { type: 'string', description: 'Only this site (optional)' } }, []),
      impl: async a => {
        const rows = listPasswords(a.site ? String(a.site) : null);
        return rows.length ? rows.map(r => `#${r.id} ${r.site} - ${r.username} (profile ${r.profile})${r.note ? ` - ${r.note}` : ''}`).join('\n') : 'No accounts in the store yet.';
      },
    },
    {
      id: 'signed_in_browser.show_person',
      tier: 'T0',
      description:
        "Open a browser profile in a window on the person's screen, at a page - for what only a person can do: a CAPTCHA, or a code sent to their phone. Then file a request saying what they need to do, with a line \"Open in signed-in browser: <address>\" (and \" (profile N)\" if not 1) so they get a button. Your own browser on that profile carries on meanwhile - file the request and get on with other work. What they sign in to is signed in for you too once they close their window.",
      schema: obj({ url: { type: 'string', description: 'The page to open' }, profile: PROFILE_ARG }, ['url']),
      impl: async a => {
        const n = await knownProfile(a.profile);
        await openProfileWindow(n, String(a.url ?? ''));
        return `Opened profile ${n} on the person's screen at ${String(a.url)}.`;
      },
    },
  ];
}

export const BROWSER_TOOLS = toolsFor('blank', 'browser', 'T0', 'a blank throwaway browser (no sign-ins)');
export const SIGNED_IN_TOOLS = toolsFor('profile', 'signed_in_browser', 'T1', "the agents' own signed-in browser profiles");
registerTools([...BROWSER_TOOLS, ...SIGNED_IN_TOOLS]);

// --- Watched by a person: the live view (live-view.ts) --------------------------------
//
// Every agent's page in a profile's browser can be watched, and taken over: while the
// person has a page, the agent's browser tools on it wait (that agent, that page only),
// and only a page they've taken gets their input. They can open pages of their own in
// a profile's browser too - in the cloud that's where they sign in and do CAPTCHAs,
// since nobody can see the container's screen.

export type LiveTab = {
  id: string; // the page's target id
  kind: 'agent' | 'person';
  profile: number;
  agent: { id: string; name: string } | null;
  page: CdpPage;
  since: number;
  request?: number; // a person's page opened from a request
};
const opening = new Map<string, number>(); // when each agent page was first seen
export function liveTabs(): LiveTab[] {
  const tabs: LiveTab[] = [];
  for (const s of sessions.values()) {
    if (!s.cdp || s.cdp.isClosed()) continue;
    const id = s.cdp.targetId;
    if (!opening.has(id)) opening.set(id, Date.now());
    tabs.push({ id, kind: 'agent', profile: s.profile, agent: s.agent ?? null, page: s.cdp, since: opening.get(id)! });
  }
  return tabs;
}

// Taken by the person: the agent waits on it until it's handed back (or 15 minutes).
const HOLD_MAX_MS = 15 * 60_000;
const held = new Map<string, { since: number; release: () => void; released: Promise<void> }>();
export const heldSince = (id: string) => held.get(id)?.since ?? null;
export function hold(id: string) {
  if (held.has(id)) return;
  let release = () => {};
  const released = new Promise<void>(r => (release = r));
  held.set(id, { since: Date.now(), release, released });
}
export function release(id: string) {
  held.get(id)?.release();
  held.delete(id);
}
async function untilFree(page: CdpPage) {
  const h = held.get(page.targetId);
  if (!h) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const freed = await Promise.race([h.released.then(() => true), new Promise<false>(r => (timer = setTimeout(() => r(false), HOLD_MAX_MS)))]);
  clearTimeout(timer);
  if (!freed) throw new Error("The person has taken over this page in the agents' browser and hasn't handed it back. Work on something else and try it later.");
}

// In the cloud nobody sees the screen: the person's window opens on a screen of its own
// (a virtual display per profile), which the live view streams and sends their input to
// (live-view.ts). It's still the plain browser, nothing attached, so Google signs them in.
const CLOUD = !!process.env.EAA_CLOUD_HOST;
const SCREEN = { width: 1280, height: 860 };
type Screen = { profile: number; display: string; since: number; url: string; request?: number };
const screens = new Map<number, Screen>();
export const personScreens = () => [...screens.values()];
export const screenSize = SCREEN;
const xvfbs = new Map<string, ChildProcess>();
const screenOf = (n: number) => `:${100 + n}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Chrome's POSIX profile lock is a symlink "hostname-pid". A hostname can itself
// contain dashes, so the pid is the part after the last one, and only this machine's
// lock counts: another machine's is a container that was replaced out from under it.
export function singletonPid(lock: string | null, host = hostname()): number | null {
  if (!lock) return null;
  const at = lock.lastIndexOf('-');
  if (at <= 0) return null;
  const pid = Number(lock.slice(at + 1));
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (lock.slice(0, at) !== host) return null;
  return pid;
}

// The process we spawned has gone. Keep streaming the screen when the lock names
// some other live process: Chrome's singleton makes the second process the window
// and the one we started exits, and dropping the screen then is how a live browser
// disappeared from the page with nothing to click.
export function personWindowAfterExit(ourPid: number | undefined, lockPid: number | null, lockAlive: boolean): 'keep' | 'close' {
  if (ourPid != null && lockPid != null && lockPid !== ourPid && lockAlive) return 'keep';
  return 'close';
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
async function pidParent(pid: number): Promise<number | null> {
  if (process.platform !== 'linux') return null;
  try {
    const m = /^PPid:\s+(\d+)/m.exec(await readFile(`/proc/${pid}/status`, 'utf8'));
    return m ? Number(m[1]) : null;
  } catch (e) {
    console.error(`[browser] Couldn't read the parent of pid ${pid}:`, (e as Error).message);
    return null;
  }
}

// One opener per profile. A second open used to run while the first was still
// closing the agents' browser and starting the screen, spawn its own Chrome
// (without the first-run flags, on a display that didn't exist yet), and that
// Chrome won the profile. The one we were watching then exited and took the
// screen with it.
const profileTails = new Map<number, Promise<void>>();
function withProfile<T>(n: number, fn: () => Promise<T>): Promise<T> {
  const prev = profileTails.get(n) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  profileTails.set(n, run.then(() => undefined, () => undefined));
  return run;
}

async function displayReady(display: string, x: ChildProcess) {
  const sock = `/tmp/.X11-unix/X${display.slice(1)}`;
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (x.exitCode !== null || x.signalCode) return false;
    if (existsSync(sock)) return true;
    await sleep(50);
  }
  return existsSync(sock) && x.exitCode === null;
}
async function displayFor(n: number) {
  const display = screenOf(n);
  const num = 100 + n;
  const had = xvfbs.get(display);
  if (had && had.exitCode === null) {
    if (await displayReady(display, had)) return display;
    console.error(`[browser] Virtual screen ${display} is running but its socket never appeared. Starting it again.`);
    had.kill();
    await Promise.race([new Promise<void>(r => had.once('exit', () => r())), sleep(2_000)]);
    xvfbs.delete(display);
  }
  await rm(`/tmp/.X${num}-lock`, { force: true });
  await rm(`/tmp/.X11-unix/X${num}`, { force: true });
  let stderr = '';
  const x = spawn('Xvfb', [display, '-screen', '0', `${SCREEN.width}x${SCREEN.height}x24`, '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'pipe'] });
  x.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2_000)));
  x.on('error', e => console.error(`[browser] Virtual screen ${display} failed to start:`, e.message));
  x.on('exit', (code, signal) => {
    running.delete(x);
    if (xvfbs.get(display) === x) xvfbs.delete(display);
    console.error(`[browser] Virtual screen ${display} exited (code ${code ?? 'none'}${signal ? `, ${signal}` : ''}).${stderr.trim() ? ` ${stderr.trim()}` : ''}`);
  });
  xvfbs.set(display, x);
  running.add(x);
  if (await displayReady(display, x)) {
    console.log(`[browser] Virtual screen ${display} is up.`);
    return display;
  }
  throw new Error(`The virtual screen ${display} never came up.${stderr.trim() ? ` ${stderr.trim()}` : ''}`);
}

// The browser that has the profile. `spawned` is the process we started; once
// that exits and Chrome has kept the profile under another pid, only that pid
// is left, and closing the window means signalling it.
type PersonBrowser = { pid: number | undefined; spawned?: ChildProcess; kill: () => void; exited: () => boolean };
const personProcs = new Map<number, PersonBrowser>();
const watchers = new Map<number, ReturnType<typeof setInterval>>();

// --- A profile on the person's screen ------------------------------------------------------

// The person's window: the plain browser, nothing attached and no debugging address,
// where Google signs them in - on its own copy of the profile (personDir), so the
// agents' browser stays open and its runs carry on. It opens with the agents' sign-ins
// and, once closed, what they signed in to goes to the agents (carryBack).
// onClosed: once it has closed (opened from a request, its Engineer is told) - once
// per key however often it's opened meanwhile.
const whenClosed = new Map<number, Map<string, () => void>>();
function personGone(n: number) {
  const then = whenClosed.get(n);
  whenClosed.delete(n);
  for (const f of then?.values() ?? []) {
    try {
      f();
    } catch (e) {
      console.error(`[browser] Profile ${n}: telling the agency the window closed failed:`, (e as Error).message);
    }
  }
}
const personOpen = new Map<number, Promise<void>>();
const personRelease = new Map<number, () => void>();
const PERSON_FLAGS = ['--no-first-run', '--no-default-browser-check'];
const personArgs = (dir: string, target: string, display: string | null) => [
  `--user-data-dir=${dir}`,
  ...PERSON_FLAGS,
  ...(display ? ['--window-position=0,0', `--window-size=${SCREEN.width},${SCREEN.height}`, '--start-maximized'] : []),
  ...EXTRA_FLAGS,
  target,
];

function forgetPerson(n: number, tell = true) {
  const w = watchers.get(n);
  if (w) clearInterval(w);
  watchers.delete(n);
  const proc = personProcs.get(n);
  if (proc?.spawned) running.delete(proc.spawned);
  personProcs.delete(n);
  screens.delete(n);
  personOpen.delete(n);
  // A window that never opened isn't "closed": the caller already got the error.
  if (!tell) whenClosed.delete(n);
  // What they signed in to, to the agents' browser - before the request is told it's done.
  void (tell ? carryBack(n) : Promise.resolve())
    .catch(e => console.error(`[browser] Profile ${n}: copying the person's sign-ins to the agents failed:`, (e as Error).message))
    .finally(() => personGone(n));
  const release = personRelease.get(n);
  personRelease.delete(n);
  release?.();
}

// Chrome kept the profile after the process we started exited. Watch that pid:
// the screen stays until it, and no successor, is gone.
function adopt(n: number, pid: number): PersonBrowser {
  const prev = watchers.get(n);
  if (prev) clearInterval(prev);
  const browser: PersonBrowser = {
    pid,
    kill() {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code !== 'ESRCH') console.error(`[browser] Profile ${n}: couldn't close pid ${pid}:`, err.message);
      }
    },
    exited: () => !pidAlive(pid),
  };
  const timer = setInterval(() => {
    if (pidAlive(pid)) return;
    clearInterval(timer);
    if (watchers.get(n) === timer) watchers.delete(n);
    void withProfile(n, async () => {
      if (personProcs.get(n) !== browser) return;
      const holder = singletonPid(await readlink(join(personDir(n), 'SingletonLock')).catch(() => null));
      if (holder && personWindowAfterExit(pid, holder, pidAlive(holder)) === 'keep') {
        console.error(`[browser] Profile ${n}: pid ${pid} exited and Chrome kept the profile as pid ${holder}. Still streaming that screen.`);
        personProcs.set(n, adopt(n, holder));
        return;
      }
      console.log(`[browser] Profile ${n} closed.`);
      forgetPerson(n);
    });
  }, 1_000);
  timer.unref();
  watchers.set(n, timer);
  return browser;
}

// Done (or handed back unfinished: its request isn't told) - the window closes.
export function closePersonWindow(n: number, done: boolean) {
  const proc = personProcs.get(n);
  if (!proc || proc.exited()) return false;
  if (!done) whenClosed.delete(n);
  console.log(`[browser] Profile ${n}: closing the signed-in browser (${done ? 'done' : 'handed back'}).`);
  const sc = screens.get(n);
  if (!sc) {
    proc.kill();
    return true;
  }
  // Closed the way a person closes it, so Chrome shuts down cleanly and writes its
  // cookies: killed, it loses the newest ones - a sign-in made a moment ago.
  void (async () => {
    for (let i = 0; i < 6 && !proc.exited(); i++) {
      await new Promise<void>(r => {
        const x = spawn('xdotool', ['key', 'ctrl+shift+w'], { env: { ...process.env, DISPLAY: sc.display }, stdio: 'ignore' });
        x.on('close', () => r());
        x.on('error', () => r());
      });
      await sleep(1_000);
    }
    if (!proc.exited()) {
      console.error(`[browser] Profile ${n}: the window didn't close; stopping it.`);
      proc.kill();
    }
  })();
  return true;
}

// True once this pid (or a child of it) holds the profile, so a second Chrome
// can only be a handoff: it opens the page in the browser we already track and exits.
async function profileHeld(dir: string, pid: number | undefined, since: number) {
  if (!pid || !pidAlive(pid)) return false;
  if (process.platform === 'win32') {
    try {
      return (await stat(join(dir, 'SingletonLock'))).mtimeMs >= since;
    } catch {
      return false;
    }
  }
  const holder = singletonPid(await readlink(join(dir, 'SingletonLock')).catch(() => null));
  if (!holder || !pidAlive(holder)) return false;
  // The lock is sometimes a child of the process we spawned (Chrome's zygote),
  // not that process itself. Walk up a few parents before calling it someone else's.
  let cur: number | null = holder;
  for (let i = 0; i < 8 && cur && cur > 1; i++) {
    if (cur === pid) return true;
    cur = await pidParent(cur);
  }
  return false;
}

function handOffPage(exe: string, dir: string, target: string, display: string | null, n: number) {
  const child = spawn(exe, personArgs(dir, target, display), {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: display ? { ...process.env, DISPLAY: display } : process.env,
  });
  running.add(child);
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2_000)));
  child.on('error', e => console.error(`[browser] Profile ${n}: handing ${target} to the open browser failed:`, e.message));
  child.on('exit', (code, signal) => {
    running.delete(child);
    // Exiting is what a handoff does once the open browser has the page. Anything
    // else means the page never arrived, and the browser we track is still the window.
    if (code !== 0) console.error(`[browser] Profile ${n}: handing ${target} to the open browser failed (code ${code ?? 'none'}${signal ? `, ${signal}` : ''}).${stderr.trim() ? ` ${stderr.trim()}` : ''}`);
  });
}

async function lockHolder(dir: string) {
  return singletonPid(await readlink(join(dir, 'SingletonLock')).catch(() => null));
}

export async function openProfileWindow(profile = 1, url = 'https://www.google.com', onClosed?: { key: string; run: () => void }, request?: number) {
  const n = await knownProfile(profile);
  const target = checkUrl(url).toString();
  const exe = browserExe();
  if (!exe) throw noBrowser();
  return withProfile(n, () => openPersonWindow(n, exe, target, onClosed, request));
}

async function openPersonWindow(n: number, exe: string, target: string, onClosed?: { key: string; run: () => void }, request?: number) {
  const dir = personDir(n);
  const remember = () => onClosed && whenClosed.set(n, (whenClosed.get(n) ?? new Map()).set(onClosed.key, onClosed.run));
  const cur = personProcs.get(n);
  if (personOpen.has(n) && cur && !cur.exited()) {
    remember();
    const held = await profileHeld(dir, cur.pid, 0);
    if (!held) {
      const holder = await lockHolder(dir);
      console.error(`[browser] Profile ${n} is open as pid ${cur.pid ?? 'unknown'} but the profile lock is ${holder ?? 'absent'}.`);
      throw new Error(`Browser profile ${n} is still opening. Try again in a moment.`);
    }
    const sc = screens.get(n);
    if (CLOUD && !sc) throw new Error(`Browser profile ${n} is open, but its screen isn't being streamed. Close it and open it again.`);
    if (sc) Object.assign(sc, { url: target, request: request ?? sc.request });
    handOffPage(exe, dir, target, sc?.display ?? null, n);
    console.log(`[browser] Profile ${n}: handed ${target} to the open browser (pid ${cur.pid}).`);
    return { ok: true, profile: n, already: true, ...(sc ? { live: `screen:${n}` } : {}) };
  }
  if (personOpen.has(n)) {
    console.error(`[browser] Profile ${n} was marked open with no browser running. Clearing it.`);
    forgetPerson(n);
  }
  // Open from now (the agents' browser carries on beside it).
  let release = () => {};
  personOpen.set(n, new Promise<void>(r => (release = r)));
  personRelease.set(n, release);
  try {
    const seeded = await seedPersonDir(n);
    console.log(`[browser] Profile ${n}: the person's window starts with the agents' ${seeded} cookies.`);
    remember();
    await keepSignedIn(dir);
    await clearStaleLock(dir);
    const display = CLOUD ? await displayFor(n) : null;
    const started = Date.now();
    let stderr = '';
    const proc = spawn(exe, personArgs(dir, target, display), {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: display ? { ...process.env, DISPLAY: display } : process.env,
    });
    proc.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4_000)));
    running.add(proc);
    const tracked: PersonBrowser = { pid: proc.pid, spawned: proc, kill: () => proc.kill(), exited: () => proc.exitCode !== null };
    personProcs.set(n, tracked);
    if (display) screens.set(n, { profile: n, display, since: started, url: target, request });
    console.log(`[browser] Profile ${n}: opening ${target}${display ? ` on ${display}` : ''} (pid ${proc.pid ?? 'unknown'}).`);
    let settled = false;
    const onGone = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      void withProfile(n, async () => {
        running.delete(proc);
        if (personProcs.get(n)?.spawned !== proc) return;
        const holder = await lockHolder(dir);
        if (holder && personWindowAfterExit(proc.pid, holder, pidAlive(holder)) === 'keep') {
          console.error(`[browser] Profile ${n}: the browser we started (pid ${proc.pid}) exited (${code ?? 'none'}${signal ? `, ${signal}` : ''}) and Chrome kept the profile as pid ${holder}. Still streaming that screen.`);
          personProcs.set(n, adopt(n, holder));
          return;
        }
        if (code !== 0 && code !== null) console.error(`[browser] Profile ${n} closed (code ${code}${signal ? `, ${signal}` : ''}).${stderr.trim() ? ` ${stderr.trim()}` : ''}`);
        else console.log(`[browser] Profile ${n} closed.`);
        forgetPerson(n);
      });
    };
    proc.once('exit', onGone);
    proc.once('error', e => {
      console.error(`[browser] Profile ${n} failed to start:`, e.message);
      onGone(null, null);
    });
    const deadline = started + 15_000;
    let held = false;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break;
      if (await profileHeld(dir, proc.pid, started)) {
        held = true;
        break;
      }
      await sleep(50);
    }
    if (!held) {
      const holder = await lockHolder(dir);
      if (holder && personWindowAfterExit(proc.pid, holder, pidAlive(holder)) === 'keep') {
        console.error(`[browser] Profile ${n}: pid ${proc.pid} never held the profile; pid ${holder} does. Streaming that screen.`);
        personProcs.set(n, adopt(n, holder));
        return { ok: true, profile: n, already: false, ...(display ? { live: `screen:${n}` } : {}) };
      }
      throw new Error(`Browser profile ${n} didn't open${proc.exitCode !== null ? ` (the browser exited with code ${proc.exitCode})` : ''}.${stderr.trim() ? ` ${stderr.trim()}` : ''}`);
    }
    return { ok: true, profile: n, already: false, ...(display ? { live: `screen:${n}` } : {}) };
  } catch (e) {
    console.error(`[browser] Opening profile ${n} at ${target} failed:`, (e as Error).message);
    const proc = personProcs.get(n);
    if (proc?.spawned && proc.spawned.exitCode === null) {
      proc.kill();
      await Promise.race([new Promise<void>(r => proc.spawned?.once('exit', () => r())), sleep(2_000)]);
    } else if (proc && !proc.spawned) proc.kill();
    forgetPerson(n, false);
    throw e;
  }
}

export async function profileStatus() {
  const profiles = await listProfiles();
  const counts = new Map<string, number>();
  for (const r of listPasswords()) counts.set(`${r.profile}`, (counts.get(`${r.profile}`) ?? 0) + 1);
  const now = new Map<number, Shared>();
  for (const [n, p] of shared) {
    const s = await p.catch(() => null);
    if (s) now.set(n, s);
  }
  const open = (n: number) => personOpen.has(n);
  const inUse = (n: number) => (now.get(n)?.runs.size ?? 0) > 0;
  return {
    // Kept for older screens: profile 1.
    open: open(1),
    inUse: inUse(1),
    profiles: profiles.map(n => ({ n, open: open(n), inUse: inUse(n), accounts: counts.get(`${n}`) ?? 0 })),
  };
}
