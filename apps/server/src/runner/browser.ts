import { spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { checkUrl, isPrivateIp } from './net.js';
import { onRunEnd, registerTools, type RunCtx, type ToolDef } from './tools.js';
import { ACCOUNTS_PER_SITE, listPasswords, makePassword, passwordRow, profileFor, readPassword, savePassword, siteOf } from './passwords.js';
import { DATA_DIR } from '../paths.js';
import { getSecret, setSecret } from '../vault.js';

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
// Each run gets its own session per profile. A page comes back as its text plus
// numbered buttons, links and fields; the agent clicks or types by number. Every
// request the page makes is checked like any agent fetch: never this computer or
// its network.
//
// A person (or an agent, for them) opens a profile in a real window: the browser
// itself, not driven by automation - sites like Google and LinkedIn refuse sign-ins
// in an automated window, and it's the same profile the agents then use.

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
  return chromium.launch({ executablePath: exe, headless });
}

async function launchProfile(n: number): Promise<BrowserContext> {
  const exe = browserExe();
  if (!exe) throw noBrowser();
  const dir = profileDir(n);
  await keepSignedIn(dir);
  try {
    return await chromium.launchPersistentContext(dir, { executablePath: exe, headless: true, acceptDownloads: false, viewport: { width: 1280, height: 900 } });
  } catch (e) {
    if (/in use|already running|ProcessSingleton|lock/i.test((e as Error).message)) throw busyError(n);
    throw e;
  }
}

// Blocks anything a page asks for on this computer or its network.
async function guard(context: BrowserContext) {
  const verdicts = new Map<string, boolean>();
  await context.route('**/*', async route => {
    const raw = route.request().url();
    if (raw.startsWith('data:') || raw.startsWith('blob:')) return route.continue();
    try {
      const url = checkUrl(raw);
      let ok = verdicts.get(url.hostname);
      if (ok === undefined) {
        const addresses = await lookup(url.hostname, { all: true }).catch(() => []);
        ok = addresses.length > 0 && !addresses.some(a => isPrivateIp(a.address));
        verdicts.set(url.hostname, ok);
      }
      return ok ? route.continue() : route.abort('blockedbyclient');
    } catch {
      return route.abort('blockedbyclient');
    }
  });
}

// --- Sessions, one per run, kind and profile ------------------------------------------

type Session = { kind: 'blank' | 'profile'; profile: number; browser?: Browser; context: BrowserContext; page: Page };
const sessions = new Map<string, Session>();
const busy = new Map<number, string>(); // profile -> the run holding it
const windows = new Map<number, ChildProcess>(); // profile -> its window on the person's screen

const busyError = (n: number) =>
  new Error(
    windows.has(n)
      ? `Browser profile ${n} is open on the person's screen. It's free again once they close that window.`
      : `Browser profile ${n} is in use by another agent's run. Try again shortly, or use another profile.`,
  );

async function session(ctx: RunCtx, kind: Session['kind'], profile = 1): Promise<Session> {
  const key = `${ctx.runId}:${kind}:${kind === 'profile' ? profile : 0}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  let s: Session;
  if (kind === 'blank') {
    const browser = await launch(true);
    const context = await browser.newContext({ acceptDownloads: false, viewport: { width: 1280, height: 900 } });
    s = { kind, profile: 0, browser, context, page: await context.newPage() };
  } else {
    if (windows.has(profile) || (busy.has(profile) && busy.get(profile) !== ctx.runId)) throw busyError(profile);
    busy.set(profile, ctx.runId);
    try {
      const context = await launchProfile(profile);
      await restoreSessionCookies(context, profile);
      s = { kind, profile, context, page: context.pages()[0] ?? (await context.newPage()) };
    } catch (e) {
      busy.delete(profile);
      throw e;
    }
  }
  await guard(s.context);
  sessions.set(key, s);
  return s;
}

async function closeSession(key: string) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  if (s.kind === 'profile') await keepSessionCookies(s).catch(() => {});
  await (s.browser ? s.browser.close() : s.context.close()).catch(() => {});
  if (s.kind === 'profile') busy.delete(s.profile);
}

// A sign-in without "remember me" lives in session cookies, which the browser drops
// when it closes - so a run's sign-ins were gone by the next run. Kept in the vault
// (encrypted) when a run ends, and put back when the profile opens again.
const sessionKey = (n: number) => `browser:${n}:session-cookies`;
async function keepSessionCookies(s: Session) {
  const kept = (await s.context.cookies()).filter(c => c.expires === -1);
  await setSecret(sessionKey(s.profile), kept);
}
async function restoreSessionCookies(context: BrowserContext, n: number) {
  const kept = await getSecret<Parameters<BrowserContext['addCookies']>[0]>(sessionKey(n)).catch(() => null);
  if (kept?.length) await context.addCookies(kept).catch(() => {});
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
  const label = e => (e.getAttribute('aria-label') || e.placeholder || e.getAttribute('title') || e.innerText || (e.type === 'password' ? '' : e.value) || e.getAttribute('name') || '')
    .replace(/\\s+/g, ' ').trim().slice(0, 80);
  const items = [];
  let n = 0;
  for (const e of document.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=tab], [role=checkbox], [contenteditable=true]')) {
    if (n >= max || !visible(e)) continue;
    n++;
    e.setAttribute('data-eaa-ref', String(n));
    const tag = e.tagName.toLowerCase();
    const kind = tag === 'a' || e.getAttribute('role') === 'link' ? 'link'
      : tag === 'input' ? (e.type || 'text') + ' field'
      : tag === 'textarea' || e.getAttribute('contenteditable') === 'true' ? 'text box'
      : tag === 'select' ? 'dropdown' : 'button';
    const href = tag === 'a' ? ' -> ' + e.href : '';
    items.push('[' + n + '] ' + kind + ' "' + label(e) + '"' + href);
  }
  const text = ((document.body && document.body.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim();
  return { title: document.title, text: text.length > chars ? text.slice(0, chars) + '\\n[page text cut off - scroll to see more]' : text, items };
})()`;

// The page's text and its numbered interactive elements.
async function snapshot(page: Page): Promise<string> {
  await page.waitForLoadState('domcontentloaded', { timeout: 15_000 }).catch(() => {});
  const view = (await page.evaluate(SNAPSHOT_SCRIPT)) as { title: string; text: string; items: string[] };
  return [`Title: ${view.title || '(none)'}`, `URL: ${page.url()}`, '', view.text || '(no text)', '', view.items.length ? `What you can use (by number):\n${view.items.join('\n')}` : 'Nothing to click on this page.'].join('\n');
}

const el = (page: Page, ref: unknown) => page.locator(`[data-eaa-ref="${Number(ref)}"]`).first();

// --- The tools ------------------------------------------------------------------------

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required });
const PROFILE_ARG = { type: 'number', description: 'Which browser profile (1 unless the account you need is in another - signed_in_browser.passwords says which)' };

