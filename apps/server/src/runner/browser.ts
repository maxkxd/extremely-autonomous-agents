import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Cdp, CdpPage, FRAME_BASE, KEYS, type Bounds, type Key } from './cdp.js';
import { checkUrl, isPrivateIp } from './net.js';
import { fileRequest, inWorkspace, onApprovalSettled, onRunEnd, registerTools, tooManyWaiting, type RunCtx, type ToolDef } from './tools.js';
import { all, one, run as exec } from './db.js';
import { setKeptPageCheck } from './kept-pages.js';
import { ACCOUNTS_PER_SITE, listPasswords, makePassword, passwordRow, profileFor, readPassword, savePassword, siteOf } from './passwords.js';
import { DATA_DIR } from '../paths.js';
import { deleteSecret, getSecret, setSecret } from '../vault.js';

// Browsing for agents (docs/integrations.md), on the Edge or Chrome already
// installed - nothing to download.
//
//   browser.*            a blank throwaway: a private window (no sign-ins, nothing
//                        kept) in the same browser
//   signed_in_browser.*  the agents' own profiles: separate, persistent browser
//                        profiles (never the person's own), signed in to sites by
//                        the person or by agents themselves - agents sign up for
//                        accounts, keeping each password in the password store
//                        (passwords.ts). Profile 1 first; a profile holds up to 10
//                        accounts on one site, and the next one gets a new profile.
//
// A page comes back as its text plus numbered buttons, links and fields; the agent
// clicks or types by number. The pages an agent's browser opens are checked like any
// agent fetch: never this computer or its network.
//
// A profile is one browser, the plain one, always running - the way World Asset
// Register runs its agents' Chrome: started once, kept for weeks, signed in once.
// Every agent run gets its own window in it, on screen (or, in the cloud, on the
// profile's own screen, streamed to the app), and the person uses that same browser
// like any other: watches the agents, clicks in their windows, and does what only a
// person can (a CAPTCHA, a code) in the very tab the agent left for them. Only
// Google's own sign-in needs the browser started without its debugging address
// (see "Signing in to Google").

