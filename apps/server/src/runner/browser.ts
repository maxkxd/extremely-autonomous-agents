import { spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { Cdp, CdpPage, type Bounds } from './cdp.js';
import { checkUrl, isPrivateIp } from './net.js';
import { onRunEnd, registerTools, type RunCtx, type ToolDef } from './tools.js';
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
  // The person has it open in their own window (signing in): wait for them.
  const theirs = personOpen.get(n);
  if (theirs) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([theirs.then(() => true), new Promise<false>(r => (timer = setTimeout(() => r(false), PERSON_WAIT_MS)))]);
    clearTimeout(timer);
    if (!done) throw new Error(`Browser profile ${n} is still open in the person's own window (they're signing in). Try it again later - other work first.`);
  }
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
  // The browser writes its debugging port (and its address) here once it's listening.
  const portFile = join(dir, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const proc = spawn(exe, [`--user-data-dir=${dir}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', ...PROFILE_FLAGS, ...EXTRA_FLAGS], { stdio: 'ignore', windowsHide: false });
  running.add(proc);
  let exited = false;
  proc.on('exit', () => {
    exited = true;
    running.delete(proc);
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
    if (shared.get(n) && s.proc === proc) shared.delete(n);
    clearTimeout(s.idle);
  });
  cdp.onClose(() => proc.kill());
  return s;
}

// Nobody's using it: close it a minute later, sign-ins kept.
function closeWhenIdle(n: number, s: Shared) {
  clearTimeout(s.idle);
  if (s.runs.size) return;
  s.idle = setTimeout(() => {
    if (s.runs.size) return;
    if (shared.get(n)) shared.delete(n);
    void (async () => {
      await keepSessionCookies(s.cdp, n).catch(() => {});
      await s.cdp.send('Browser.close').catch(() => s.proc.kill());
    })().catch(() => s.proc.kill());
  }, IDLE_CLOSE_MS);
}

// The app quitting takes the profiles' browsers with it.
const running = new Set<ChildProcess>();
process.on('exit', () => {
  for (const proc of running) proc.kill();
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

async function session(ctx: RunCtx, kind: Session['kind'], profile = 1): Promise<Session> {
  const key = `${ctx.runId}:${kind}:${kind === 'profile' ? profile : 0}`;
  const existing = sessions.get(key);
  if (existing && !existing.page.isClosed()) {
    if (existing.cdp) await untilFree(existing.cdp);
    return existing;
  }
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
    try {
      const page = await CdpPage.open(sh.cdp, agentBounds());
      await page.guard(allowUrl());
      s = { kind, runId: ctx.runId, profile, page, cdp: page, agent: { id: ctx.agent.id, name: ctx.agent.name } };
    } catch (e) {
      sh.runs.delete(ctx.runId);
      closeWhenIdle(profile, sh);
      throw e;
    }
  }
  sessions.set(key, s);
  return s;
}

async function closeSession(key: string) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  if (s.cdp) release(s.cdp.targetId);
  if (s.kind === 'blank') return void (await s.browser?.close().catch(() => {}));
  const sh = await shared.get(s.profile)?.catch(() => null);
  if (sh) await keepSessionCookies(sh.cdp, s.profile).catch(() => {});
  await s.page.close().catch(() => {});
  if (!sh) return;
  sh.runs.delete(s.runId);
  closeWhenIdle(s.profile, sh);
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

async function closeSessions(runId: string) {
  for (const key of [...sessions.keys()]) if (key.startsWith(`${runId}:`)) await closeSession(key);
}
onRunEnd(closeSessions);

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
        "Open a browser profile in a window on the person's screen, at a page - for what only a person can do: a CAPTCHA, or a code sent to their phone. Then file a request saying what they need to do, with a line \"Open in signed-in browser: <address>\" (and \" (profile N)\" if not 1) so they get a button. While their window is open, that profile is theirs: your own window on it closes, and browser tools on it wait until they close theirs - so file the request and get on with other work. What they sign in to is signed in for you too.",
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
const personTabs = new Map<string, LiveTab & { onDone?: () => void }>();
const opening = new Map<string, number>(); // when each agent page was first seen
export function liveTabs(): LiveTab[] {
  const tabs: LiveTab[] = [];
  for (const s of sessions.values()) {
    if (!s.cdp || s.cdp.isClosed()) continue;
    const id = s.cdp.targetId;
    if (!opening.has(id)) opening.set(id, Date.now());
    tabs.push({ id, kind: 'agent', profile: s.profile, agent: s.agent ?? null, page: s.cdp, since: opening.get(id)! });
  }
  for (const [id, t] of personTabs) if (t.page.isClosed()) personTabs.delete(id);
  return [...tabs, ...personTabs.values()];
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

// A page of the person's own in a profile's browser, at a page. done: when they press
// "Done" on it (not when they hand it back unfinished), once.
export async function openPersonTab(profile: number, url: string, opts: { request?: number; onDone?: () => void } = {}): Promise<LiveTab> {
  const n = await knownProfile(profile);
  const target = checkUrl(url).toString();
  const sh = await profileBrowser(n);
  clearTimeout(sh.idle);
  const page = await CdpPage.open(sh.cdp, agentBounds(), 'about:blank');
  await page.guard(allowUrl());
  const tab = { id: page.targetId, kind: 'person' as const, profile: n, agent: null, page, since: Date.now(), request: opts.request, onDone: opts.onDone };
  personTabs.set(tab.id, tab);
  sh.runs.add(`person:${tab.id}`);
  void page.goto(target).catch(() => {});
  return tab;
}
export async function closePersonTab(id: string, done: boolean) {
  const t = personTabs.get(id);
  if (!t) return;
  personTabs.delete(id);
  const sh = await shared.get(t.profile)?.catch(() => null);
  if (sh) await keepSessionCookies(sh.cdp, t.profile).catch(() => {});
  await t.page.close();
  if (done) t.onDone?.();
  if (!sh) return;
  sh.runs.delete(`person:${id}`);
  closeWhenIdle(t.profile, sh);
}

// In the cloud nobody sees the screen, so "open it for the person" opens one of their
// pages for the live view instead of a window: the same sign-ins, and watched in the app.
const LIVE_ONLY = !!process.env.EAA_CLOUD_HOST;

// --- A profile on the person's screen ------------------------------------------------------

// The person's window: the plain browser on the profile, nothing attached and no
// debugging address, where Google signs them in. A profile opens in one browser at a
// time, so the agents' browser on it closes first (their sign-ins kept) and runs
// needing it wait until the person's window has closed - then it opens again with
// what they signed in to. onClosed: once it has closed (opened from a request, its
// Engineer is told) - once per key however often it's opened meanwhile.
const whenClosed = new Map<number, Map<string, () => void>>();
function personGone(n: number) {
  const then = whenClosed.get(n);
  whenClosed.delete(n);
  for (const f of then?.values() ?? []) f();
}
const personOpen = new Map<number, Promise<void>>();
const PERSON_WAIT_MS = 20 * 60_000;
export async function openProfileWindow(profile = 1, url = 'https://www.google.com', onClosed?: { key: string; run: () => void }, request?: number) {
  if (LIVE_ONLY) {
    const tab = await openPersonTab(profile, url, { request, onDone: onClosed?.run });
    return { ok: true, profile: tab.profile, already: false, live: tab.id };
  }
  const n = await knownProfile(profile);
  const target = checkUrl(url).toString();
  const exe = browserExe();
  if (!exe) throw noBrowser();
  const remember = () => onClosed && whenClosed.set(n, (whenClosed.get(n) ?? new Map()).set(onClosed.key, onClosed.run));
  if (personOpen.has(n)) {
    remember();
    // Another page in it: handed to their open browser, which opens a window and exits.
    spawn(exe, [`--user-data-dir=${profileDir(n)}`, ...EXTRA_FLAGS, target], { stdio: 'ignore' }).on('error', () => {});
    return { ok: true, profile: n, already: true };
  }
  // Theirs from now: a run starting meanwhile waits rather than reopening the agents' browser.
  let done = () => {};
  personOpen.set(n, new Promise<void>(r => (done = r)));
  const agents = await shared.get(n)?.catch(() => null);
  if (agents) {
    shared.delete(n);
    clearTimeout(agents.idle);
    await keepSessionCookies(agents.cdp, n).catch(() => {});
    const gone = new Promise<void>(r => (agents.proc.exitCode !== null ? r() : agents.proc.once('exit', () => r())));
    await agents.cdp.send('Browser.close').catch(() => agents.proc.kill());
    await Promise.race([gone, new Promise(r => setTimeout(r, 10_000))]);
  }
  // Registered after the agents' browser has closed.
  remember();
  await keepSignedIn(profileDir(n));
  const proc = spawn(exe, [`--user-data-dir=${profileDir(n)}`, '--no-first-run', '--no-default-browser-check', ...EXTRA_FLAGS, target], { stdio: 'ignore' });
  running.add(proc);
  const ended = () => {
    running.delete(proc);
    personOpen.delete(n);
    // What they signed in to is in the profile now; the copy kept for the agents'
    // browser is older, and put back it would undo it.
    void deleteSecret(sessionKey(n)).catch(() => {});
    personGone(n);
    done();
  };
  proc.once('exit', ended);
  proc.once('error', ended);
  return { ok: true, profile: n, already: false };
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