function toolsFor(kind: Session['kind'], prefix: string, actTier: 'T0' | 'T1', where: string): ToolDef[] {
  const withProfile = (props: Record<string, unknown>) => (kind === 'profile' ? { ...props, profile: PROFILE_ARG } : props);
  const open = (ctx: RunCtx, a: Record<string, unknown>) => (kind === 'profile' ? knownProfile(a.profile).then(n => session(ctx, kind, n)) : session(ctx, kind));
  const click = async (a: Record<string, unknown>, ctx: RunCtx) => {
    const s = await open(ctx, a);
    await el(s.page, a.ref).click({ timeout: 10_000 });
    await s.page.waitForTimeout(800);
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
        await s.page.goto(checkUrl(String(a.url ?? '')).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
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
        const field = el(s.page, a.ref);
        await field.fill(String(a.text ?? ''), { timeout: 10_000 });
        if (a.submit) await field.press('Enter');
        await s.page.waitForTimeout(a.submit ? 1200 : 200);
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
        await s.page.mouse.wheel(0, a.direction === 'up' ? -1600 : 1600);
        await s.page.waitForTimeout(500);
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
        await s.page.goBack({ timeout: 15_000 }).catch(() => {});
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
        const field = el(s.page, a.ref);
        await field.fill(await readPassword(String(a.password_id ?? '')), { timeout: 10_000 });
        if (a.submit) await field.press('Enter');
        await s.page.waitForTimeout(a.submit ? 1500 : 200);
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
        "Open a browser profile in a window on the person's screen, at a page - for what only a person can do: a CAPTCHA, or a code sent to their phone. Then file a request saying what they need to do, with a line \"Open in signed-in browser: <address>\" (and \" (profile N)\" if not 1) so they get a button. Your own use of that profile stops until they close it.",
      schema: obj({ url: { type: 'string', description: 'The page to open' }, profile: PROFILE_ARG }, ['url']),
      impl: async (a, ctx) => {
        const n = await knownProfile(a.profile);
        await closeSession(`${ctx.runId}:profile:${n}`);
        await openProfileWindow(n, String(a.url ?? ''));
        return `Opened profile ${n} on the person's screen at ${String(a.url)}.`;
      },
    },
  ];
}

export const BROWSER_TOOLS = toolsFor('blank', 'browser', 'T0', 'a blank throwaway browser (no sign-ins)');
export const SIGNED_IN_TOOLS = toolsFor('profile', 'signed_in_browser', 'T1', "the agents' own signed-in browser profiles");
registerTools([...BROWSER_TOOLS, ...SIGNED_IN_TOOLS]);

// --- A profile on the person's screen ------------------------------------------------------

// The real browser, on this profile: the person signs in (or does a CAPTCHA or a phone
// code) and closes the window, and the agents carry on in the same profile.
export async function openProfileWindow(profile = 1, url = 'https://www.google.com') {
  const n = await knownProfile(profile);
  const target = checkUrl(url).toString();
  if (busy.has(n)) throw busyError(n);
  const exe = browserExe();
  if (!exe) throw noBrowser();
  const open = windows.get(n);
  await keepSignedIn(profileDir(n));
  // Already open: the page opens in it (the browser hands it to the running window).
  const child = spawn(exe, [`--user-data-dir=${profileDir(n)}`, '--no-first-run', '--no-default-browser-check', target], { stdio: 'ignore', windowsHide: false });
  if (open) return { ok: true, profile: n, already: true };
  windows.set(n, child);
  child.on('exit', () => windows.get(n) === child && windows.delete(n));
  child.on('error', () => windows.get(n) === child && windows.delete(n));
  return { ok: true, profile: n, already: false };
}

export async function profileStatus() {
  const profiles = await listProfiles();
  const counts = new Map<string, number>();
  for (const r of listPasswords()) counts.set(`${r.profile}`, (counts.get(`${r.profile}`) ?? 0) + 1);
  return {
    // Kept for older screens: profile 1.
    open: windows.has(1),
    inUse: busy.has(1),
    profiles: profiles.map(n => ({ n, open: windows.has(n), inUse: busy.has(n), accounts: counts.get(`${n}`) ?? 0 })),
  };
}
