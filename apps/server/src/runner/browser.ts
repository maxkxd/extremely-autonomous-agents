import { lookup } from 'node:dns/promises';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { checkUrl, isPrivateIp } from './net.js';
import { onRunEnd, registerTools, type RunCtx, type ToolDef } from './tools.js';

// Browsing for agents (docs/integrations.md), on the Edge or Chrome already
// installed - nothing to download.
//
//   browser.*            a blank throwaway browser: no sign-ins, nothing kept
//   signed_in_browser.*  the agent profile: a separate, persistent profile the
//                        person signs into once (Settings), only to the sites
//                        they want agents to use - never their own profile
//
// Each run gets its own session. A page comes back as its text plus numbered
// buttons, links and fields; the agent clicks or types by number. Every
// request the page makes is checked like any agent fetch: never this
// computer or its network.

export const PROFILE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'browser-profile');
const CHANNELS = ['msedge', 'chrome'] as const;
const TEXT_CHARS = 8_000;
const MAX_ELEMENTS = 80;

// --- Starting a browser ------------------------------------------------------------

async function launch(headless: boolean): Promise<Browser> {
  let last: Error | null = null;
  for (const channel of CHANNELS) {
    try {
      return await chromium.launch({ channel, headless });
    } catch (e) {
      last = e as Error;
    }
  }
  throw new Error(`No Edge or Chrome found on this computer (${last?.message.split('\n')[0] ?? 'unknown'}).`);
}

async function launchProfile(headless: boolean): Promise<BrowserContext> {
  await mkdir(PROFILE_DIR, { recursive: true });
  let last: Error | null = null;
  for (const channel of CHANNELS) {
    try {
      return await chromium.launchPersistentContext(PROFILE_DIR, { channel, headless, acceptDownloads: false, viewport: headless ? { width: 1280, height: 900 } : null });
    } catch (e) {
      last = e as Error;
      if (/in use|already running|ProcessSingleton|lock/i.test(last.message)) throw new Error('The agent profile is open somewhere else (the sign-in window, or another run). Try again once it is closed.');
    }
  }
  throw new Error(`No Edge or Chrome found on this computer (${last?.message.split('\n')[0] ?? 'unknown'}).`);
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

// --- Sessions, one per run and kind -------------------------------------------------

type Session = { kind: 'blank' | 'profile'; browser?: Browser; context: BrowserContext; page: Page };
const sessions = new Map<string, Session>();
let profileBusy: string | null = null; // the run (or the sign-in window) holding the profile

async function session(ctx: RunCtx, kind: Session['kind']): Promise<Session> {
  const key = `${ctx.runId}:${kind}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  let s: Session;
  if (kind === 'blank') {
    const browser = await launch(true);
    const context = await browser.newContext({ acceptDownloads: false, viewport: { width: 1280, height: 900 } });
    s = { kind, browser, context, page: await context.newPage() };
  } else {
    if (profileBusy) throw new Error('The agent profile is in use by another run or the sign-in window. Try again shortly.');
    profileBusy = ctx.runId;
    try {
      const context = await launchProfile(true);
      s = { kind, context, page: context.pages()[0] ?? (await context.newPage()) };
    } catch (e) {
      profileBusy = null;
      throw e;
    }
  }
  await guard(s.context);
  sessions.set(key, s);
  return s;
}

async function closeSessions(runId: string) {
  for (const [key, s] of sessions) {
    if (!key.startsWith(`${runId}:`)) continue;
    sessions.delete(key);
    await (s.browser ? s.browser.close() : s.context.close()).catch(() => {});
    if (s.kind === 'profile') profileBusy = null;
  }
}
onRunEnd(closeSessions);

// --- What the agent sees --------------------------------------------------------------

// Runs in the page: numbers its visible buttons, links and fields, and reads
// its text. Plain JavaScript in a string, because the TypeScript loader adds
// helpers to compiled functions that don't exist inside the page.
const SNAPSHOT_SCRIPT = `(() => {
  const max = ${MAX_ELEMENTS}, chars = ${TEXT_CHARS};
  document.querySelectorAll('[data-eaa-ref]').forEach(e => e.removeAttribute('data-eaa-ref'));
  const visible = e => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const label = e => (e.getAttribute('aria-label') || e.placeholder || e.getAttribute('title') || e.innerText || e.value || e.getAttribute('name') || '')
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

function toolsFor(kind: Session['kind'], prefix: string, actTier: 'T0' | 'T2', where: string): ToolDef[] {
  const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required });
  return [
    {
      id: `${prefix}.open`,
      tier: 'T0',
      description: `Open a web address in ${where}. Returns the page's text and its buttons, links and fields, numbered.`,
      schema: obj({ url: { type: 'string', description: 'The full address, starting http:// or https://' } }, ['url']),
      impl: async (a, ctx) => {
        const s = await session(ctx, kind);
        await s.page.goto(checkUrl(String(a.url ?? '')).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.click`,
      tier: actTier,
      description: `Click a numbered button or link on the current page in ${where}. Returns the page after the click.`,
      schema: obj({ ref: { type: 'number', description: 'The number from the last page you saw' } }, ['ref']),
      impl: async (a, ctx) => {
        const s = await session(ctx, kind);
        await el(s.page, a.ref).click({ timeout: 10_000 });
        await s.page.waitForTimeout(800);
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.type`,
      tier: actTier,
      description: `Type into a numbered field on the current page in ${where} (replacing what's there); submit presses Enter afterwards.`,
      schema: obj({ ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }, ['ref', 'text']),
      impl: async (a, ctx) => {
        const s = await session(ctx, kind);
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
      schema: obj({ direction: { type: 'string', enum: ['down', 'up'] } }, []),
      impl: async (a, ctx) => {
        const s = await session(ctx, kind);
        await s.page.mouse.wheel(0, a.direction === 'up' ? -1600 : 1600);
        await s.page.waitForTimeout(500);
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.back`,
      tier: 'T0',
      description: `Go back to the previous page in ${where}.`,
      schema: obj({}, []),
      impl: async (_a, ctx) => {
        const s = await session(ctx, kind);
        await s.page.goBack({ timeout: 15_000 }).catch(() => {});
        return snapshot(s.page);
      },
    },
  ];
}

export const BROWSER_TOOLS = toolsFor('blank', 'browser', 'T0', 'a blank throwaway browser (no sign-ins)');
export const SIGNED_IN_TOOLS = toolsFor('profile', 'signed_in_browser', 'T2', "the agents' signed-in browser profile, as the person");
registerTools([...BROWSER_TOOLS, ...SIGNED_IN_TOOLS]);

// --- Signing in to the agent profile (Settings) -----------------------------------------

let signInWindow: BrowserContext | null = null;

// Opens the agent profile in a visible window, so the person can sign in to
// the sites agents should use. Closing the window ends it.
export async function openProfileForSignIn(startUrl = 'https://www.google.com') {
  if (signInWindow) return { ok: true, already: true };
  if (profileBusy) throw new Error('An agent is using the profile right now. Try again in a minute.');
  profileBusy = 'sign-in';
  try {
    signInWindow = await launchProfile(false);
    signInWindow.on('close', () => {
      signInWindow = null;
      profileBusy = null;
    });
    const page = signInWindow.pages()[0] ?? (await signInWindow.newPage());
    await page.goto(startUrl).catch(() => {});
    return { ok: true, already: false };
  } catch (e) {
    profileBusy = null;
    signInWindow = null;
    throw e;
  }
}

export const profileStatus = () => ({ open: !!signInWindow, inUse: !!profileBusy && !signInWindow });