export const PROFILES_DIR = join(DATA_DIR, 'browser-profiles');
const OLD_PROFILE_DIR = join(DATA_DIR, 'browser-profile'); // one profile, before there could be more
const profileDir = (n: number) => join(PROFILES_DIR, String(n));
const TEXT_CHARS = 8_000;
const MAX_ELEMENTS = 100;

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
// never offers to save passwords - the store does that. restore false: for Google's
// sign-in window, which mustn't open again every window the agents had.
async function keepSignedIn(dir: string, restore = true) {
  const file = join(dir, 'Default', 'Preferences');
  let prefs: Record<string, any> = {};
  try {
    prefs = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // a new profile
  }
  prefs.session = { ...(prefs.session ?? {}), restore_on_startup: restore ? 1 : 5 };
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

// --- A profile's browser, always running ------------------------------------------------
//
// A profile folder can only be open in one browser at a time, so there is one per
// profile, shared: each run gets its own window in it. It's the plain browser, started
// with a debugging address on this computer and driven over it one page at a time
// (cdp.ts). Agents' windows open on screen, behind what the person's doing - they can
// watch, and click in, any of them. It starts with no window (--no-startup-window) and
// keeps running with none between runs.
//
// It isn't closed when runs end, or when the app quits: like any browser it stays
// where it is, with the pages left in it for the person, and the app finds it again
// when it starts (its DevToolsActivePort file). It used to close a minute after the
// last run and with the app, taking every page an agent had kept for the person with
// it - "Finish 2 filled directory forms" opened blank forms.

type Shared = {
  pid?: number;
  proc?: ChildProcess; // the one we started this time, if we did
  cdp: Cdp;
  runs: Set<string>; // runs with a window open in it
  opening?: number; // agents' pages being made right now
};
const shared = new Map<number, Promise<Shared>>();
// Agents' windows one after another down and across, so each can be seen. In the
// cloud the profile's screen is the size of one, so each fills it.
let opened = 0;
const agentBounds = (): Bounds => {
  if (CLOUD) return { left: 0, top: 0, ...SCREEN };
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

async function profileBrowser(n: number): Promise<Shared> {
  const google = signingIn.get(n);
  if (google) throw new Error(`Browser profile ${n} is closed while the person signs in to Google in it (since ${new Date(google).toLocaleTimeString()}). Work on something else, and come back to the browser in a few minutes.`);
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

// The browser left running on the profile (by this app before it restarted): its
// debugging address, if it still answers.
async function findRunning(n: number): Promise<{ cdp: Cdp; pid?: number } | null> {
  const dir = profileDir(n);
  const [port, path] = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n').map(l => l.trim());
  if (!/^\d+$/.test(port ?? '') || !path?.startsWith('/devtools/browser/')) return null;
  const cdp = await Promise.race([Cdp.connect(`ws://127.0.0.1:${port}${path}`).catch(() => null), sleep(3_000).then(() => null)]);
  if (!cdp) return null;
  const pid = process.platform === 'win32' ? undefined : (singletonPid(await readlink(join(dir, 'SingletonLock')).catch(() => null)) ?? undefined);
  return { cdp, pid };
}

async function startProfile(n: number): Promise<Shared> {
  const exe = browserExe();
  if (!exe) throw noBrowser();
  const dir = profileDir(n);
  const found = await findRunning(n);
  if (found) {
    console.log(`[browser] Profile ${n}: found its browser still running${found.pid ? ` (pid ${found.pid})` : ''}.`);
    return attached(n, found.cdp, found.pid);
  }
  await keepSignedIn(dir);
  // One still shutting down goes first: two on one folder is twice the memory.
  await closing.get(n);
  await clearStaleLock(dir);
  // Held by a browser that doesn't answer (stuck, or one that isn't ours): ended, so this one can open it.
  const holder = process.platform === 'win32' ? null : singletonPid(await readlink(join(dir, 'SingletonLock')).catch(() => null));
  if (holder && pidAlive(holder)) {
    console.error(`[browser] Profile ${n} is held by pid ${holder}, which doesn't answer. Ending it.`);
    try {
      process.kill(holder, 'SIGKILL');
    } catch {}
    await sleep(1_000);
    await clearStaleLock(dir);
  }
  const display = CLOUD ? await displayFor(n) : null;
  // The browser writes its debugging port (and its address) here once it's listening.
  const portFile = join(dir, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  // Its own process group, not ended with the app (see above).
  const proc = spawn(exe, [`--user-data-dir=${dir}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', ...PROFILE_FLAGS, ...(display ? ['--window-position=0,0', `--window-size=${SCREEN.width},${SCREEN.height}`] : []), ...EXTRA_FLAGS], {
    stdio: 'ignore',
    windowsHide: false,
    detached: true,
    env: display ? { ...process.env, DISPLAY: display } : process.env,
  });
  proc.unref();
  if (proc.pid) ours.add(proc.pid);
  let exited = false;
  proc.on('error', e => {
    exited = true;
    console.error(`[browser] Profile ${n} (agents) failed to start:`, e.message);
  });
  proc.on('exit', (code, signal) => {
    exited = true;
    if (code !== 0 && code !== null) console.error(`[browser] Profile ${n} (agents) exited (code ${code}${signal ? `, ${signal}` : ''}).`);
    else console.log(`[browser] Profile ${n} (agents) exited${signal ? ` (${signal})` : ''}.`);
  });
  let port = 0;
  let path = '';
  for (let i = 0; i < 200 && !port && !exited; i++) {
    const [first, second] = (await readFile(portFile, 'utf8').catch(() => '')).split('\n').map(l => l.trim());
    if (/^\d+$/.test(first ?? '') && second?.startsWith('/devtools/browser/')) [port, path] = [Number(first), second];
    else await sleep(100);
  }
  if (!port) {
    if (proc.pid) ours.delete(proc.pid);
    proc.kill();
    throw new Error(exited ? `Browser profile ${n} is open in a browser window the app didn't start (one left from before an update, say). Close that window and try again.` : `Browser profile ${n} didn't start. Try again.`);
  }
  const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
  await restoreSessionCookies(cdp, n);
  await addCarriedCookies(cdp, n);
  return attached(n, cdp, proc.pid, proc);
}

function attached(n: number, cdp: Cdp, pid?: number, proc?: ChildProcess): Shared {
  const s: Shared = { pid, proc, cdp, runs: new Set() };
  if (pid) ours.add(pid);
  // Closed (by the person, or it crashed): the next run starts it again.
  cdp.onClose(() => {
    if (pid) ours.delete(pid);
    void shared.get(n)?.then(cur => cur === s && shared.delete(n), () => {});
  });
  void adoptKeptPages(n, s).catch(e => console.error(`[browser] Profile ${n}: finding the pages kept for the person failed:`, (e as Error).message));
  return s;
}
const ours = new Set<number>(); // the profiles' browsers' pids, for the leftovers sweep

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
  killTree(proc.pid);
  await Promise.race([gone, new Promise(r => setTimeout(r, 2_000).unref())]);
}
function killTree(pid?: number) {
  if (!pid) return;
  try {
    process.kill(GROUPS ? -pid : pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}

// Closed on purpose (the Doctor freeing memory, Google's sign-in): sign-ins kept.
function closeShared(n: number, s: Shared) {
  void shared.get(n)?.then(cur => cur === s && shared.delete(n), () => {});
  const ask = async () => {
    await keepSessionCookies(s.cdp, n).catch(e => console.error(`[browser] Profile ${n}: keeping the session before closing failed:`, (e as Error).message));
    await s.cdp.send('Browser.close');
  };
  const done = (async () => {
    if (s.proc) return endBrowser(s.proc, ask);
    // Found running (started before the app last restarted): no process of ours to wait on.
    await Promise.race([ask().catch(() => {}), sleep(CLOSE_DEADLINE_MS)]);
    for (let i = 0; i < 50 && s.pid && pidAlive(s.pid); i++) await sleep(200);
    if (s.pid && pidAlive(s.pid)) killTree(s.pid);
  })();
  closing.set(n, done);
  void done.finally(() => closing.get(n) === done && closing.delete(n));
  return done;
}

// Nothing an agent's browser opens on this computer or its network.
function allowUrl() {
  const verdicts = new Map<string, boolean>();
  return async (raw: string) => {
    if (raw.startsWith('data:') || raw.startsWith('blob:') || raw === 'about:blank') return true;
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

// --- Sessions, one per run, kind and profile ------------------------------------------

// blank: a private window (a browser context of its own: nothing signed in, gone when
// it closes) in profile 1's browser. profile: its own window in the profile's browser.
// openers: when it's working in a window a site opened, the pages behind it, oldest first.
type Driver = CdpPage;
type Windows = { page: Driver; cdp?: CdpPage; openers?: CdpPage[]; followed?: Set<string>; windowClosed?: boolean };
type Session = Windows & { kind: 'blank' | 'profile'; runId: string; profile: number; context?: string; agent?: { id: string; name: string }; request?: number };
const sessions = new Map<string, Session>();
const BLANK_HOST = 1; // the profile whose browser holds the throwaway windows

// Two tool calls at once share one opening, and one that finishes after its run
// ended closes again: either way a browser used to be left running with nobody's
// run to close it.
const sessionOpening = new Map<string, Promise<Session>>();
const endedRuns = new Set<string>();
async function session(ctx: RunCtx, kind: Session['kind'], profile = 1): Promise<Session> {
  const key = `${ctx.runId}:${kind}:${kind === 'profile' ? profile : 0}`;
  const existing = sessions.get(key);
  if (existing && backFromClosedWindow(existing)) existing.windowClosed = true;
  if (existing && !existing.page.isClosed()) {
    if (existing.cdp) await untilFree(existing.cdp);
    return existing;
  }
  if (existing) await closeSession(key);
  // A page a person approved a click on, back with this agent to finish the job.
  if (kind === 'profile' && !ctx.approved) {
    const back = [...waitingPages.entries()].find(([, w]) => w.resume === ctx.agent.id && sessions.get(w.key)?.profile === profile && !sessions.get(w.key)!.page.isClosed());
    if (back) {
      const [id, w] = back;
      waitingPages.delete(id);
      const s = sessions.get(w.key)!;
      sessions.delete(w.key);
      const sh = await shared.get(profile)?.catch(() => null);
      sh?.runs.delete(w.key);
      sh?.runs.add(ctx.runId);
      Object.assign(s, { runId: ctx.runId, request: undefined });
      sessions.set(key, s);
      return s;
    }
  }
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
  const n = kind === 'blank' ? BLANK_HOST : profile;
  const sh = await profileBrowser(n);
  sh.runs.add(ctx.runId);
  sh.opening = (sh.opening ?? 0) + 1;
  let context: string | undefined;
  try {
    if (kind === 'blank') context = (await sh.cdp.send<{ browserContextId: string }>('Target.createBrowserContext', { disposeOnDetach: false })).browserContextId;
    const page = await CdpPage.open(sh.cdp, agentBounds(), 'about:blank', context).finally(() => sh.opening!--);
    agentMade.add(page.targetId);
    saveKept();
    await page.guard(allowUrl());
    s = { kind, runId: ctx.runId, profile: kind === 'blank' ? 0 : profile, context, page, cdp: page, agent: { id: ctx.agent.id, name: ctx.agent.name } };
  } catch (e) {
    sh.runs.delete(ctx.runId);
    if (context) await sh.cdp.send('Target.disposeBrowserContext', { browserContextId: context }).catch(() => {});
    throw e;
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
  const n = s.kind === 'blank' ? BLANK_HOST : s.profile;
  const sh = await shared.get(n)?.catch(() => null);
  if (sh && s.kind === 'profile') await keepSessionCookies(sh.cdp, n).catch(() => {});
  await s.page.close().catch(() => {});
  for (const o of s.openers ?? []) await o.close().catch(() => {});
  for (const p of [s.cdp, ...(s.openers ?? [])]) if (p) agentMade.delete(p.targetId);
  saveKept();
  if (!sh) return;
  if (s.context) await sh.cdp.send('Target.disposeBrowserContext', { browserContextId: s.context }).catch(() => {});
  sh.runs.delete(s.runId);
  await closeStrayPages(n, sh).catch(() => 0);
}

// Pages no run is driving: a site's popup or new tab ("Sign in with Google", a
// link that opens a window), left after the run that caused it ended. Each kept a
// renderer - and its memory - for as long as the browser ran, which with agents
// always working was for ever: twenty of them held 2.5 GB in the cloud. A popup
// whose run is still going stays (a sign-in completing in it). Checked when a run
// ends and with the leftovers sweep.
// agentMade: on the person's own screen the browser is theirs to use too, so only
// pages agents made (and the popups they opened) are cleared - never a tab the person
// opened themselves. In the cloud nobody opens one except through the app.
export function strayPages(targets: { targetId: string; type: string; openerId?: string }[], live: Set<string>, agentMade?: Set<string>) {
  return targets
    .filter(t => t.type === 'page' && !live.has(t.targetId) && !(t.openerId && live.has(t.openerId)))
    .filter(t => !agentMade || t.openerId || agentMade.has(t.targetId))
    .map(t => t.targetId);
}
const liveTargets = (n: number) =>
  new Set([
    ...[...sessions.values()].filter(x => (x.kind === 'blank' ? BLANK_HOST : x.profile) === n).flatMap(x => [x.cdp, ...(x.openers ?? [])]).filter((p): p is CdpPage => !!p && !p.isClosed()).map(p => p.targetId),
    ...[...personPages.values()].filter(p => p.profile === n).map(p => p.targetId),
  ]);
async function closeStrayPages(n: number, sh: Shared) {
  if (sh.opening) return 0; // a page being made isn't a run's yet: next time
  const { targetInfos } = await sh.cdp.send<{ targetInfos: { targetId: string; type: string; openerId?: string }[] }>('Target.getTargets');
  if (sh.opening) return 0;
  const live = liveTargets(n);
  const stray = strayPages(targetInfos, live, CLOUD ? undefined : agentMade);
  for (const targetId of stray) {
    await sh.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    agentMade.delete(targetId);
  }
  if (stray.length) saveKept();
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

// Leftovers, checked every few minutes where there's a `ps` (Linux: the cloud). A
// browser on an agents' profile folder that isn't the one the app is using is ended:
// nothing else would.
export function leftoverBrowsers(ps: string, ours: Set<number>) {
  const out: number[] = [];
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [pid, args] = [Number(m[1]), m[3]];
    if (ours.has(pid) || args.includes('--type=')) continue; // renderers and the like go with their browser
    const dir = /--user-data-dir=(\S+)/.exec(args)?.[1];
    if (dir?.startsWith(PROFILES_DIR) && /^\d+$/.test(dir.slice(PROFILES_DIR.length + 1))) out.push(pid);
  }
  return out;
}
const SWEEP_MS = 5 * 60_000;
const psList = () => new Promise<string>(r => execFile('ps', ['-eo', 'pid=,ppid=,args='], { maxBuffer: 16 << 20 }, (err, out) => r(err ? '' : out)));
async function findLeftovers() {
  if (process.platform !== 'linux') return [];
  const mine = new Set(ours);
  for (const p of running) if (p.pid) mine.add(p.pid);
  if (personWindow?.pid) mine.add(personWindow.pid);
  for (const sh of await Promise.all([...shared.values()].map(p => p.catch(() => null)))) if (sh?.pid) mine.add(sh.pid);
  return leftoverBrowsers(await psList(), mine);
}
async function endLeftovers() {
  const pids = await findLeftovers();
  for (const pid of pids) {
    console.error(`[browser] Ending a leftover browser (pid ${pid}).`);
    killTree(pid);
  }
  return pids;
}
setInterval(() => {
  if (process.platform === 'linux') void endLeftovers();
  for (const [n, p] of shared) void p.then(sh => closeStrayPages(n, sh), () => 0).catch(() => 0);
}, SWEEP_MS).unref();

// What the app starts besides the browsers (a virtual screen, Google's sign-in
// window), ended when it quits.
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

// What the Doctor and the Agency Engineer see of the browsers, and can clear (host.ts).
export async function browserCensus() {
  const agents: { profile: number; pid?: number; runs: number; pages: number; stray: number }[] = [];
  for (const [n, p] of shared) {
    const s = await p.catch(() => null);
    if (!s) continue;
    const { targetInfos } = await s.cdp.send<{ targetInfos: { targetId: string; type: string; openerId?: string }[] }>('Target.getTargets').catch(() => ({ targetInfos: [] }));
    const live = liveTargets(n);
    agents.push({ profile: n, pid: s.pid, runs: s.runs.size, pages: targetInfos.filter(t => t.type === 'page').length, stray: strayPages(targetInfos, live, CLOUD ? undefined : agentMade).length });
  }
  return {
    agents,
    personWindows: personWindow ? [{ profile: personWindow.profile, pid: personWindow.pid }] : [],
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
    // In use, or holding pages kept for the person: only its strays.
    if (s.runs.size) {
      pages += await closeStrayPages(n, s).catch(() => 0);
      continue;
    }
    await closeShared(n, s);
    closed.push(n);
  }
  return { ended, closed, pages };
}

// A click waiting for a person (click_to_pay, _post, _start_tool) gets its page to
// itself. Queueing it sets the run's page aside - the form filled in, the numbers it
// was given - and the agent's next browser step opens a fresh page, so carrying on
// can't move the page under the waiting click. (Kept on the run's own page, an
// approved "Create pull request" clicked whatever the agent had opened since: four
// approved GitHub posts landed on a license link on another repository.) The page
// closes once its click is decided, after a day, or if no approval took it.
const WAIT_MAX_MS = 24 * 3_600_000;
const WAIT_MAX = 8;
const UNCLAIMED_MS = 2 * 60_000;
// A page kept for the person (a CAPTCHA, then Submit) waits for them far longer: it's
// a tab in a browser that stays open, and they may not look for days.
const PERSON_MAX_MS = 7 * 24 * 3_600_000;
const PERSON_MAX = 20;
// person: kept for a person to finish, and the request it's for (show_person files it).
type KeptFor = { profile: number; site: string; url: string; request?: number; agent?: { id: string; name: string } };
// resume: approved, and back with the agent that queued it, to finish the job (its next run takes it).
type Waiting = { key: string; runId: string; since: number; person?: KeptFor; resume?: string };
const waitingPages = new Map<string, Waiting>(); // by page id (the approval's _page)
setKeptPageCheck(id => waitingPages.has(id));
const pendingFor = (pageId: string) =>
  !!one("SELECT 1 FROM approvals WHERE status = 'pending' AND tool LIKE 'signed_in_browser.click_to_%' AND json_extract(args, '$._page') = ? LIMIT 1", pageId);

// Which set-aside pages to close: decided (or never queued) ones, ones past a day,
// and past WAIT_MAX the oldest - each holds memory. Approved after that, its agent
// hears to redo the steps.
export function pagesToLetGo(waits: { id: string; since: number }[], pending: (id: string) => boolean, now: number, max = WAIT_MAX, maxMs = WAIT_MAX_MS, unclaimedMs = UNCLAIMED_MS) {
  const go = new Set<string>();
  for (const w of waits) if (now - w.since > maxMs || (now - w.since > unclaimedMs && !pending(w.id))) go.add(w.id);
  const kept = waits.filter(w => !go.has(w.id)).sort((a, b) => a.since - b.since);
  for (const w of kept.slice(0, Math.max(0, kept.length - max))) go.add(w.id);
  return [...go];
}
async function letGoOf(ids: string[], why?: string) {
  for (const id of ids) {
    const w = waitingPages.get(id);
    waitingPages.delete(id);
    if (!w) continue;
    await closeSession(w.key);
    if (w.person && why) void keptPageLost(w.person, why);
  }
  saveKept();
}
const inPersonsHands = (w: Waiting) => {
  const id = sessions.get(w.key)?.cdp?.targetId;
  return !!id && heldSince(id) != null;
};
// Kept for a request that's closed now: the Engineer, the Doctor or a pack settles one
// without the request's button (not through answerRequest), and its page stayed listed
// as waiting on the person - #176's was, done already.
export const keptForClosed = (waits: { id: string; request?: number }[], open: (request: number) => boolean) =>
  waits.filter(w => w.request != null && !open(w.request)).map(w => w.id);
const requestOpen = (request: number) => !!one("SELECT 1 FROM requests WHERE id = ? AND status = 'open'", request);

const checkWaiting = async () => {
  const now = Date.now();
  const settled = keptForClosed([...waitingPages.entries()].map(([id, w]) => ({ id, request: w.person?.request })), requestOpen);
  if (settled.length) await letGoOf(settled);
  const free = [...waitingPages.entries()].filter(([, w]) => !inPersonsHands(w));
  // Closed by the person (or the browser): their request is done, or the page is gone.
  const shut = free.filter(([, w]) => w.person && sessions.get(w.key)?.page.isClosed());
  for (const [id, w] of shut) void (sessions.get(w.key)?.page.browserGone() ? letGoOf([id], 'the browser closed') : finishKept(id, 'closed'));
  await letGoOf(pagesToLetGo(free.filter(([, w]) => !w.person).map(([id, w]) => ({ id, since: w.since })), id => pendingFor(id) || !!waitingPages.get(id)?.resume, now));
  await letGoOf(
    pagesToLetGo(free.filter(([id, w]) => w.person && !shut.some(([x]) => x === id)).map(([id, w]) => ({ id, since: w.since })), () => true, now, PERSON_MAX, PERSON_MAX_MS),
    'it waited too long, or too many pages were waiting',
  );
};

// A kept page the person closed (with the request's button or without): answered
// within a couple of seconds, not at the next sweep. Only a flag is read, no browser call.
let keptWatch: ReturnType<typeof setInterval> | undefined;
function watchKept() {
  if (keptWatch) return;
  keptWatch = setInterval(() => {
    const kept = [...waitingPages.entries()].filter(([, w]) => w.person);
    for (const [id, w] of kept) {
      const page = sessions.get(w.key)?.page;
      if (!page?.isClosed()) continue;
      // The whole browser went: the page didn't get done, it went with it.
      if (page.browserGone()) void letGoOf([id], 'the browser closed');
      else void finishKept(id, 'closed');
    }
    if (!kept.length) {
      clearInterval(keptWatch);
      keptWatch = undefined;
    }
  }, 2_000);
  keptWatch.unref?.();
}

// The run's page in this profile, set aside for a click being queued on it.
async function setAside(ctx: RunCtx, profile: number, ref: number) {
  const key = `${ctx.runId}:profile:${profile}`;
  const s = sessions.get(key);
  if (!s || !s.cdp || s.page.isClosed()) throw new Error('There is no page open in the browser to click on. Open the page, fill it in, then queue the click.');
  if (!(await s.cdp.evaluateFor<boolean>(ref, inPage(`find(${ref}) !== null`)))) throw new Error(`There's no [${ref}] on the page now - look at it again (scroll, or open it) and use a number from what you see.`);
  const id = await moveAside(ctx.runId, key, s, profile);
  return { _page: id, _url: await s.page.url() };
}
async function moveAside(runId: string, key: string, s: Session, profile: number, person?: KeptFor, since = Date.now(), id = `wp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`) {
  const own = `wait:${id}`;
  sessions.delete(key);
  // Its own user of the shared browser, so the run ending doesn't close the browser under it.
  sessions.set(own, { ...s, runId: own, request: person?.request });
  const sh = await shared.get(profile)?.catch(() => null);
  sh?.runs.add(own);
  waitingPages.set(id, { key: own, runId, since, person });
  saveKept();
  if (person) watchKept();
  setTimeout(() => void checkWaiting(), UNCLAIMED_MS + 1_000).unref();
  void checkWaiting();
  return id;
}

// What only a person can do on a page the agent has filled in (a CAPTCHA, a code): the
// page itself waits for them - the tab stays where it is in the agents' browser, and
// the request it's filed with brings them straight to it. They do the check, press
// Submit, and close the tab (or press Done on the request).
const siteOfUrl = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};
export const BROWSER_LINE = (url: string, profile: number) => `Open in signed-in browser: ${url}${profile !== 1 ? ` (profile ${profile})` : ''}`;

// The agent's request for it: one per page - a second show_person on the same address
// is the same request.
function requestFor(ctx: RunCtx, profile: number, url: string, what: string, why: string): { id: number; isNew: boolean } | string {
  const line = BROWSER_LINE(url, profile);
  const open = all<{ id: number; evidence: string | null }>("SELECT id, evidence FROM requests WHERE agent_id = ? AND status = 'open' AND evidence LIKE ?", ctx.agent.id, `%${line}%`);
  if (open[0]) return { id: open[0].id, isNew: false };
  const full = tooManyWaiting(ctx.agent.id);
  if (full) return full;
  const id = fileRequest(ctx.agent.id, ctx.runId, { what, why, evidence: `${line}\nThe page is kept as the agent left it: press the button to go straight to that tab in the agents' browser, do what's asked, then close the tab (or press Done here).` }, ctx.now(), ctx.wake);
  // It's the person's to do, not the Engineer's to work out: straight to them.
  exec("UPDATE requests SET stage = 'person' WHERE id = ? AND joined_to IS NULL", id);
  return { id, isNew: true };
}

async function keepForPerson(ctx: RunCtx, profile: number, what: string, why: string) {
  const key = `${ctx.runId}:profile:${profile}`;
  const s = sessions.get(key);
  if (!s?.cdp || s.page.isClosed()) throw new Error('There is no page open in your browser to keep. Open the page, fill in everything you can, then call show_person.');
  const url = await s.page.url().catch(() => '');
  const site = siteOfUrl(url);
  if (!site) throw new Error("This page has no web address to keep. Open the page you need the person on first.");
  const r = requestFor(ctx, profile, url, what, why);
  if (typeof r === 'string') return r;
  // Kept before for this request (the agent filled it in again): the new page replaces it.
  for (const [id, w] of waitingPages) if (w.person?.request === r.id) await letGoOf([id]);
  await moveAside(ctx.runId, key, s, profile, { profile, site, url, request: r.id, agent: s.agent });
  return `This page is kept for the person exactly as it is, in its own tab in profile ${profile}, and ${r.isNew ? `request #${r.id} is filed` : `request #${r.id} (already filed) points to it now`} with a button that brings them straight to it. Your next browser step starts on a new page. Don't file another request for this. You'll hear when they're done: then open the site again and check it worked.`;
}

// Where the app shows a kept page: on the person's own screen its window, brought in
// front (no live view); in the cloud the kept tab itself, streamed on its own. (It was
// the profile's whole screen, but with no window manager nothing raises a window there:
// the button showed whichever agent's page was on top, and the kept one never.)
export const keptPageView = (cloud: boolean, tab: string) => (cloud ? { live: tab, tab } : { tab });

// The request's button: the page kept for it, if there is one - this request's own
// first, then the newest kept on that site.
export async function takeKeptPage(profile: number, url: string, request?: number) {
  const site = siteOfUrl(url);
  const usable = [...waitingPages.values()].filter(w => w.person?.profile === profile && sessions.get(w.key)?.cdp && !sessions.get(w.key)!.page.isClosed());
  const kept =
    (request != null ? usable.find(w => w.person!.request === request) : undefined) ??
    usable.filter(w => w.person!.site === site && (w.person!.request == null || request == null || w.person!.request === request)).sort((a, b) => b.since - a.since)[0];
  if (!kept) return null;
  const s = sessions.get(kept.key)!;
  if (request != null && kept.person!.request == null) kept.person!.request = request;
  s.request = kept.person!.request;
  hold(s.cdp!.targetId);
  await s.cdp!.bringToFront().catch(() => {});
  return keptPageView(CLOUD, s.cdp!.targetId);
}

// The person's done with a kept page (closed its tab, or pressed Done): its request is
// answered, which tells the agent that kept it - not the Engineer, who'd only pass it on.
let personDone: (request: number, text: string) => void = () => {};
export const onPersonDone = (fn: typeof personDone) => void (personDone = fn);
async function finishKept(id: string, how: 'closed' | 'done') {
  const w = waitingPages.get(id);
  if (!w?.person) return;
  await letGoOf([id]);
  if (w.person.request != null)
    personDone(w.person.request, `${how === 'closed' ? 'Closed' : 'Finished with'} the page kept for this on ${w.person.site}. Open ${w.person.url} again and check it worked.`);
}
export async function finishKeptPage(targetId: string) {
  const found = [...waitingPages.entries()].find(([, w]) => w.person && sessions.get(w.key)?.cdp?.targetId === targetId);
  if (found) await finishKept(found[0], 'done');
}
// A request answered (done, or turned down): the page kept for it is no longer needed.
export async function releaseKeptFor(request: number) {
  await letGoOf([...waitingPages.entries()].filter(([, w]) => w.person?.request === request).map(([id]) => id));
}

// A kept page gone before the person got to it (the browser closed, it waited too
// long): the request says so, and the agent hears, to fill it in and keep it again.
async function keptPageLost(p: KeptFor, why: string) {
  if (p.request == null) return;
  const open = one<{ agent_id: string }>("SELECT agent_id FROM requests WHERE id = ? AND status = 'open'", p.request);
  if (!open) return;
  const { postToRequest } = await import('./engineer.js');
  const { book } = await import('./scheduler.js');
  postToRequest(p.request, 'engineer', `The page kept for this on ${p.site} closed before it was done (${why}). The agent will fill it in again; the button opens ${p.site} meanwhile.`);
  book(open.agent_id, 'request reply', `The page you kept for the person for request #${p.request} on ${p.site} closed before they got to it (${why}). Open ${p.url} again, fill it in, and call signed_in_browser.show_person: the same request points to the new page.`);
}

// --- Kept across restarts --------------------------------------------------------------
//
// The browser outlives the app, so the pages kept for the person do too: which tab is
// which request's is written down here, and picked up again when the app finds the
// browser. So are the agents' own windows, so the ones a restart left behind (their
// runs ended with it) are closed then - and only those, never a tab the person opened.
const KEPT_FILE = join(PROFILES_DIR, 'kept-pages.json');
type KeptRecord = KeptFor & { id: string; runId: string; since: number; targetId: string };
const agentMade = new Set<string>(); // agents' windows this time (and popups they opened)
let fromBefore: { kept: KeptRecord[]; agentMade: string[] } | null = null;
let saving: ReturnType<typeof setTimeout> | undefined;
function saveKept() {
  clearTimeout(saving);
  saving = setTimeout(() => {
    const kept: KeptRecord[] = [];
    for (const [id, w] of waitingPages) {
      const targetId = sessions.get(w.key)?.cdp?.targetId;
      if (w.person && targetId) kept.push({ ...w.person, id, runId: w.runId, since: w.since, targetId });
    }
    // What's still to be picked up from before counts too, until it has been.
    for (const k of fromBefore?.kept ?? []) if (!kept.some(x => x.id === k.id)) kept.push(k);
    const made = [...agentMade, ...(fromBefore?.agentMade ?? [])];
    void writeFile(KEPT_FILE, JSON.stringify({ kept, agentMade: made })).catch(e => console.error('[browser] Writing the kept pages failed:', (e as Error).message));
  }, 300);
  saving.unref?.();
}
async function readKept() {
  if (fromBefore) return fromBefore;
  try {
    const f = JSON.parse(await readFile(KEPT_FILE, 'utf8'));
    fromBefore = { kept: Array.isArray(f.kept) ? f.kept : [], agentMade: Array.isArray(f.agentMade) ? f.agentMade : [] };
  } catch {
    fromBefore = { kept: [], agentMade: [] };
  }
  return fromBefore;
}
// The profile's browser found or started: its kept pages back in place, its leftover agent windows closed.
async function adoptKeptPages(n: number, sh: Shared) {
  const before = await readKept();
  const mine = before.kept.filter(k => k.profile === n);
  const { targetInfos } = await sh.cdp.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>('Target.getTargets');
  const there = new Map(targetInfos.filter(t => t.type === 'page').map(t => [t.targetId, t]));
  for (const k of mine) {
    before.kept = before.kept.filter(x => x !== k);
    if (!there.has(k.targetId)) {
      void keptPageLost(k, 'the browser closed');
      continue;
    }
    try {
      const page = await CdpPage.attach(sh.cdp, k.targetId);
      await page.guard(allowUrl());
      const key = `restored:${k.id}`;
      sessions.set(key, { kind: 'profile', runId: key, profile: n, page, cdp: page, agent: k.agent });
      await moveAside(k.runId, key, sessions.get(key)!, n, { profile: n, site: k.site, url: k.url, request: k.request, agent: k.agent }, k.since, k.id);
      there.delete(k.targetId);
    } catch (e) {
      console.error(`[browser] Profile ${n}: picking up the page kept for request #${k.request ?? '?'} failed:`, (e as Error).message);
      void keptPageLost(k, 'the browser restarted');
    }
  }
  const leftover = before.agentMade.filter(id => there.has(id));
  before.agentMade = before.agentMade.filter(id => !leftover.includes(id));
  for (const targetId of leftover) await sh.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  if (mine.length || leftover.length) console.log(`[browser] Profile ${n}: picked up ${mine.length} kept page(s), closed ${leftover.length} window(s) left from before.`);
  saveKept();
}
// Kept pages from before: their browsers found (or started) now, so they're back
// before anyone presses a request's button.
void readKept().then(b => {
  for (const n of new Set(b.kept.map(k => k.profile))) void profileBrowser(n).catch(e => console.error(`[browser] Profile ${n}: starting it for its kept pages failed:`, (e as Error).message));
});

async function closeSessions(runId: string) {
  endedRuns.add(runId);
  setTimeout(() => endedRuns.delete(runId), 30 * 60_000).unref();
  for (const key of [...sessions.keys()]) if (key.startsWith(`${runId}:`)) await closeSession(key);
}
onRunEnd(closeSessions);
onApprovalSettled(() => checkWaiting());
setInterval(() => void checkWaiting(), SWEEP_MS).unref();

// --- What the agent sees --------------------------------------------------------------

// Runs in the page (installed once per document as window.__eaa): numbers its
// visible controls and reads its text. Plain JavaScript in a string, because the
// TypeScript loader adds helpers to compiled functions that don't exist inside the
// page. (A password field's value is never read: it may be one from the store.)
//
// - A number stays with its control while the page changes around it, and one whose
//   control the page drew again (a form re-rendering after each keystroke) is found
//   again by what it was - its kind, label and name. Most "There's no [15] on the
//   page now" failures were that.
// - Every visible control is numbered; the list shows the ones nearest what's on
//   screen and says how many more are further up or down, so a Submit past the
//   first screenfuls is reached by scrolling (the list used to stop at the page's
//   first 80, wherever you scrolled).
// - A text field shows what's in it. Custom menus (comboboxes, their options, menu
//   items) are listed like any control.
const PAGE_HELPERS = `(() => {
  if (window.__eaa) return window.__eaa;
  const textOf = s => (s || '').replace(/\\s+/g, ' ').trim();
  const visible = e => {
    const r = e.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const s = getComputedStyle(e);
    return s.visibility !== 'hidden' && s.display !== 'none';
  };
  const tickable = e => !!e && e.tagName === 'INPUT' && (e.type === 'radio' || e.type === 'checkbox');
  const isFile = e => !!e && e.tagName === 'INPUT' && e.type === 'file';
  const isSelect = e => e.tagName === 'SELECT';
  const typable = e => (e.tagName === 'INPUT' && !tickable(e) && !['button', 'submit', 'reset', 'image', 'file', 'range', 'color'].includes(e.type)) || e.tagName === 'TEXTAREA' || e.isContentEditable;
  const labelOf = e => (e.labels && e.labels[0] ? e.labels[0].innerText : '');
  // A button that's only an icon: what the icon is (a pop-up's close button is often
  // just an X drawn in SVG - listed as button "" it read as nothing to click).
  const X_PATH = /M6 18L18 6M6 6l12 12|M18 6 6 18|m6 6 12 12|M18 6L6 18M6 6l12 12/i;
  const iconOf = e => {
    if (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT') return '';
    const img = e.querySelector('img[alt]');
    if (img && img.alt.trim()) return img.alt;
    const svg = e.querySelector('svg');
    if (!svg) return '';
    const t = svg.querySelector('title');
    if (t && t.textContent.trim()) return t.textContent;
    const lucide = /lucide-([a-z0-9-]+)/.exec(svg.getAttribute('class') || '');
    const name = lucide ? lucide[1].replace(/-/g, ' ') : '';
    if (name === 'x' || name === 'circle x' || [...svg.querySelectorAll('path')].some(d => X_PATH.test(d.getAttribute('d') || ''))) return 'close (x icon)';
    return name ? name + ' (icon)' : '';
  };
  const label = e => textOf(
    e.getAttribute('aria-label') || e.placeholder ||
    (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || isSelect(e) ? labelOf(e) : '') ||
    e.getAttribute('title') ||
    (isSelect(e) || typable(e) ? '' : e.innerText) ||
    (e.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(e.type) ? e.value : '') ||
    e.getAttribute('name') || iconOf(e) || ''
  ).slice(0, 80);
  const SEL = 'a[href], button, input:not([type=hidden]), textarea, select, label, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=combobox], [role=option], [role=menuitem], [role=menuitemradio], [role=menuitemcheckbox], [role=treeitem], [aria-haspopup=listbox], [contenteditable=true], [contenteditable=""]';
  const kindOf = e => {
    const tag = e.tagName.toLowerCase();
    const role = e.getAttribute('role');
    const box = tag === 'label' ? (tickable(e.control) ? e.control : null) : tickable(e) ? e : null;
    const on = v => (v ? ' (ticked)' : '');
    if (box) return (box.type === 'radio' ? 'radio option' : 'checkbox') + on(box.checked);
    if (tag === 'label' && isFile(e.control)) return 'file upload';
    if (role === 'radio' || role === 'checkbox' || role === 'switch') return role + on(e.getAttribute('aria-checked') === 'true');
    if (role === 'option' || role === 'treeitem') return 'option' + (e.getAttribute('aria-selected') === 'true' ? ' (selected)' : '');
    if (role === 'menuitem' || role === 'menuitemradio' || role === 'menuitemcheckbox') return 'menu item' + on(e.getAttribute('aria-checked') === 'true');
    if (tag === 'select') return 'dropdown';
    if (role === 'combobox' || e.getAttribute('aria-haspopup') === 'listbox') return 'dropdown (opens a list: choose picks from it)';
    if (tag === 'a' || role === 'link') return 'link';
    if (tag === 'input' && e.type === 'file') return 'file upload';
    if (tag === 'input') return (e.type || 'text') + ' field';
    if (tag === 'textarea' || e.isContentEditable) return 'text box';
    return 'button';
  };
  const keyOf = e => kindOf(e).replace(/ \\((ticked|selected)\\)$/, '') + '|' + label(e) + '|' + (e.getAttribute('name') || '');
  const st = { next: window.__eaaBase || 0, keys: {} };
  const controls = () => {
    const out = [];
    for (const e of document.querySelectorAll(SEL)) {
      if (!visible(e)) continue;
      // A radio button, checkbox or file input hidden behind a styled label: the label
      // is what's listed (clicking it ticks the box; upload_file fills the input).
      if (e.tagName === 'LABEL' && !((tickable(e.control) || isFile(e.control)) && !visible(e.control))) continue;
      out.push(e);
    }
    return out;
  };
  const number = all => {
    for (const e of all) {
      let ref = e.getAttribute('data-eaa-ref');
      // Copied with an element the page cloned: not this one's.
      if (ref && document.querySelectorAll('[data-eaa-ref="' + ref + '"]').length > 1 && st.keys[ref] !== keyOf(e)) ref = null;
      if (!ref) {
        ref = String(++st.next);
        e.setAttribute('data-eaa-ref', ref);
      }
      st.keys[ref] = keyOf(e);
    }
  };
  // The control a number stands for - the same element, or the one the page drew in
  // its place (same kind, label and name, not numbered yet).
  const find = ref => {
    const e = document.querySelector('[data-eaa-ref="' + ref + '"]');
    if (e && e.isConnected) return e;
    const key = st.keys[ref];
    if (!key) return null;
    const same = controls().filter(x => !x.getAttribute('data-eaa-ref') && keyOf(x) === key);
    if (same.length !== 1) return null;
    same[0].setAttribute('data-eaa-ref', String(ref));
    return same[0];
  };
  const shown = e => {
    if (e.tagName === 'INPUT' && e.type === 'password') return e.value ? ' (filled in)' : '';
    const file = isFile(e) ? e : e.tagName === 'LABEL' && isFile(e.control) ? e.control : null;
    if (file) return file.files && file.files.length ? ' = "' + [...file.files].map(f => f.name).join(', ') + '"' : '';
    if (!typable(e)) return '';
    const v = textOf(e.isContentEditable ? e.innerText : e.value);
    return v ? ' = "' + (v.length > 70 ? v.slice(0, 70) + '...' : v) + '"' : '';
  };
  const describe = (e, ref) => {
    const tag = e.tagName.toLowerCase();
    const href = tag === 'a' ? ' -> ' + e.href : '';
    let choices = '';
    if (tag === 'select') {
      const opts = [...e.options].map(o => textOf(o.text)).filter(Boolean);
      const picked = e.selectedOptions[0] ? textOf(e.selectedOptions[0].text) : '';
      choices = ' = "' + picked + '"; options: ' + opts.slice(0, 15).map(o => '"' + o.slice(0, 40) + '"').join(', ') + (opts.length > 15 ? ' (+' + (opts.length - 15) + ' more)' : '');
    }
    return '[' + ref + '] ' + kindOf(e) + ' "' + label(e) + '"' + shown(e) + href + choices;
  };
  const view = (max, chars) => {
    const all = controls();
    number(all);
    const h = innerHeight;
    const far = e => { const r = e.getBoundingClientRect(); return r.bottom < 0 ? -r.bottom : r.top > h ? r.top - h : 0; };
    const order = new Map(all.map((e, i) => [e, i]));
    const near = [...all].sort((a, b) => far(a) - far(b)).slice(0, max);
    const picked = new Set(near);
    let above = 0, below = 0;
    for (const e of all) if (!picked.has(e)) { if (e.getBoundingClientRect().bottom < 0) above++; else below++; }
    const items = near.sort((a, b) => order.get(a) - order.get(b)).map(e => describe(e, e.getAttribute('data-eaa-ref')));
    if (above) items.unshift('(' + above + ' more further up the page: scroll up to see them)');
    if (below) items.push('(' + below + ' more further down the page: scroll down to see them)');
    const text = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    return { title: document.title, text: text.length > chars ? text.slice(0, chars) + '\\n[page text cut off - scroll to see more]' : text, items };
  };
  // A list a custom dropdown opened: the option matching want, numbered - or what's offered.
  const OPTION_SEL = '[role=option], [role=menuitem], [role=menuitemradio], [role=treeitem], [cmdk-item], [data-radix-collection-item], li';
  const pickOption = want => {
    const w = textOf(want).toLowerCase();
    const opts = [...document.querySelectorAll(OPTION_SEL)].filter(e => visible(e) && textOf(e.innerText) && textOf(e.innerText).length < 120);
    const texts = opts.map(e => textOf(e.innerText));
    let i = texts.findIndex(t => t.toLowerCase() === w);
    if (i < 0) i = texts.findIndex(t => t.toLowerCase().includes(w));
    if (i < 0) return { offered: [...new Set(texts)].slice(0, 30) };
    number([opts[i]]);
    return { ref: Number(opts[i].getAttribute('data-eaa-ref')) };
  };
  // The file input a control stands for: itself, its label's, or the one beside it.
  const fileInput = ref => {
    const e = find(ref);
    if (!e) return null;
    if (isFile(e)) return e;
    if (e.tagName === 'LABEL' && isFile(e.control)) return e.control;
    let p = e;
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
      const inside = p.querySelectorAll('input[type=file]');
      if (inside.length === 1) return inside[0];
      if (inside.length > 1) break;
    }
    const all = document.querySelectorAll('input[type=file]');
    return all.length === 1 ? all[0] : null;
  };
  // Until the page stops changing for quiet ms, and min ms have gone by (at most cap):
  // a page that draws itself after it loads (most apps) is read once it has.
  const settle = (quiet, cap, min) => new Promise(done => {
    const start = Date.now();
    let t = setTimeout(end, quiet);
    const o = new MutationObserver(() => { clearTimeout(t); t = setTimeout(end, quiet); });
    const hard = setTimeout(stop, cap);
    function end() { if (Date.now() - start < (min || 0)) { t = setTimeout(end, (min || 0) - (Date.now() - start)); return; } stop(); }
    function stop() { o.disconnect(); clearTimeout(t); clearTimeout(hard); done(true); }
    o.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  });
  // The numbered controls inside an element (a pop-up in the way of a click).
  const listIn = c => { const all = controls().filter(x => c.contains(x)); number(all); return all.slice(0, 12).map(x => describe(x, x.getAttribute('data-eaa-ref'))); };
  return (window.__eaa = { view, find, pickOption, fileInput, settle, listIn });
})()`;
// Each call installs the helpers first if this document doesn't have them yet - in
// the page view's own world (cdp.ts), so the page never sees them.
export const inPage = (call: string) => `${PAGE_HELPERS}.${call}`;

// What a click copies (a Copy button), so the agent can be told: the page's own copy
// functions are watched for the moment of the click only, then put back. The clipboard
// itself can't be read here, and may refuse a page that isn't in front - the page is
// still told it worked, or it shows "Copy failed".
const COPY_WATCH = `(() => {
  if (window.__eaaCopy) return;
  const st = { copied: '', undo: [] };
  const remember = t => { if (typeof t === 'string' && t) st.copied = t; };
  const swap = (o, k, f) => { const was = o[k]; if (typeof was !== 'function') return; o[k] = f(was); st.undo.push(() => { o[k] = was; }); };
  if (window.Clipboard) {
    swap(Clipboard.prototype, 'writeText', w => function (t) { remember(String(t)); return w.call(this, t).catch(() => undefined); });
    swap(Clipboard.prototype, 'write', w => function (items) {
      for (const item of items || []) {
        const type = item.types.includes('text/plain') ? 'text/plain' : item.types.find(x => x.startsWith('text/'));
        if (type) item.getType(type).then(b => b.text()).then(remember).catch(() => {});
      }
      return w.call(this, items).catch(() => undefined);
    });
  }
  swap(document, 'execCommand', e => function (c) {
    const copy = String(c).toLowerCase() === 'copy';
    if (copy) { const a = document.activeElement; remember(a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT') ? a.value.slice(a.selectionStart, a.selectionEnd) : String(getSelection())); }
    return e.apply(this, arguments) || copy;
  });
  swap(DataTransfer.prototype, 'setData', d => function (type, value) {
    if (window.event && window.event.type === 'copy' && /text/.test(type)) remember(String(value));
    return d.call(this, type, value);
  });
  Object.defineProperty(window, '__eaaCopy', { value: st, configurable: true });
})()`;
const COPY_TAKE = `(() => { const st = window.__eaaCopy; if (!st) return null; for (const u of st.undo) u(); delete window.__eaaCopy; return st.copied || null; })()`;

// The page's text and its numbered controls.
async function snapshot(page: Driver): Promise<string> {
  await page.ready();
  const view = await page.evaluate<{ title: string; text: string; items: string[] }>(inPage(`view(${MAX_ELEMENTS}, ${TEXT_CHARS})`));
  const dialogs = page.takeDialogs();
  return [...(dialogs.length ? [`The page asked (answered OK): ${dialogs.join('; ')}`, ''] : []), `Title: ${view.title || '(none)'}`, `URL: ${await page.url()}`, '', view.text || '(no text)', '', view.items.length ? `What you can use (by number):\n${view.items.join('\n')}` : 'Nothing to click on this page.', ...(await frameSections(page))].join('\n');
}

// What's in the page's embedded frames (a form or an editor hosted elsewhere), each
// numbered with the rest - a security check's too: most are a box to tick, which in
// a real browser on a real connection usually just passes, and the agent ticks it
// (tick_security_check). Only a puzzle after that goes to the person. They used to be
// hidden from the agent altogether, so every one, even a checkbox, waited for a person.
// Not a card field, an ad or a video.
const CAPTCHA_FRAME = /challenges\.cloudflare\.com|\/recaptcha\/|recaptcha\.net|hcaptcha\.com|arkoselabs\.com|funcaptcha\.com|geetest\.com/i;
// The part that's a box to tick: Cloudflare's Turnstile, reCAPTCHA's anchor, hCaptcha's checkbox.
const CHECKBOX_FRAME = /challenges\.cloudflare\.com|\/recaptcha\/(api2|enterprise)\/anchor|hcaptcha\.com\/.*#frame=checkbox|newassets\.hcaptcha\.com\/captcha\/v1\/[^/]+\/static\/hcaptcha\.html#frame=checkbox/i;
// The puzzle that opens after it (pictures to pick, a slider): the person's.
const PUZZLE_FRAME = /\/recaptcha\/(api2|enterprise)\/bframe|hcaptcha\.com\/.*#frame=challenge|arkoselabs\.com|funcaptcha\.com|geetest\.com/i;
const UNUSED_FRAME = /js\.stripe\.com|checkout\.stripe\.com|paypal\.com|doubleclick\.net|googlesyndication\.com|googletagmanager\.com|youtube(-nocookie)?\.com\/embed|player\.vimeo\.com|facebook\.com\/plugins|platform\.twitter\.com/i;
const MAX_FRAMES = 8;
const FRAME_ELEMENTS = 50;
const FRAME_CHARS = 2_000;
const FRAME_WAIT_MS = 2_500;
let frameAllow = () => allowUrl();
type PageView = { title: string; text: string; items: string[] };
async function frameSections(page: Driver): Promise<string[]> {
  if (!page.frames || !page.evaluateInFrame) return [];
  const all = await page.frames().catch(() => []);
  const allow = frameAllow();
  const usable = (await Promise.all(all.map(async f => (!UNUSED_FRAME.test(f.url) && (!/^https?:/.test(f.url) || (await allow(f.url).catch(() => false))) ? f : null)))).filter(f => !!f).slice(0, MAX_FRAMES);
  const read = (no: number) => {
    const look = () => page.evaluateInFrame!<(PageView & { size: number }) | null>(no, `Object.assign(${inPage(`view(${FRAME_ELEMENTS}, ${FRAME_CHARS})`)}, { size: innerWidth * innerHeight })`);
    return Promise.race([
      (async () => {
        const first = await look();
        if (first && (first.text || first.items.length)) return first;
        // Still loading, most likely: frames fill in after the page has.
        await page.evaluateInFrame!(no, inPage('settle(300, 1500, 800)'));
        return look();
      })().catch(() => null),
      wait(FRAME_WAIT_MS).then(() => null),
    ]);
  };
  const views = await Promise.all(usable.map(async f => ({ url: f.url, view: await read(f.no) })));
  const out = all.some(f => CAPTCHA_FRAME.test(f.url))
    ? ['', (await securityCheck(page)) === 'puzzle'
        ? 'This page has a security check (CAPTCHA) asking for a puzzle - pictures to pick, a slider. That part is the person\'s: fill in everything else, then signed_in_browser.show_person.'
        : 'This page has a security check (CAPTCHA). If it shows a box to tick ("Verify you are human", "I\'m not a robot"), call tick_security_check once. Often it passes by itself after a few seconds: look again before ticking.']
    : [];
  for (const { url, view } of views) {
    if (!view || view.size < 400 || (!view.text && !view.items.length)) continue;
    const host = /^https?:/.test(url) ? new URL(url).host : 'this site';
    out.push('', `In a frame on this page (${host}):`, view.text || '(no text)', '', view.items.length ? `What you can use in that frame (by number):\n${view.items.join('\n')}` : 'Nothing to click in that frame.');
  }
  return out;
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

// The security check on a page now: a puzzle showing (the person's), a box to tick, or none.
async function securityCheck(page: Driver): Promise<'puzzle' | 'checkbox' | 'none'> {
  const frames = await page.frames().catch(() => []);
  const shown = async (re: RegExp) => {
    for (const f of frames.filter(f => re.test(f.url))) if ((await page.frameBox(f.no))?.shown) return f;
    return null;
  };
  if (await shown(PUZZLE_FRAME)) return 'puzzle';
  return (await shown(CHECKBOX_FRAME)) ? 'checkbox' : 'none';
}
// Ticks the box, as a person would, and says what happened.
async function tickSecurityCheck(page: Driver): Promise<string> {
  const frames = await page.frames().catch(() => []);
  let target: { no: number; box: { width: number; height: number } } | null = null;
  for (const f of frames.filter(f => CHECKBOX_FRAME.test(f.url))) {
    const box = await page.frameBox(f.no);
    if (box?.shown) {
      target = { no: f.no, box };
      break;
    }
  }
  if (!target) return `There's no box to tick on this page now.\n\n${await snapshot(page)}`;
  // reCAPTCHA's and hCaptcha's box is an element there; Cloudflare's is drawn where
  // nothing can reach it, at the left of its frame.
  const el = await page
    .evaluateInFrame<{ x: number; y: number } | null>(target.no, `(() => { const e = document.querySelector('#recaptcha-anchor, #checkbox, [role=checkbox], input[type=checkbox]'); if (!e) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`)
    .catch(() => null);
  const at = el ?? { x: Math.min(32, target.box.width / 4), y: target.box.height / 2 };
  await page.clickFrame(target.no, at.x, at.y);
  await wait(4_000);
  await settle(page, 3_000);
  const now = await securityCheck(page);
  const said =
    now === 'puzzle'
      ? "Ticked, and now it asks for a puzzle (pictures to pick, a slider): that part is the person's. Fill in everything else, then signed_in_browser.show_person."
      : now === 'checkbox'
        ? "Ticked; the box is still there - it may still be checking. Look again in a few seconds. If it's still asking, it's the person's: signed_in_browser.show_person."
        : 'Ticked, and the check is gone: carry on.';
  return `${said}\n\n${await snapshot(page)}`;
}

// After something that changes the page: until it has finished changing (cap ms at most).
const settle = (page: Driver, cap = 3_000, min = 0) => page.evaluate(inPage(`settle(400, ${cap}, ${min})`)).catch(() => wait(300));
// The same, watching the frame a number is in when it's in one.
const settleAt = (page: Driver, ref: number, cap = 3_000) => (ref >= FRAME_BASE && page.evaluateFor ? Promise.resolve().then(() => page.evaluateFor!(ref, inPage(`settle(400, ${cap}, 0)`))).catch(() => wait(300)) : settle(page, cap));
const evalAt = <T,>(page: Driver, ref: number, expression: string) => (page.evaluateFor ? page.evaluateFor<T>(ref, expression) : page.evaluate<T>(expression));

// Windows a site opens: a "Sign in with..." pop-up, a link that opens a new tab. The
// agent goes where the click went, and comes back when the window closes.
function backFromClosedWindow(s: Windows) {
  let back = false;
  while (s.cdp?.isClosed() && s.openers?.length) {
    s.cdp = s.openers.pop()!;
    s.page = s.cdp;
    back = true;
  }
  return back;
}
async function leaveWindows(s: Windows) {
  while (s.openers?.length) {
    await s.cdp!.close();
    release(s.cdp!.targetId);
    s.cdp = s.openers.pop()!;
    s.page = s.cdp;
  }
  s.windowClosed = false;
}
async function followNewWindow(s: Windows, allow: (url: string) => Promise<boolean>): Promise<string> {
  if (!s.cdp) return '';
  const followed = (s.followed ??= new Set());
  const fresh = (await s.cdp.popups().catch(() => [])).filter(id => !followed.has(id));
  if (!fresh.length) return '';
  for (const id of fresh) followed.add(id);
  const win = await s.cdp.adopt(fresh[fresh.length - 1]).catch(() => null);
  if (!win) return '';
  agentMade.add(win.targetId);
  await win.guard(allow);
  await win.ready(10_000);
  await settle(win, 3_000, 1_000);
  const at = await win.url().catch(() => '');
  if (/^https?:/.test(at) && !(await allow(at).catch(() => false))) {
    await win.close();
    return "That click opened a window on an address that isn't on the public web, so it was closed.";
  }
  (s.openers ??= []).push(s.cdp);
  s.cdp = win;
  s.page = win;
  if (siteOfUrl(at) === 'accounts.google.com')
    return "That click opened Google's sign-in. If it lists an account to choose, choose it - that signs you in. If it asks for an email or password instead, Google won't take it from this browser: go back (it closes the window) and call signed_in_browser.show_person with google true, once - the person signs in to Google in this profile, and from then on choosing the account is yours.";
  return "That click opened a new window, and you're in it now: what you do next happens there. When it closes you're back on the page that opened it; open, or back with nowhere further back to go, leaves it.";
}
async function windowNote(s: Windows, allow: (url: string) => Promise<boolean>) {
  if (backFromClosedWindow(s)) {
    await settle(s.page, 3_000, 800);
    return "That window closed, so you're back on the page that opened it.";
  }
  return followNewWindow(s, allow);
}
// A window can close between two steps (a sign-in finishing): the numbers the agent
// has are from that window, so they mustn't be used on the page behind it.
async function stopIfWindowClosed(s: Windows) {
  if (!s.windowClosed) return;
  s.windowClosed = false;
  throw new Error(`The window you were working in closed (a sign-in finishing, usually), so nothing was done. You're back on the page that opened it:\n\n${await snapshot(s.page)}`);
}

// A click, and the page after it - first what it copied, when it was a Copy button.
const MAX_COPIED = 20_000;
async function clickAndLook(page: Driver, ref: number, s?: Windows, allow = allowUrl()): Promise<string> {
  await page.evaluateInPage(COPY_WATCH).catch(() => {});
  try {
    await page.click(ref);
  } catch (e) {
    void page.evaluateInPage(COPY_TAKE).catch(() => {});
    if (!s?.openers?.length || !page.isClosed()) throw e; // a click that closes its own window
  }
  await wait(150);
  await settleAt(page, ref);
  const copied = await page.evaluateInPage<string | null>(COPY_TAKE).catch(() => null);
  if (s) {
    const note = await windowNote(s, allow);
    if (note) return `${note}\n\n${await snapshot(s.page)}`;
  }
  const after = await snapshot(page);
  if (!copied) return after;
  const cut = copied.length > MAX_COPIED ? `${copied.slice(0, MAX_COPIED)}\n[cut off - ${copied.length} characters in all]` : copied;
  return `That click copied this to the clipboard:\n${cut}\n\n${after}`;
}

// --- The tools ------------------------------------------------------------------------

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required });
const PROFILE_ARG = { type: 'number', description: 'Which browser profile (1 unless the account you need is in another - signed_in_browser.passwords says which)' };

function toolsFor(kind: Session['kind'], prefix: string, actTier: 'T0' | 'T1', where: string): ToolDef[] {
  const withProfile = (props: Record<string, unknown>) => (kind === 'profile' ? { ...props, profile: PROFILE_ARG } : props);
  const current = (ctx: RunCtx, a: Record<string, unknown>) => (kind === 'profile' ? knownProfile(a.profile).then(n => session(ctx, kind, n)) : session(ctx, kind));
  const open = async (ctx: RunCtx, a: Record<string, unknown>) => {
    const s = await current(ctx, a);
    await stopIfWindowClosed(s);
    return s;
  };
  const click = async (a: Record<string, unknown>, ctx: RunCtx) => {
    const s = await open(ctx, a);
    return clickAndLook(s.page, Number(a.ref), s);
  };
  return [
    {
      id: `${prefix}.open`,
      tier: 'T0',
      description: `Open a web address in ${where}. Returns the page's text and its buttons, links and fields, numbered.`,
      schema: obj(withProfile({ url: { type: 'string', description: 'The full address, starting http:// or https://' } }), ['url']),
      impl: async (a, ctx) => {
        const s = await current(ctx, a);
        await leaveWindows(s);
        await s.page.goto(checkUrl(String(a.url ?? '')).toString());
        // An app draws itself after the page loads (fetching who's signed in, say): read
        // it once it has - quiet for a moment, and never sooner than 1.5 s.
        await settle(s.page, 5_000, 1_500);
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.click`,
      tier: actTier,
      description:
        kind === 'profile'
          ? `Click a numbered button or link on the current page in ${where}. Not the click that pays, posts publicly as the business, or starts a new business tool: those are click_to_pay, click_to_post and click_to_start_tool. On a Copy button, the result starts with what it copied.`
          : `Click a numbered button or link on the current page in ${where}. Returns the page after the click; on a Copy button, it starts with what was copied.`,
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
        await wait(150);
        await settleAt(s.page, Number(a.ref), a.submit ? 4_000 : 1_500);
        if (backFromClosedWindow(s)) return `That window closed, so you're back on the page that opened it.\n\n${await snapshot(s.page)}`;
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.choose`,
      tier: actTier,
      description: `Pick an option in a numbered dropdown on the current page in ${where}: the option as the page lists it (an exact match, or the one that contains what you give). Works on custom dropdowns too (a button or field that opens a list): it opens the list, types to search it if it has to, and clicks the option.`,
      schema: obj(withProfile({ ref: { type: 'number' }, option: { type: 'string', description: 'The option to pick, as listed' } }), ['ref', 'option']),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        const want = String(a.option ?? '').trim().toLowerCase();
        const options = await s.page.options(Number(a.ref));
        if (!options) return chooseFromList(s.page, Number(a.ref), String(a.option ?? ''));
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
        await wait(300);
        await settle(s.page, 1_500);
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.back`,
      tier: 'T0',
      description: `Go back to the previous page in ${where}. In a window the site opened, with nothing further back, this closes it and returns to the page that opened it.`,
      schema: obj(withProfile({}), []),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        const moved = await s.page.back().catch(() => true);
        if (!moved && s.openers?.length) {
          await s.cdp!.close();
          backFromClosedWindow(s);
        }
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.look`,
      tier: 'T0',
      description: `See the current page in ${where} again, as it is now, without reloading it - a page given back to you after an approval, or one that changed by itself.`,
      schema: obj(withProfile({}), []),
      impl: async (a, ctx) => snapshot((await open(ctx, a)).page),
    },
    {
      id: `${prefix}.press`,
      tier: actTier,
      description: `Press a key in the current page in ${where}, on whatever has the focus: Escape closes most pop-ups and menus, Tab moves to the next field, the arrows move in a list, Enter submits.`,
      schema: obj(withProfile({ key: { type: 'string', enum: Object.keys(KEYS) } }), ['key']),
      impl: async (a, ctx) => {
        const key = String(a.key ?? '') as Key;
        if (!(key in KEYS)) throw new Error(`key: one of ${Object.keys(KEYS).join(', ')}.`);
        const s = await open(ctx, a);
        await s.page.press(key);
        await wait(150);
        await settle(s.page, 2_000);
        if (backFromClosedWindow(s)) return `That window closed, so you're back on the page that opened it.\n\n${await snapshot(s.page)}`;
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.tick_security_check`,
      tier: actTier,
      description: `Tick the security check's box on the current page in ${where} ("Verify you are human", "I'm not a robot"), once, as a person would. Says whether it passed, or now wants a puzzle - which is the person's.`,
      schema: obj(withProfile({}), []),
      impl: async (a, ctx) => tickSecurityCheck((await open(ctx, a)).page),
    },
    ...(kind === 'profile' ? profileOnly(where, click) : []),
  ];
}

// Files to upload: one from the agent's workspace, or one from the public web, kept
// for the run in a folder of its own (the browser reads it from there).
const UPLOAD_MAX_MB = 10;
async function workspaceFile(agentId: string, path: unknown) {
  const full = inWorkspace(agentId, path);
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) throw new Error(`No file at ${String(path)} in your workspace.`);
  if (st.size > UPLOAD_MAX_MB * 1_048_576) throw new Error(`${String(path)} is over ${UPLOAD_MAX_MB} MB.`);
  return full;
}
async function download(raw: string, runId: string) {
  const url = checkUrl(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('url is a web address, https://...');
  if (!(await allowUrl()(url.toString()))) throw new Error("That address isn't on the public web.");
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) }).catch(e => {
    throw new Error(`Couldn't download ${url}: ${(e as Error).message}`);
  });
  if (!r.ok) throw new Error(`Couldn't download ${url}: it answered ${r.status}.`);
  if (Number(r.headers.get('content-length') ?? 0) > UPLOAD_MAX_MB * 1_048_576) throw new Error(`${url} is over ${UPLOAD_MAX_MB} MB.`);
  const body = Buffer.from(await r.arrayBuffer());
  if (body.length > UPLOAD_MAX_MB * 1_048_576) throw new Error(`${url} is over ${UPLOAD_MAX_MB} MB.`);
  const type = (r.headers.get('content-type') ?? '').split(';')[0].trim();
  const ext = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/svg+xml': '.svg', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' }[type] ?? '';
  let name = basename(url.pathname).replace(/[^\w.-]/g, '_') || 'file';
  if (ext && !name.toLowerCase().endsWith(ext) && !/\.\w{2,4}$/.test(name)) name += ext;
  const dir = join(tmpdir(), `eaa-upload-${runId.replace(/\W/g, '')}`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, name);
  await writeFile(file, body);
  return file;
}

// A custom dropdown: a button or field that opens a list of page elements (no
// <select> to set). Open it, find the option - typing to search the list when it's
// a search box and the option isn't showing - and click it as a person would.
async function chooseFromList(page: Driver, ref: number, option: string): Promise<string> {
  const want = option.trim();
  if (!want) throw new Error('Say which option to pick.');
  type Found = { ref?: number; offered?: string[] };
  const look = () => evalAt<Found>(page, ref, inPage(`pickOption(${JSON.stringify(want)})`));
  await page.click(ref);
  await wait(150);
  await settleAt(page, ref, 1_500);
  let found = await look();
  if (found.ref == null) {
    // A searchable list: what's typed narrows it (and some only show options once you type).
    await page.fill(ref, want).catch(() => {});
    await wait(150);
    await settleAt(page, ref, 2_000);
    found = await look();
  }
  if (found.ref == null)
    throw new Error(
      found.offered?.length
        ? `No option like "${want}" in the list [${ref}] opened. It has: ${found.offered.map(o => `"${o}"`).join(', ')}`
        : `[${ref}] didn't open a list of options. Click it and look at the page, then click the option by its number.`,
    );
  await page.click(found.ref);
  await wait(150);
  await settleAt(page, ref, 1_500);
  return snapshot(page);
}

// For tests: the page view and its steps, on a page made there.
export const pageViewForTests = { allowAllFrames: () => void (frameAllow = () => async () => true), clickIn: (s: { page: CdpPage; cdp: CdpPage; openers?: CdpPage[] }, ref: number) => clickAndLook(s.page, ref, s as Windows, async () => true), click: (p: CdpPage, ref: number) => clickAndLook(p, ref), snapshot: (p: CdpPage) => snapshot(p), choose: (p: CdpPage, ref: number, option: string) => chooseFromList(p, ref, option), settle: (p: CdpPage, cap?: number, min?: number) => settle(p, cap, min), tick: (p: CdpPage) => tickSecurityCheck(p) };

// What a person's approval of a click clears, by agent and click: the site, until when.
const GRANT_MS = 60 * 60_000;
const grants = new Map<string, { site: string; until: number }>();

// The clicks that always wait for a person (unless they lower them on the Tools page),
// the password store, and opening a profile on the person's screen.
function profileOnly(where: string, click: ToolDef['impl']): ToolDef[] {
  // Approving one of these clears the job, not one click replayed blind: the click is
  // tried on the page kept for it, and either way the page goes back to the agent, which
  // may need a few more steps to finish (a newsletter pop-up over the button, an "Are
  // you sure?", Submit again). For the next hour the same click on the same site runs
  // without asking again - for that agent only. A click replayed alone, with nothing
  // able to deal with what was in its way, was what kept failing ("Something is on top
  // of [42]"), as it had in World Asset Register before its runs resumed whole.
  const decisive = (id: string, what: string): ToolDef => ({
    id: `signed_in_browser.${id}`,
    tier: 'T2',
    description: `The click that ${what}, in ${where}: a numbered button on the current page. Waits for the person's approval, unless they lowered it. The page stays as it is for that click, and your next browser step starts on a new page - open the next address you need; nothing you do after can move the waiting click. Once approved, the page comes back to you to finish the job: whatever else it takes there (a pop-up, a confirmation, this click again) is yours, and this click on that site runs without asking again for an hour.`,
    schema: obj({ ref: { type: 'number', description: 'The number from the last page you saw' }, what: { type: 'string', description: 'For the person approving, in a sentence: exactly what this click does (the plan and price, the post, the tool)' }, profile: PROFILE_ARG }, ['ref', 'what']),
    // Queued: its page is set aside for it (setAside). Approved: the click runs there.
    preview: async (a, ctx) => setAside(ctx, await knownProfile(a.profile), Number(a.ref)),
    // The rest of a job a person approved: the same click on the same site, within the hour.
    granted: async (a, ctx) => {
      const g = grants.get(`${ctx.agent.id}|${id}`);
      if (!g || g.until < Date.now()) return false;
      const s = sessions.get(`${ctx.runId}:profile:${await knownProfile(a.profile)}`);
      return !!s && !s.page.isClosed() && siteOfUrl(await s.page.url().catch(() => '')) === g.site;
    },
    impl: async (a, ctx) => {
      if (!a._page) return click(a, ctx); // the person lowered it, or approved the job this is part of
      const site = siteOfUrl(String(a._url ?? ''));
      grants.set(`${ctx.agent.id}|${id}`, { site, until: Date.now() + GRANT_MS });
      const cleared = `signed_in_browser.${id} on ${site} runs without asking again for the next hour`;
      const w = waitingPages.get(String(a._page));
      const s = w && sessions.get(w.key);
      if (!w || !s || s.page.isClosed())
        return `Nothing was clicked: the page it was queued on had closed (the agency restarted, the page was closed, or it waited too long). It's approved all the same, so do it yourself now: open ${String(a._url ?? 'the page')} again, redo the steps, and click - ${cleared}.`;
      if (s.cdp) await untilFree(s.cdp);
      let done: string;
      try {
        await s.page.click(Number(a.ref));
        await wait(150);
        await settle(s.page);
        done = 'Clicked.';
      } catch (e) {
        done = `The click as it was queued didn't land: ${(e as Error).message}`;
      }
      // Back with the agent: its next browser step on this profile continues here.
      w.resume = ctx.agent.id;
      w.since = Date.now();
      const n = s.profile;
      return `${done} The page is yours again: your next browser step on profile ${n} continues on it (signed_in_browser.look shows it - don't open it again, that reloads it). Finish the job there: close a pop-up, confirm, press it again - ${cleared}. Then check it went through.\n\n${await snapshot(s.page)}`;
    },
  });
  return [
    {
      id: 'signed_in_browser.upload_file',
      tier: 'T1',
      description: `Attach a file to a numbered upload field in ${where} - or to the button or label that opens one ("Upload logo"): a file from your workspace (path), or one on the public web (url, e.g. the logo on your website). Up to ${UPLOAD_MAX_MB} MB.`,
      schema: obj(
        {
          ref: { type: 'number', description: 'The upload field, or the button that opens it, from the last page you saw' },
          path: { type: 'string', description: 'A file in your workspace, e.g. "kit/logo.svg"' },
          url: { type: 'string', description: 'Or a file on the public web, https://...' },
          profile: PROFILE_ARG,
        },
        ['ref'],
      ),
      impl: async (a, ctx) => {
        const s = await session(ctx, 'profile', await knownProfile(a.profile));
        if (!s.cdp) throw new Error('Uploading works in the signed-in browser only.');
        const file = a.path ? await workspaceFile(ctx.agent.id, a.path) : a.url ? await download(String(a.url), ctx.runId) : null;
        if (!file) throw new Error('Give path (a file in your workspace) or url (a file on the public web).');
        await stopIfWindowClosed(s);
        if (!(await s.cdp.setFiles(inPage(`fileInput(${Number(a.ref)})`), [file], Number(a.ref))))
          throw new Error(`[${String(a.ref)}] isn't an upload field, and there's no single one beside it. Look at the page again: a "file upload" in the list is the field itself.`);
        await wait(150);
        await settle(s.page, 3_000);
        return `Attached ${basename(file)}.\n\n${await snapshot(s.page)}`;
      },
    },
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
        await stopIfWindowClosed(s);
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
      tier: 'T1',
      description:
        "For what only a person can do on a page: a CAPTCHA puzzle (after tick_security_check didn't pass it), a code sent to their phone, an ID check. Fill in everything else first and call this while you're still on that page: the page is kept for them exactly as it is, in its own tab in your browser, and a request is filed for you with a button that takes them straight to that tab - so they only do the check and press Submit. Don't file a request yourself as well. Your next browser step starts on a new page; get on with other work, and you'll hear when they're done. google true instead: the person signs in to Google in this profile (Google won't let an agent's browser sign in) - after that \"Sign in with Google\" on any site is yours: click it and choose the account.",
      schema: obj(
        {
          what: { type: 'string', description: 'For the request\'s title, in 10 words or fewer: what they need to do and why - "Pass the CAPTCHA to send the Tech Talks Daily pitch"' },
          why: { type: 'string', description: "What's filled in and waiting, and what happens once they've done it" },
          google: { type: 'boolean', description: 'True for signing in to Google in this profile, not a page you are on' },
          profile: PROFILE_ARG,
        },
        ['what'],
      ),
      impl: async (a, ctx) => {
        const n = await knownProfile(a.profile);
        const what = String(a.what ?? '').trim();
        const words = what.split(/\s+/).length;
        if (words > 14) return `Not done: what is ${words} words. Make it 10 words or fewer - what they need to do and why - and put the rest in why.`;
        const why = String(a.why ?? '').trim() || what;
        if (!a.google) return keepForPerson(ctx, n, what, why);
        const r = requestFor(ctx, n, GOOGLE_SIGN_IN, what, why);
        if (typeof r === 'string') return r;
        return `${r.isNew ? `Filed request #${r.id}` : `Request #${r.id} is already open for this`}: its button opens Google's sign-in in profile ${n} for the person. Meanwhile profile ${n} is closed to you while they sign in - use another profile or other work. You'll hear when they're done.`;
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
    tabs.push({ id, kind: 'agent', profile: s.profile, agent: s.agent ?? null, page: s.cdp, since: opening.get(id)!, request: s.request });
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

// In the cloud nobody sees the screen: each profile's browser runs on a screen of its
// own (a virtual display), which the live view streams whole - every agent's window,
// and the tab kept for the person - and sends their mouse and keys to (live-view.ts).
// It's the same browser the agents work in, as a browser on the person's own screen is.
const CLOUD = !!process.env.EAA_CLOUD_HOST;
const SCREEN = { width: 1280, height: 860 };
const SCREEN_TAB = 'screen:';
export const screenSize = SCREEN;
const xvfbs = new Map<string, ChildProcess>();
const screenSince = new Map<number, number>();
const screenOf = (n: number) => `:${100 + n}`;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// The profiles' screens (in the cloud), to watch and use: the browser on it, or
// Google's sign-in window while that has it.
export async function personScreens() {
  if (!CLOUD) return [];
  const out: { profile: number; display: string; since: number; url: string; request?: number }[] = [];
  for (const [n, p] of shared) {
    // Still starting (or stuck starting): not listed yet, rather than holding the list.
    const up = await Promise.race([p.then(() => true, () => false), new Promise<boolean>(r => setTimeout(() => r(false), 1500).unref())]);
    if (!up) continue;
    // Not a kept page's address or request: the screen shows whichever window is on top
    // (there's no window manager to raise one), so it was labelled futuretools.io while
    // showing another agent's page. Each kept page is listed as its own tab instead.
    out.push({ profile: n, display: screenOf(n), since: screenSince.get(n) ?? Date.now(), url: '' });
  }
  if (personWindow && !out.some(o => o.profile === personWindow!.profile))
    out.push({ profile: personWindow.profile, display: screenOf(personWindow.profile), since: personWindow.since, url: personWindow.url, request: personWindow.request });
  return out;
}

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

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
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
    screenSince.set(n, Date.now());
    return display;
  }
  throw new Error(`The virtual screen ${display} never came up.${stderr.trim() ? ` ${stderr.trim()}` : ''}`);
}

// --- A page for the person -------------------------------------------------------------
//
// A request's button with no page kept for it (or "Open a profile" in the app): a new
// window in the profile's browser - the agents' own, with every sign-in they have - at
// that address. It isn't attached to anything, so it's the plain browser to the site.
// Whatever the person signs in to there, the agents are signed in to: it's one browser.
type PersonPage = { targetId: string; profile: number; url: string; request?: number; since: number };
const personPages = new Map<string, PersonPage>();
async function openPersonPage(n: number, url: string, request?: number) {
  const sh = await profileBrowser(n);
  const { targetId } = await sh.cdp.send<{ targetId: string }>('Target.createTarget', { url, newWindow: true, ...agentBounds() });
  personPages.set(targetId, { targetId, profile: n, url, request, since: Date.now() });
  await sh.cdp.send('Target.activateTarget', { targetId }).catch(() => {});
  watchPersonPages();
  return targetId;
}
// Closed by the person: its request, if it came from one, is answered - its agent hears.
let pagesWatch: ReturnType<typeof setInterval> | undefined;
function watchPersonPages() {
  if (pagesWatch) return;
  pagesWatch = setInterval(async () => {
    for (const [n, p] of shared) {
      const sh = await p.catch(() => null);
      const open = new Set(sh ? (await sh.cdp.send<{ targetInfos: { targetId: string }[] }>('Target.getTargets').catch(() => ({ targetInfos: [] }))).targetInfos.map(t => t.targetId) : []);
      for (const pp of personPages.values()) {
        if (pp.profile !== n || open.has(pp.targetId)) continue;
        personPages.delete(pp.targetId);
        if (pp.request != null) personDone(pp.request, `Closed the page opened for this (${siteOfUrl(pp.url)}). Open ${pp.url} again and check it worked.`);
      }
    }
    if (!personPages.size) {
      clearInterval(pagesWatch);
      pagesWatch = undefined;
    }
  }, 2_000);
  pagesWatch.unref?.();
}

// --- Signing in to Google ----------------------------------------------------------------
//
// Google refuses to sign anyone in to a browser started with a debugging address -
// attached to the page or not ("This browser or app may not be secure"; checked again
// 2026-11-13 on Chrome 155, with only real keystrokes). So, as World Asset Register does
// it: the profile's browser closes, the same profile opens as the plain browser for
// the person to sign in, and when they close it the agents' browser starts again,
// signed in. Nothing is copied: it's the same profile, Google's sign-in and all.
// (It used to be a copy of the profile, with only some cookies carried back - never
// Google's or YouTube's, and nothing a site keeps outside cookies - so agents could
// never be signed in to YouTube, however often the person signed in.)
const signingIn = new Map<number, number>(); // profile -> since
type PersonWindow = { profile: number; pid?: number; proc: ChildProcess; since: number; url: string; request?: number };
let personWindow: PersonWindow | null = null;
const isGoogleSignIn = (url: string) => /^(accounts\.google\.com|accounts\.youtube\.com)$/.test(siteOfUrl(url));
export const GOOGLE_SIGN_IN = 'https://accounts.google.com/';

async function googleSignIn(n: number, url: string, request?: number) {
  if (personWindow) {
    if (personWindow.profile === n) return { ok: true, profile: n, already: true, ...(CLOUD ? { live: `${SCREEN_TAB}${n}` } : {}) };
    throw new Error(`Google's sign-in is open for profile ${personWindow.profile}. Finish there (close that window) first.`);
  }
  const exe = browserExe();
  if (!exe) throw noBrowser();
  signingIn.set(n, Date.now());
  try {
    const sh = await shared.get(n)?.catch(() => null);
    if (sh) {
      console.log(`[browser] Profile ${n}: closing the agents' browser for Google's sign-in.`);
      await closeShared(n, sh);
    }
    await closing.get(n);
    const dir = profileDir(n);
    await keepSignedIn(dir, false);
    await clearStaleLock(dir);
    const display = CLOUD ? await displayFor(n) : null;
    const proc = spawn(exe, [`--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', ...(display ? ['--window-position=0,0', `--window-size=${SCREEN.width},${SCREEN.height}`, '--start-maximized'] : []), ...EXTRA_FLAGS, url], {
      stdio: 'ignore',
      env: display ? { ...process.env, DISPLAY: display } : process.env,
    });
    running.add(proc);
    const w: PersonWindow = { profile: n, pid: proc.pid, proc, since: Date.now(), url, request };
    personWindow = w;
    proc.once('error', e => console.error(`[browser] Profile ${n}: Google's sign-in window failed to start:`, e.message));
    proc.once('exit', () => {
      running.delete(proc);
      if (personWindow === w) personWindow = null;
      signingIn.delete(n);
      console.log(`[browser] Profile ${n}: Google's sign-in window closed; the agents' browser starts again.`);
      // Back for the agents now, with its kept pages and the new sign-in.
      void profileBrowser(n).catch(e => console.error(`[browser] Profile ${n}: starting the agents' browser again failed:`, (e as Error).message));
      if (request != null) personDone(request, 'Closed the Google sign-in window. Check you are signed in to Google now (open the site and sign in with Google - choose the account, nothing to type).');
    });
    console.log(`[browser] Profile ${n}: Google's sign-in open for the person${display ? ` on ${display}` : ''} (pid ${proc.pid ?? 'unknown'}).`);
    return { ok: true, profile: n, already: false, ...(display ? { live: `${SCREEN_TAB}${n}` } : {}) };
  } catch (e) {
    signingIn.delete(n);
    throw e;
  }
}

// Done with Google's sign-in from the app (in the cloud, where they can't close the
// window themselves): closed the way a person closes it, so Chrome writes its cookies.
export function closePersonWindow(n: number) {
  const w = personWindow;
  if (!w || w.profile !== n) return false;
  if (!CLOUD) {
    w.proc.kill();
    return true;
  }
  void (async () => {
    for (let i = 0; i < 6 && w.proc.exitCode === null; i++) {
      await new Promise<void>(r => {
        const x = spawn('xdotool', ['key', 'ctrl+shift+w'], { env: { ...process.env, DISPLAY: screenOf(n) }, stdio: 'ignore' });
        x.on('close', () => r());
        x.on('error', () => r());
      });
      await sleep(1_000);
    }
    if (w.proc.exitCode === null) w.proc.kill();
  })();
  return true;
}

// A request's button, or "Open a profile" in the app: Google's sign-in in the plain
// browser; anything else a window in the agents' browser, at that address.
export async function openProfileWindow(profile = 1, url = 'https://www.google.com', request?: number) {
  const n = await knownProfile(profile);
  const target = checkUrl(url).toString();
  if (isGoogleSignIn(target)) return googleSignIn(n, target, request);
  const tab = await openPersonPage(n, target, request);
  return { ok: true, profile: n, already: false, tab, ...(CLOUD ? { live: `${SCREEN_TAB}${n}` } : {}) };
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
  const open = (n: number) => personWindow?.profile === n;
  const inUse = (n: number) => (now.get(n)?.runs.size ?? 0) > 0;
  return {
    // Kept for older screens: profile 1.
    open: open(1),
    inUse: inUse(1),
    profiles: profiles.map(n => ({ n, open: open(n), inUse: inUse(n), accounts: counts.get(`${n}`) ?? 0 })),
  };
}
