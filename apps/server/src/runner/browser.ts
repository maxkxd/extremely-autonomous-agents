import { lookup } from 'node:dns/promises';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { CdpPage, FRAME_BASE, KEYS, type Bounds, type CdpConn, type Key } from './cdp.js';
import { browserConn, listBrowsers, onBrowserOffline, onBrowserOnline, type LinkedBrowser } from './browser-link.js';
import { checkUrl, isPrivateIp } from './net.js';
import { fileRequest, inWorkspace, onApprovalSettled, onRunEnd, registerTools, tooManyWaiting, type RunCtx, type ToolDef } from './tools.js';
import { all, one, run as exec } from './db.js';
import { setKeptPageCheck } from './kept-pages.js';
import { ACCOUNTS_PER_SITE, confirmPassword, listPasswords, makePassword, passwordRow, profileFor, readPassword, savePassword, siteOf } from './passwords.js';
import { DATA_DIR } from '../paths.js';

// Browsing for agents (docs/browser-extension.md): in the person's own Chrome or
// Edge, through the EXTREMELY extension. The app starts no browser of its own.
//
//   signed_in_browser.*  a paired browser (browser-link.ts). Each paired browser
//                        profile is one browser, numbered 1, 2, 3... Agents work in
//                        tabs of their own there, a collapsed tab group per run,
//                        signed in to sites by the person or by agents themselves -
//                        agents sign up for accounts, keeping each password in the
//                        password store (passwords.ts). A browser holds up to 10
//                        accounts on one site; the next goes in another browser.
//
// A page comes back as its text plus numbered buttons, links and fields; the agent
// clicks or types by number. The pages an agent's tab opens are checked like any
// agent fetch: never this computer or its network.
//
// What only a person can do (a CAPTCHA, a code, Google's sign-in) is done in a normal
// tab of that same browser, with the debugger detached, in a "Waiting on you" group:
// Google, Cloudflare and hCaptcha see a browser nobody is driving.

const TEXT_CHARS = 8_000;
const MAX_ELEMENTS = 100;
// A window's size, for a browser's own DevTools address only (tests): the extension
// opens tabs in the person's window.
const BOUNDS: Bounds = { left: 0, top: 0, width: 1280, height: 900 };
// The tab group a page kept for the person goes in, open (not collapsed).
const WAITING = { key: 'waiting', title: 'Waiting on you' };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// --- The browsers: the person's own, paired through the extension ---------------------

// Tests stand in for the link with browsers of their own (a fake connection).
let testBrowsers: Map<number, { name: string; conn: CdpConn | null }> | null = null;
export function __setBrowserConnForTest(n: number, conn: CdpConn | null, name = `Chrome ${n}`): Promise<void> {
  if (!process.env.NODE_TEST_CONTEXT) throw new Error('For tests only.');
  testBrowsers ??= new Map();
  testBrowsers.set(n, { name, conn });
  if (conn) browserOnline(n, conn);
  else browserOffline(n);
  return shared.get(n)?.adopted ?? Promise.resolve();
}

// The paired browsers, lowest number first.
export const pairedBrowsers = (): LinkedBrowser[] =>
  (testBrowsers ? [...testBrowsers].map(([n, b]) => ({ n, name: b.name, kind: 'chrome' as const, online: !!b.conn && !b.conn.closed })) : listBrowsers()).sort((a, b) => a.n - b.n);
const connOf = (n: number): CdpConn | null => {
  const c = testBrowsers ? (testBrowsers.get(n)?.conn ?? null) : browserConn(n);
  return c && !c.closed ? c : null;
};
const label = (n: number) => {
  const name = pairedBrowsers().find(b => b.n === n)?.name;
  return name ? `browser ${n} (${name})` : `browser ${n}`;
};

// What this file keeps for an online browser: its connection, the runs with a tab in
// it, the tabs being made right now, and when its kept pages have been found again.
type Shared = { n: number; cdp: CdpConn; runs: Set<string>; opening: number; adopted: Promise<void> };
const shared = new Map<number, Shared>();

// The browser, online now - picked up here if the link has it and this file hasn't heard.
function onlineShared(n: number): Shared | null {
  const conn = connOf(n);
  if (!conn) return null;
  const sh = shared.get(n);
  if (sh?.cdp === conn) return sh;
  browserOnline(n, conn);
  return shared.get(n) ?? null;
}

// Online (paired just now, opened, or back after a restart of either side): the pages
// kept for the person found again, and agent tabs nobody's using closed.
function browserOnline(n: number, conn: CdpConn) {
  const had = shared.get(n);
  if (had?.cdp === conn) return;
  if (had) browserOffline(n);
  const sh: Shared = { n, cdp: conn, runs: new Set(), opening: 0, adopted: Promise.resolve() };
  shared.set(n, sh);
  // The person closed a tab kept for them: their request is done.
  conn.on('Target.targetDestroyed', p => tabGone(n, String(p?.targetId ?? '')));
  conn.on('EAA.tabClosedByPerson', p => tabGone(n, String(p?.targetId ?? '')));
  conn.onClose(() => {
    if (shared.get(n) === sh) browserOffline(n);
  });
  sh.adopted = adoptKeptPages(n, sh).catch(e => console.error(`[browser] Browser ${n}: finding the pages kept for the person failed:`, (e as Error).message));
  answerConnectRequests(n);
}

// Offline: every run's tab in it is gone for the run (its pages say closed, and its
// next step says no browser is online). Pages kept for the person stay recorded until
// the browser is back: then they're there, or lost (adoptKeptPages).
function browserOffline(n: number) {
  const sh = shared.get(n);
  shared.delete(n);
  let dropped = 0;
  for (const [key, s] of [...sessions]) {
    if (s.browser !== n) continue;
    sessions.delete(key);
    for (const p of [s.cdp, ...(s.openers ?? [])]) if (p) release(p.targetId);
    dropped++;
  }
  for (const [id, w] of [...waitingPages]) if (!sessions.has(w.key)) waitingPages.delete(id);
  for (const k of kept.values()) if (k.browser === n) k.openers = [];
  if (sh) console.log(`[browser] Browser ${n} went offline${dropped ? `: ${dropped} run tab(s) lost` : ''}.`);
  saveKept();
}

onBrowserOnline((n, conn) => void (!testBrowsers && browserOnline(n, conn)));
onBrowserOffline(n => void (!testBrowsers && browserOffline(n)));

// No browser online: the agent hears plainly, and one request asks the person to
// connect one (not again while it's open). Answered when a browser comes online.
export const NO_BROWSER = "No browser is connected right now. Do other work; you'll be able to browse when the person's browser is online.";
export const CONNECT_A_BROWSER = 'Connect a browser';
function noBrowser(ctx?: RunCtx): Error {
  let id: number | null = null;
  try {
    id = ctx ? connectRequest(ctx) : null;
  } catch (e) {
    console.error('[browser] Filing "Connect a browser" failed:', (e as Error).message);
  }
  return new Error(id != null ? `${NO_BROWSER} Request #${id} asks them to connect one: don't file another.` : NO_BROWSER);
}
function connectRequest(ctx: RunCtx): number | null {
  const open = one<{ id: number }>("SELECT id FROM requests WHERE status = 'open' AND what = ? ORDER BY id LIMIT 1", CONNECT_A_BROWSER);
  if (open) return open.id;
  if (tooManyWaiting(ctx.agent.id)) return null;
  const id = fileRequest(
    ctx.agent.id,
    ctx.runId,
    {
      what: CONNECT_A_BROWSER,
      why: `${ctx.agent.name} works on websites in your own Chrome or Edge, through the EXTREMELY extension, and no browser is online right now.`,
      evidence: 'In Settings > Connectors > Browser, press Connect a browser. If one is paired already, open that browser (with the EXTREMELY extension on) and this is done.',
    },
    ctx.now(),
    ctx.wake,
  );
  exec("UPDATE requests SET stage = 'person' WHERE id = ? AND joined_to IS NULL", id);
  return id;
}
function answerConnectRequests(n: number) {
  try {
    for (const r of all<{ id: number }>("SELECT id FROM requests WHERE status = 'open' AND what = ?", CONNECT_A_BROWSER)) personDone(r.id, `Browser ${n} is online now: you can browse again.`);
  } catch (e) {
    console.error('[browser] Answering "Connect a browser" failed:', (e as Error).message);
  }
}

// Which browser a tool call is for: the one it names (number or name), else the one
// this agent last worked in, else the lowest-numbered online one.
const lastUsed = new Map<string, number>(); // agent id -> browser
function whichBrowser(ctx: RunCtx, raw: unknown): number {
  const paired = pairedBrowsers();
  const online = paired.filter(b => connOf(b.n));
  const listed = (bs: LinkedBrowser[]) => bs.map(b => `${b.n} (${b.name})`).join(', ');
  if (raw != null && String(raw).trim() !== '') {
    const text = String(raw).trim();
    const low = text.toLowerCase();
    const found = /^\d+$/.test(text) ? paired.find(b => b.n === Number(text)) : (paired.find(b => b.name.toLowerCase() === low) ?? paired.find(b => b.name.toLowerCase().includes(low)));
    if (!found) {
      if (!online.length) throw noBrowser(ctx);
      throw new Error(`There's no browser ${text}. The browsers are ${listed(paired)}.`);
    }
    if (online.some(b => b.n === found.n)) return found.n;
    if (!online.length) throw noBrowser(ctx);
    throw new Error(`Browser ${found.n} (${found.name}) isn't online right now. Online: ${listed(online)}. Use one of those, or do other work and come back to it.`);
  }
  const last = lastUsed.get(ctx.agent.id);
  if (last != null && online.some(b => b.n === last)) return last;
  if (!online.length) throw noBrowser(ctx);
  return online[0].n;
}
const browserArg = (a: Record<string, unknown>) => a.browser ?? a.profile;

// Agent tabs open in browser n now: every run's, and the pages kept for the person.
export const agentTabCount = (n: number) => liveTargets(n, false).size;

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

// --- Sessions, one per run and browser ----------------------------------------------------

// A run's tab in a browser. openers: when it's working in a window a site opened, the
// pages behind it, oldest first.
type Driver = CdpPage;
type Windows = { page: Driver; cdp?: CdpPage; openers?: CdpPage[]; followed?: Set<string>; windowClosed?: boolean };
type Session = Windows & { runId: string; browser: number; agent?: { id: string; name: string }; request?: number };
const sessions = new Map<string, Session>();
const sessionKey = (runId: string, n: number) => `${runId}:${n}`;

// Two tool calls at once share one opening, and one that finishes after its run
// ended closes again: either way a tab used to be left open with nobody's run to
// close it.
const sessionOpening = new Map<string, Promise<Session>>();
const endedRuns = new Set<string>();
async function session(ctx: RunCtx, n: number): Promise<Session> {
  const key = sessionKey(ctx.runId, n);
  const existing = sessions.get(key);
  if (existing && backFromClosedWindow(existing)) existing.windowClosed = true;
  if (existing && !existing.page.isClosed()) {
    if (existing.cdp) await untilFree(existing.cdp);
    return existing;
  }
  if (existing) await closeSession(key);
  // A page a person approved a click on, back with this agent to finish the job.
  if (!ctx.approved) {
    const back = [...waitingPages.entries()].find(([, w]) => w.resume === ctx.agent.id && sessions.get(w.key)?.browser === n && !sessions.get(w.key)!.page.isClosed());
    if (back) {
      const [id, w] = back;
      waitingPages.delete(id);
      const s = sessions.get(w.key)!;
      sessions.delete(w.key);
      const sh = shared.get(n);
      sh?.runs.delete(w.key);
      sh?.runs.add(ctx.runId);
      Object.assign(s, { runId: ctx.runId, request: undefined });
      sessions.set(key, s);
      lastUsed.set(ctx.agent.id, n);
      return s;
    }
  }
  // A click a person approved runs on the page it was queued on, kept for it. With
  // that page gone a blank one would only fail ("no [13] on the page") - say why.
  if (ctx.approved)
    throw new Error("The page this click was on closed before it was approved (the agency restarted, or the page was closed), so nothing was clicked. Open the page again, redo the steps, and queue the click once more.");
  let p = sessionOpening.get(key);
  if (!p) {
    p = openSession(ctx, n, key);
    sessionOpening.set(key, p);
    void p.finally(() => sessionOpening.delete(key)).catch(() => {});
  }
  return p;
}
async function openSession(ctx: RunCtx, n: number, key: string): Promise<Session> {
  const sh = onlineShared(n);
  if (!sh) throw noBrowser(ctx);
  sh.runs.add(ctx.runId);
  sh.opening++;
  let s: Session;
  try {
    // In the run's own tab group, titled with the agent's name.
    const page = await CdpPage.open(sh.cdp, BOUNDS, 'about:blank', { eaaGroup: { key: ctx.runId, title: ctx.agent.name } }).finally(() => sh.opening--);
    try {
      await page.guard(allowUrl());
    } catch (e) {
      await page.close();
      throw e;
    }
    s = { runId: ctx.runId, browser: n, page, cdp: page, agent: { id: ctx.agent.id, name: ctx.agent.name } };
  } catch (e) {
    sh.runs.delete(ctx.runId);
    throw e;
  }
  sessions.set(key, s);
  lastUsed.set(ctx.agent.id, n);
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
  await s.page.close().catch(() => {});
  for (const o of s.openers ?? []) await o.close().catch(() => {});
  const sh = shared.get(s.browser);
  if (!sh) return;
  sh.runs.delete(s.runId);
  await closeStrayPages(s.browser, sh).catch(() => 0);
}

// Agent tabs no run is driving: a site's popup or new tab ("Sign in with Google", a
// link that opens a window), left after the run that caused it ended, and the tabs of
// runs from before the agency (or the browser's connection) restarted. Each kept a
// renderer - and its memory - in the person's browser. A popup whose run is still
// going stays (a sign-in completing in it). Only agent tabs are ever listed
// (Target.getTargets in the extension): never one of the person's own.
export function strayPages(targets: { targetId: string; type: string; openerId?: string }[], live: Set<string>) {
  return targets.filter(t => t.type === 'page' && !live.has(t.targetId) && !(t.openerId && live.has(t.openerId))).map(t => t.targetId);
}
// Tabs off the debugger for a moment (tick_security_check): still the run's.
const detaching = new Set<string>();
const liveTargets = (n: number, withBefore = true) =>
  new Set([
    ...[...sessions.values()].filter(x => x.browser === n).flatMap(x => [x.cdp, ...(x.openers ?? [])]).filter((p): p is CdpPage => !!p && !p.isClosed()).map(p => p.targetId),
    ...[...kept.values()].filter(k => k.browser === n).flatMap(k => [k.targetId, ...k.openers.filter(o => !o.isClosed()).map(o => o.targetId)]),
    ...(withBefore ? [...detaching, ...(fromBefore ?? []).filter(k => k.browser === n).map(k => k.targetId)] : []),
  ]);
async function closeStrayPages(n: number, sh: Shared) {
  await sh.adopted;
  await readKept();
  if (sh.opening) return 0; // a tab being made isn't a run's yet: next time
  const { targetInfos } = await sh.cdp.send<{ targetInfos: { targetId: string; type: string; openerId?: string }[] }>('Target.getTargets');
  if (sh.opening) return 0;
  const stray = strayPages(targetInfos, liveTargets(n));
  for (const targetId of stray) await sh.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  return stray.length;
}

const SWEEP_MS = 5 * 60_000;
setInterval(() => {
  for (const [n, sh] of shared) void closeStrayPages(n, sh).catch(() => 0);
}, SWEEP_MS).unref();

// What the Doctor and the Agency Engineer see of the browsers, and can clear (host.ts).
export async function browserCensus() {
  const out: { n: number; name: string; online: boolean; runs: number; tabs: number; kept: number; stray: number }[] = [];
  for (const b of pairedBrowsers()) {
    const sh = onlineShared(b.n);
    const targets = sh ? (await sh.cdp.send<{ targetInfos: { targetId: string; type: string; openerId?: string }[] }>('Target.getTargets', {}, undefined, 5_000).catch(() => ({ targetInfos: [] }))).targetInfos : [];
    out.push({ n: b.n, name: b.name, online: !!sh, runs: sh?.runs.size ?? 0, tabs: targets.filter(t => t.type === 'page').length, kept: [...kept.values()].filter(k => k.browser === b.n).length, stray: sh ? strayPages(targets, liveTargets(b.n)).length : 0 });
  }
  return { browsers: out };
}
// Agent tabs no run is using, closed now in every online browser.
export async function cleanUpBrowsers() {
  let pages = 0;
  for (const [n, sh] of [...shared]) pages += await closeStrayPages(n, sh).catch(() => 0);
  return { pages };
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
// a tab in their browser, and they may not look for days.
const PERSON_MAX_MS = 7 * 24 * 3_600_000;
const PERSON_MAX = 20;
// resume: approved, and back with the agent that queued it, to finish the job (its next run takes it).
type Waiting = { key: string; runId: string; since: number; resume?: string };
const waitingPages = new Map<string, Waiting>(); // by page id (the approval's _page)
setKeptPageCheck(id => waitingPages.has(id));
const pendingFor = (pageId: string) =>
  !!one("SELECT 1 FROM approvals WHERE status = 'pending' AND tool LIKE 'signed_in_browser.click_to_%' AND json_extract(args, '$._page') = ? LIMIT 1", pageId);
const newPageId = () => `wp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

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
async function letGoOf(ids: string[]) {
  for (const id of ids) {
    const w = waitingPages.get(id);
    waitingPages.delete(id);
    if (w) await closeSession(w.key);
  }
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
  const settled = keptForClosed([...kept.values()].map(k => ({ id: k.id, request: k.request })), requestOpen);
  if (settled.length) await letGoOfKept(settled);
  const free = [...waitingPages.entries()].filter(([, w]) => !inPersonsHands(w));
  await letGoOf(pagesToLetGo(free.map(([id, w]) => ({ id, since: w.since })), id => pendingFor(id) || !!waitingPages.get(id)?.resume, now));
  await letGoOfKept(
    pagesToLetGo([...kept.values()].map(k => ({ id: k.id, since: k.since })), () => true, now, PERSON_MAX, PERSON_MAX_MS),
    'it waited too long, or too many pages were waiting',
  );
};

// The run's page in this browser, set aside for a click being queued on it.
async function setAside(ctx: RunCtx, n: number, ref: number) {
  const key = sessionKey(ctx.runId, n);
  const s = sessions.get(key);
  if (!s || !s.cdp || s.page.isClosed()) throw new Error('There is no page open in the browser to click on. Open the page, fill it in, then queue the click.');
  if (!(await s.cdp.evaluateFor<boolean>(ref, inPage(`find(${ref}) !== null`)))) throw new Error(`There's no [${ref}] on the page now - look at it again (scroll, or open it) and use a number from what you see.`);
  const id = newPageId();
  const own = `wait:${id}`;
  sessions.delete(key);
  // Its own user of the browser, so the run ending doesn't close the tab under it.
  sessions.set(own, { ...s, runId: own });
  shared.get(n)?.runs.add(own);
  waitingPages.set(id, { key: own, runId: ctx.runId, since: Date.now() });
  setTimeout(() => void checkWaiting(), UNCLAIMED_MS + 1_000).unref();
  void checkWaiting();
  return { _page: id, _url: await s.page.url() };
}

// --- Pages for the person -----------------------------------------------------------------
//
// What only a person can do on a page the agent has filled in (a CAPTCHA, a code): the
// tab itself waits for them. The debugger comes off it, it moves to the "Waiting on
// you" group, and the request it's filed with brings them straight to it. They do the
// check, press Submit, and close the tab (or press Done on the request).
const siteOfUrl = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
};
// The request's line the app shows as a button (RichText.tsx; it reads "(browser N)",
// and "(profile N)" from requests filed before).
export const BROWSER_LINE = (url: string, n: number) => `Open in signed-in browser: ${url}${n !== 1 ? ` (browser ${n})` : ''}`;
export const GOOGLE_SIGN_IN = 'https://accounts.google.com/';

// The agent's request for it: one per page - a second show_person on the same address
// is the same request.
function requestFor(ctx: RunCtx, n: number, url: string, what: string, why: string, note?: string): { id: number; isNew: boolean } | string {
  const line = BROWSER_LINE(url, n);
  const open = all<{ id: number; evidence: string | null }>("SELECT id, evidence FROM requests WHERE agent_id = ? AND status = 'open' AND evidence LIKE ?", ctx.agent.id, `%${line}%`);
  if (open[0]) return { id: open[0].id, isNew: false };
  const full = tooManyWaiting(ctx.agent.id);
  if (full) return full;
  const said = note ?? `The page is kept as the agent left it, in a tab of ${label(n)} in its "Waiting on you" group: press the button to go straight to it, do what's asked, then close the tab (or press Done here).`;
  const id = fileRequest(ctx.agent.id, ctx.runId, { what, why, evidence: `${line}\n${said}` }, ctx.now(), ctx.wake);
  // It's the person's to do, not the Engineer's to work out: straight to them.
  exec("UPDATE requests SET stage = 'person' WHERE id = ? AND joined_to IS NULL", id);
  return { id, isNew: true };
}

// A page kept for a person's request: a tab in browser n, never attached while it's
// theirs. openers: the pages behind it when it's a window a site opened (a sign-in
// pop-up may need its opener), closed with it.
type KeptRecord = { id: string; browser: number; targetId: string; site: string; url: string; request?: number; agent?: { id: string; name: string }; runId: string; since: number; google?: boolean; captcha?: boolean };
type Kept = KeptRecord & { openers: CdpPage[] };
const kept = new Map<string, Kept>();

// Whether a page shows a human check (Cloudflare's Turnstile, reCAPTCHA, hCaptcha):
// looked at as it's kept, while the debugger is still on it. The app says so on the request.
const CAPTCHA_EXPR = `!!document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="/recaptcha/"], iframe[src*="hcaptcha.com"], .cf-turnstile, .g-recaptcha, .h-captcha, input[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]')`;

async function keepForPerson(ctx: RunCtx, n: number, what: string, why: string) {
  const key = sessionKey(ctx.runId, n);
  const s = sessions.get(key);
  if (!s?.cdp || s.page.isClosed()) throw new Error('There is no page open in your browser to keep. Open the page, fill in everything you can, then call show_person.');
  const sh = shared.get(n);
  if (!sh) throw noBrowser(ctx);
  const url = await s.page.url().catch(() => '');
  const site = siteOfUrl(url);
  if (!site) throw new Error("This page has no web address to keep. Open the page you need the person on first.");
  const r = requestFor(ctx, n, url, what, why);
  if (typeof r === 'string') return r;
  const captcha = !!(await Promise.race([s.page.evaluate<boolean>(CAPTCHA_EXPR).catch(() => false), sleep(2_000).then(() => false)]));
  // Kept before for this request (the agent filled it in again): the new page replaces it.
  await letGoOfKept([...kept.values()].filter(k => k.request === r.id).map(k => k.id));
  const page = s.cdp;
  sessions.delete(key);
  release(page.targetId);
  sh.runs.delete(ctx.runId);
  const k: Kept = { id: newPageId(), browser: n, targetId: page.targetId, site, url, request: r.id, agent: s.agent, runId: ctx.runId, since: Date.now(), captcha, openers: s.openers ?? [] };
  kept.set(k.id, k);
  saveKept();
  // Off the debugger, so Google, Cloudflare and hCaptcha see a browser nobody is driving.
  await page.detach();
  await sh.cdp.send('EAA.groupTab', { targetId: page.targetId, ...WAITING, collapsed: false }).catch(e => console.error(`[browser] Browser ${n}: moving the kept tab to "Waiting on you" failed:`, (e as Error).message));
  watchKept();
  return `This page is kept for the person exactly as it is, in its own tab in ${label(n)} (the "Waiting on you" group, with the debugger off it, so a check like Cloudflare sees a normal browser), and ${r.isNew ? `request #${r.id} is filed` : `request #${r.id} (already filed) points to it now`}. Its button brings them straight to that tab. Your next browser step starts on a new page. Don't file another request for this. You'll hear when they're done: then open the site again and check it worked.`;
}

// Google's sign-in, for the person: a tab in the same browser that's never attached
// (Google refuses any page a debugger is on: "This browser or app may not be secure").
// Whatever they sign in to there, the agents are signed in to: it's one browser.
async function keepGoogle(ctx: RunCtx, n: number, what: string, why: string) {
  const r = requestFor(ctx, n, GOOGLE_SIGN_IN, what, why, `Google's sign-in is open in a tab of ${label(n)} in its "Waiting on you" group: press the button to go to it, sign in, then close the tab (or press Done here). The agents are signed in to Google from then on.`);
  if (typeof r === 'string') return r;
  if ([...kept.values()].some(k => k.request === r.id && k.google)) return `Request #${r.id} is already open for this, with Google's sign-in waiting in its tab in ${label(n)}. You'll hear when they're done.`;
  const sh = onlineShared(n);
  if (!sh) throw noBrowser(ctx);
  const { targetId } = await sh.cdp.send<{ targetId: string }>('Target.createTarget', { url: GOOGLE_SIGN_IN, background: true, eaaGroup: WAITING });
  await sh.cdp.send('EAA.groupTab', { targetId, ...WAITING, collapsed: false }).catch(() => {});
  const k: Kept = { id: newPageId(), browser: n, targetId, site: 'accounts.google.com', url: GOOGLE_SIGN_IN, request: r.id, agent: { id: ctx.agent.id, name: ctx.agent.name }, runId: ctx.runId, since: Date.now(), google: true, openers: [] };
  kept.set(k.id, k);
  saveKept();
  watchKept();
  return `${r.isNew ? `Filed request #${r.id}` : `Request #${r.id} is open for this`}: Google's sign-in is waiting for the person in a normal tab of ${label(n)}, which nothing drives, so Google takes it. Its button brings them to it. ${label(n)} is still yours meanwhile: carry on. You'll hear when they're done; after that "Sign in with Google" on any site is yours (choose the account).`;
}

// Let go of (and closed): done with, replaced, or lost - why says it was lost.
async function letGoOfKept(ids: string[], why?: string) {
  for (const id of ids) {
    const k = kept.get(id);
    if (!k) continue;
    kept.delete(id);
    await connOf(k.browser)?.send('Target.closeTarget', { targetId: k.targetId }).catch(() => {});
    for (const o of k.openers) await o.close().catch(() => {});
    if (why) void keptPageLost(k, why);
  }
  if (ids.length) saveKept();
}

// The person closed a kept tab (the extension says so as it happens).
function tabGone(n: number, targetId: string) {
  const k = [...kept.values()].find(x => x.browser === n && x.targetId === targetId);
  if (k) void finishKept(k.id, 'closed');
}
// And, in case one was missed, a look at the online browsers' tabs now and then.
let keptWatch: ReturnType<typeof setInterval> | undefined;
const KEPT_POLL_MS = 10_000;
function watchKept() {
  if (keptWatch) return;
  keptWatch = setInterval(() => {
    if (!kept.size) {
      clearInterval(keptWatch);
      keptWatch = undefined;
      return;
    }
    void pollKept().catch(() => {});
  }, KEPT_POLL_MS);
  keptWatch.unref?.();
}
async function pollKept() {
  for (const n of new Set([...kept.values()].map(k => k.browser))) {
    const sh = shared.get(n);
    if (!sh) continue;
    await sh.adopted;
    const { targetInfos } = await sh.cdp.send<{ targetInfos: { targetId: string }[] }>('Target.getTargets', {}, undefined, 5_000);
    const there = new Set(targetInfos.map(t => t.targetId));
    for (const k of [...kept.values()]) if (k.browser === n && !there.has(k.targetId)) await finishKept(k.id, 'closed');
  }
}

// The person's done with a kept page (closed its tab, or pressed Done): its request is
// answered, which tells the agent that kept it - not the Engineer, who'd only pass it on.
let personDone: (request: number, text: string) => void = () => {};
export const onPersonDone = (fn: typeof personDone) => void (personDone = fn);
async function finishKept(id: string, how: 'closed' | 'done', note?: string) {
  const k = kept.get(id);
  if (!k) return;
  await letGoOfKept([id]);
  if (k.request == null) return;
  if (note) personDone(k.request, note);
  else if (k.google) personDone(k.request, `${how === 'closed' ? 'Closed' : 'Finished with'} the Google sign-in tab. Check you are signed in to Google now (open the site and sign in with Google - choose the account, nothing to type).`);
  else personDone(k.request, `${how === 'closed' ? 'Closed' : 'Finished with'} the page kept for this on ${k.site}. Open ${k.url} again and check it worked.`);
}
// Finished from the app (the request's Finished button): the kept tab is done too.
export async function finishKeptByRequest(request: number, note: string) {
  const k = [...kept.values()].find(x => x.request === request);
  if (!k) {
    console.error(`[browser] request #${request} has no kept page; telling the agent anyway`);
    personDone(request, note);
    return;
  }
  await finishKept(k.id, 'done', note);
}
export async function finishKeptPage(targetId: string) {
  const k = [...kept.values()].find(x => x.targetId === targetId);
  if (k) await finishKept(k.id, 'done');
}
// A request answered (done, or turned down): the page kept for it is no longer needed.
export async function releaseKeptFor(request: number) {
  await letGoOfKept([...kept.values()].filter(k => k.request === request).map(k => k.id));
}

// Whether a request has a page kept for it: the app shows Finished on the request,
// and its button brings the tab up.
export const hasKeptPage = (request: number) => [...kept.values()].some(k => k.request === request);
// Whether its page showed a human check when it was kept.
export const keptCaptcha = async (request: number) => [...kept.values()].some(k => k.request === request && k.captcha);

// The request's button: the tab kept for it, in front in the person's browser. False
// when there's none, or its browser isn't online.
export async function showKeptPage(request: number): Promise<boolean> {
  const k = [...kept.values()].find(x => x.request === request);
  const conn = k && connOf(k.browser);
  if (!k || !conn) return false;
  try {
    await conn.send('Target.activateTarget', { targetId: k.targetId });
    return true;
  } catch (e) {
    console.error(`[browser] Bringing up the tab kept for request #${request} failed:`, (e as Error).message);
    return false;
  }
}

// "Open a page" for the person (the app's live view): a plain tab of theirs in that
// browser, in front - not an agent tab, so nothing here touches it again.
export async function openPersonTab(raw: unknown, url: string) {
  const n = Number(raw) || pairedBrowsers().find(b => connOf(b.n))?.n;
  const sh = n ? onlineShared(n) : null;
  if (!sh) throw new Error(n ? `Browser ${n} isn't online right now.` : NO_BROWSER);
  const { targetId } = await sh.cdp.send<{ targetId: string }>('Target.createTarget', { url: checkUrl(url).toString(), background: false, eaaGroup: WAITING });
  await sh.cdp.send('Target.activateTarget', { targetId }).catch(() => {});
  await sh.cdp.send('EAA.releaseTab', { targetId }).catch(() => {});
  return targetId;
}

const UNCONFIRMED = "Not confirmed: the sign-up may never have finished, so the account may not exist. Sign in with it yourself before you use it or ask a person to sign in with it; if the site says there's no such account, it was never made - sign up again, or if the site blocks sign-ups, ask the person to create it themselves (show_person on the filled-in sign-up page). Once it works, confirm_password.";

// A kept page gone before the person got to it (the browser closed, it waited too
// long). Everything filled in on it is gone, so the request is closed - a request
// left open would say "everything is filled in" with nothing behind it, and its
// button would open an empty form. The agent is woken and told plainly that nobody
// turned it down: if it still needs it, it fills the page in again and files anew.
export async function keptPageLost(p: { request?: number; site: string; url: string }, why: string) {
  if (p.request == null) return;
  const open = one<{ agent_id: string; what: string }>("SELECT agent_id, what FROM requests WHERE id = ? AND status = 'open'", p.request);
  if (!open) return;
  const now = Date.now();
  const note = `Closed by the agency, not by a person: the page kept for this on ${p.site} closed before anyone got to it (${why}), and what was filled in on it went with it.`;
  // Told in the wake below, so its next run's news doesn't tell it again.
  const closed = exec(
    "UPDATE requests SET status = 'withdrawn', answer = ?, answered_at = ?, delivered_at = ?, stage = NULL WHERE id = ? AND status = 'open'",
    note,
    now,
    now,
    p.request,
  ).changes;
  if (!closed) return;
  const { postToRequest } = await import('./engineer.js');
  const { book } = await import('./scheduler.js');
  postToRequest(p.request, 'engineer', `${note} ${open.agent_id} has been told, and will do it again if it still needs it.`);
  book(
    open.agent_id,
    'request done',
    `Your request #${p.request} ("${open.what.slice(0, 200)}") was closed by the agency - NOT turned down by a person. The page you kept for them on ${p.site} closed before they got to it (${why}), so everything you filled in on it is gone. If you still need it: open ${p.url} again, fill it all in again, and call signed_in_browser.show_person, which files a new request. If you no longer need it, do nothing.`,
  );
}

// --- Kept across restarts --------------------------------------------------------------
//
// The person's browser outlives the agency, so the tabs kept for them do too: which tab
// is which request's is written down here, and picked up again when the browser is
// online (adoptKeptPages). Agent tabs that belong to no run and no kept page are
// closed then - only agent tabs: the extension never lists the person's own.
const KEPT_FILE = join(DATA_DIR, 'browser-kept-pages.json');
// Where the agents' own browser profiles kept theirs, before the extension.
const OLD_KEPT_FILE = join(DATA_DIR, 'browser-profiles', 'kept-pages.json');
let fromBefore: KeptRecord[] | null = null;
let reading: Promise<KeptRecord[]> | null = null;
let saving: ReturnType<typeof setTimeout> | undefined;
function saveKept() {
  clearTimeout(saving);
  saving = setTimeout(() => {
    const list: KeptRecord[] = [...kept.values()].map(({ openers: _, ...k }) => k);
    // What's still to be picked up from before counts too, until it has been.
    for (const k of fromBefore ?? []) if (!list.some(x => x.id === k.id)) list.push(k);
    void writeFile(KEPT_FILE, JSON.stringify({ kept: list })).catch(e => console.error('[browser] Writing the kept pages failed:', (e as Error).message));
  }, 300);
  saving.unref?.();
}
function readKept(): Promise<KeptRecord[]> {
  reading ??= (async () => {
    try {
      const f = JSON.parse(await readFile(KEPT_FILE, 'utf8'));
      fromBefore = (Array.isArray(f.kept) ? f.kept : []).filter((k: KeptRecord) => typeof k?.targetId === 'string' && Number.isInteger(k.browser));
    } catch {
      fromBefore = [];
    }
    return fromBefore!;
  })();
  return reading;
}
void readKept();
// Pages kept in the agents' own browser profiles, before the extension: that browser
// is no longer driven, so their requests are closed and their agents told to redo them.
setTimeout(
  () =>
    void (async () => {
      const f = JSON.parse(await readFile(OLD_KEPT_FILE, 'utf8').catch(() => 'null'));
      if (!Array.isArray(f?.kept)) return;
      for (const k of f.kept) await keptPageLost(k, "agents now work in the person's own browser, not the agents' old one").catch(() => {});
      await rename(OLD_KEPT_FILE, `${OLD_KEPT_FILE}.done`).catch(() => {});
    })().catch(e => console.error('[browser] Closing the requests kept in the old browser failed:', (e as Error).message)),
  60_000,
).unref();

// The browser is online: its kept pages are there or lost, and its stray agent tabs closed.
async function adoptKeptPages(n: number, sh: Shared) {
  const before = await readKept();
  const { targetInfos } = await sh.cdp.send<{ targetInfos: { targetId: string; type: string; openerId?: string }[] }>('Target.getTargets');
  const there = new Set(targetInfos.filter(t => t.type === 'page').map(t => t.targetId));
  let found = 0;
  let lost = 0;
  // Kept while it was offline: still there, or gone with the browser (it restarted).
  for (const k of [...kept.values()].filter(k => k.browser === n)) {
    if (there.has(k.targetId)) {
      found++;
      continue;
    }
    kept.delete(k.id);
    lost++;
    void keptPageLost(k, 'the browser closed');
  }
  // From before the agency restarted.
  for (const k of before.filter(k => k.browser === n)) {
    fromBefore = (fromBefore ?? []).filter(x => x.id !== k.id);
    if (kept.has(k.id)) continue;
    if (!there.has(k.targetId)) {
      lost++;
      void keptPageLost(k, 'the browser closed');
      continue;
    }
    kept.set(k.id, { ...k, openers: [] });
    found++;
  }
  const stray = sh.opening ? [] : strayPages(targetInfos, liveTargets(n));
  for (const targetId of stray) await sh.cdp.send('Target.closeTarget', { targetId }).catch(() => {});
  if (found || lost || stray.length) console.log(`[browser] Browser ${n}: ${found} kept page(s) still there, ${lost} lost; closed ${stray.length} agent tab(s) no run is using.`);
  saveKept();
  if (kept.size) watchKept();
}

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
// Ticks the box, as a person would, and says what happened. alone: the tab was just
// left alone for a moment (tickAlone), so a box gone now passed by itself.
async function tickSecurityCheck(page: Driver, alone = false): Promise<string> {
  const frames = await page.frames().catch(() => []);
  let target: { no: number; box: { width: number; height: number } } | null = null;
  for (const f of frames.filter(f => CHECKBOX_FRAME.test(f.url))) {
    const box = await page.frameBox(f.no);
    if (box?.shown) {
      target = { no: f.no, box };
      break;
    }
  }
  if (!target) return `${alone ? 'The check passed by itself while the tab was left alone: carry on.' : "There's no box to tick on this page now."}\n\n${await snapshot(page)}`;
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

// Cloudflare's Turnstile and hCaptcha notice a debugger attached to the tab - it's much
// of what they check - and keep failing a box a person passes with one click. So the
// debugger comes off the tab first, for a few seconds (the check often passes by
// itself then), and back on to tick the box if it's still there.
let LEAVE_ALONE_MS = 3_000;
export const __leaveAloneForTest = (ms: number) => void (LEAVE_ALONE_MS = ms);
async function tickAlone(s: Session): Promise<string> {
  const page = s.cdp;
  const sh = shared.get(s.browser);
  if (!page || !sh || (await securityCheck(page)) !== 'checkbox') return tickSecurityCheck(s.page);
  const targetId = page.targetId;
  detaching.add(targetId);
  try {
    await page.detach();
    await wait(LEAVE_ALONE_MS);
    const back = await CdpPage.attach(sh.cdp, targetId);
    await back.guard(allowUrl());
    s.cdp = back;
    s.page = back;
  } finally {
    detaching.delete(targetId);
  }
  await settle(s.page, 2_000);
  return tickSecurityCheck(s.page, true);
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
    return "That click opened Google's sign-in. If it lists an account to choose, choose it - that signs you in. If it asks for an email or password instead, Google won't take it from a tab that's being driven: go back (it closes the window) and call signed_in_browser.show_person with google true, once - the person signs in to Google in a normal tab of this same browser, and from then on choosing the account is yours.";
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
const BROWSER_ARG = {
  type: 'string',
  description: 'Which browser: its number ("2") or name. Leave it out for the one you last worked in. signed_in_browser.passwords says which browser an account is in.',
};

function toolsFor(prefix: string, actTier: 'T0' | 'T1', where: string): ToolDef[] {
  const withBrowser = (props: Record<string, unknown>) => ({ ...props, browser: BROWSER_ARG });
  const current = (ctx: RunCtx, a: Record<string, unknown>) => session(ctx, whichBrowser(ctx, browserArg(a)));
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
      schema: obj(withBrowser({ url: { type: 'string', description: 'The full address, starting http:// or https://' } }), ['url']),
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
      description: `Click a numbered button or link on the current page in ${where}. Not the click that pays, posts publicly as the business, or starts a new business tool: those are click_to_pay, click_to_post and click_to_start_tool. On a Copy button, the result starts with what it copied.`,
      schema: obj(withBrowser({ ref: { type: 'number', description: 'The number from the last page you saw' } }), ['ref']),
      impl: click,
    },
    {
      id: `${prefix}.type`,
      tier: actTier,
      description: `Type into a numbered field on the current page in ${where} (replacing what's there); submit presses Enter afterwards. It reads the field back, and one that ignores typing (a date or birthdate box, a masked MM/DD/YYYY or phone field) gets it key by key, then set directly. A date: as the page shows it (01/15/1990) or 1990-01-15. Never a password: type_password types one from the store.`,
      schema: obj(withBrowser({ ref: { type: 'number' }, text: { type: 'string' }, submit: { type: 'boolean' } }), ['ref', 'text']),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        const typed = await s.page.fill(Number(a.ref), String(a.text ?? ''));
        if (a.submit) await s.page.pressEnter();
        await wait(150);
        await settleAt(s.page, Number(a.ref), a.submit ? 4_000 : 1_500);
        if (backFromClosedWindow(s)) return `That window closed, so you're back on the page that opened it.\n\n${await snapshot(s.page)}`;
        return `${typed.ok ? '' : `${didntTake(Number(a.ref), typed.value)}\n\n`}${await snapshot(s.page)}`;
      },
    },
    {
      id: `${prefix}.choose`,
      tier: actTier,
      description: `Pick an option in a numbered dropdown on the current page in ${where}: the option as the page lists it (an exact match, or the one that contains what you give). Works on custom dropdowns too (a button or field that opens a list): it opens the list, types to search it if it has to, and clicks the option.`,
      schema: obj(withBrowser({ ref: { type: 'number' }, option: { type: 'string', description: 'The option to pick, as listed' } }), ['ref', 'option']),
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
      schema: obj(withBrowser({ direction: { type: 'string', enum: ['down', 'up'] } }), []),
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
      schema: obj(withBrowser({}), []),
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
      schema: obj(withBrowser({}), []),
      impl: async (a, ctx) => snapshot((await open(ctx, a)).page),
    },
    {
      id: `${prefix}.press`,
      tier: actTier,
      description: `Press a key in the current page in ${where}, on whatever has the focus: Escape closes most pop-ups and menus, Tab moves to the next field, the arrows move in a list, Enter submits.`,
      schema: obj(withBrowser({ key: { type: 'string', enum: Object.keys(KEYS) } }), ['key']),
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
      description: `Tick the security check's box on the current page in ${where} ("Verify you are human", "I'm not a robot"), once, as a person would. The browser leaves the tab alone for a few seconds first, and the check often passes by itself then. Says whether it passed, or now wants a puzzle - which is the person's.`,
      schema: obj(withBrowser({}), []),
      impl: async (a, ctx) => tickAlone(await open(ctx, a)),
    },
    ...signedInOnly(where, click),
  ];
}

// Files to upload: one from the agent's workspace, or one from the public web, kept
// for the run in a folder of its own. The browser gets its contents, not a path: it
// may be on another computer than the agency.
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
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

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
    await page.fill(ref, want, { retry: false }).catch(() => {});
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

// The field still doesn't hold what was typed after every way in (typed, key by key,
// set directly): said plainly, with what to try next - never a request for a person.
function didntTake(ref: number, value: string) {
  return `[${ref}] didn't keep what you typed: it holds ${value ? `"${value.slice(0, 80)}"` : 'nothing'} (typed, typed key by key, and set directly). Look at the field again: a date may want the form it shows (01/15/1990, or 1990-01-15); separate day, month and year boxes each take their own part; a calendar or list that opens on a click wants its day clicked, or signed_in_browser.choose. A field that won't take typing is never a reason to ask a person.`;
}

// For tests: the page view and its steps, on a page made there.
export const pageViewForTests = { allowAllFrames: () => void (frameAllow = () => async () => true), clickIn: (s: { page: CdpPage; cdp: CdpPage; openers?: CdpPage[] }, ref: number) => clickAndLook(s.page, ref, s as Windows, async () => true), click: (p: CdpPage, ref: number) => clickAndLook(p, ref), snapshot: (p: CdpPage) => snapshot(p), choose: (p: CdpPage, ref: number, option: string) => chooseFromList(p, ref, option), settle: (p: CdpPage, cap?: number, min?: number) => settle(p, cap, min), tick: (p: CdpPage) => tickSecurityCheck(p) };

// What a person's approval of a click clears, by agent and click: the site, until when.
const GRANT_MS = 60 * 60_000;
const grants = new Map<string, { site: string; until: number }>();

// The clicks that always wait for a person (unless they lower them on the Tools page),
// uploads, the password store, and pages for the person.
function signedInOnly(where: string, click: ToolDef['impl']): ToolDef[] {
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
    schema: obj({ ref: { type: 'number', description: 'The number from the last page you saw' }, what: { type: 'string', description: 'For the person approving, in a sentence: exactly what this click does (the plan and price, the post, the tool)' }, browser: BROWSER_ARG }, ['ref', 'what']),
    // Queued: its page is set aside for it (setAside). Approved: the click runs there.
    preview: async (a, ctx) => setAside(ctx, whichBrowser(ctx, browserArg(a)), Number(a.ref)),
    // The rest of a job a person approved: the same click on the same site, within the hour.
    granted: async (a, ctx) => {
      const g = grants.get(`${ctx.agent.id}|${id}`);
      if (!g || g.until < Date.now()) return false;
      let n: number;
      try {
        n = whichBrowser(ctx, browserArg(a));
      } catch {
        return false;
      }
      const s = sessions.get(sessionKey(ctx.runId, n));
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
        return `Nothing was clicked: the page it was queued on had closed (the agency restarted, the browser went offline, the page was closed, or it waited too long). It's approved all the same, so do it yourself now: open ${String(a._url ?? 'the page')} again, redo the steps, and click - ${cleared}.`;
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
      // Back with the agent: its next browser step in this browser continues here.
      w.resume = ctx.agent.id;
      w.since = Date.now();
      return `${done} The page is yours again: your next browser step in browser ${s.browser} continues on it (signed_in_browser.look shows it - don't open it again, that reloads it). Finish the job there: close a pop-up, confirm, press it again - ${cleared}. Then check it went through.\n\n${await snapshot(s.page)}`;
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
          browser: BROWSER_ARG,
        },
        ['ref'],
      ),
      impl: async (a, ctx) => {
        const s = await session(ctx, whichBrowser(ctx, browserArg(a)));
        if (!s.cdp) throw new Error('There is no page open to upload to.');
        const file = a.path ? await workspaceFile(ctx.agent.id, a.path) : a.url ? await download(String(a.url), ctx.runId) : null;
        if (!file) throw new Error('Give path (a file in your workspace) or url (a file on the public web).');
        await stopIfWindowClosed(s);
        const data = { name: basename(file), type: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', base64: (await readFile(file)).toString('base64') };
        if (!(await s.cdp.setFileData(inPage(`fileInput(${Number(a.ref)})`), [data], Number(a.ref))))
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
      description: `Signing up for an account: makes a strong password and keeps it in the agency's password store - you never see it. Type it with signed_in_browser.type_password. Says which browser the account belongs in (a browser holds up to ${ACCOUNTS_PER_SITE} accounts on one site).`,
      schema: obj({ site: { type: 'string', description: 'The site the account is for, e.g. google.com, linkedin.com' }, username: { type: 'string', description: 'The username or email address for the account' }, note: { type: 'string', description: 'What the account is for, for the person' } }, ['site', 'username']),
      impl: async (a, ctx) => {
        const site = siteOf(String(a.site ?? ''));
        const username = String(a.username ?? '').trim();
        if (!username) throw new Error('Give the username or email address the account uses.');
        const paired = pairedBrowsers().map(b => b.n);
        const { profile: n, isNew } = profileFor(site, paired.length ? paired : [1]);
        if (isNew)
          throw new Error(`Every browser already holds ${ACCOUNTS_PER_SITE} ${site} accounts, so another one there needs another browser. Ask the person to connect one more Chrome or Edge profile (Settings > Connectors > Browser, Connect a browser), then make the password again.`);
        const id = await savePassword({ site, username, password: makePassword(), profile: n, agentId: ctx.agent.id, note: a.note ? String(a.note) : null });
        return `Password #${id} made for ${username} at ${site} and kept in the store, marked not confirmed. Sign up in ${label(n)}: pass browser ${n} to the signed_in_browser tools, and type the password with signed_in_browser.type_password, password_id "${id}". Once the sign-up has really finished (you're in the account, or its confirmation is done), call signed_in_browser.confirm_password with "${id}". If the site refuses the sign-up, say so in your notes and memory: the account doesn't exist.`;
      },
    },
    {
      id: 'signed_in_browser.type_password',
      tier: 'T1',
      description: 'Type a password from the store into a numbered password field (you never see it). submit presses Enter afterwards.',
      schema: obj({ ref: { type: 'number' }, password_id: { type: 'string', description: 'The password number from make_password or passwords' }, submit: { type: 'boolean' }, browser: BROWSER_ARG }, ['ref', 'password_id']),
      impl: async (a, ctx) => {
        const row = passwordRow(String(a.password_id ?? ''));
        const s = await session(ctx, whichBrowser(ctx, browserArg(a) ?? row?.profile));
        await stopIfWindowClosed(s);
        const typed = await s.page.fill(Number(a.ref), await readPassword(String(a.password_id ?? '')));
        if (a.submit) await s.page.pressEnter();
        await wait(a.submit ? 1500 : 200);
        // Never what the field holds: that's the password.
        return `${typed.ok ? '' : `[${a.ref}] didn't keep the password as typed (typed, typed key by key, and set directly). Check it's the password field, not one beside it.\n\n`}${await snapshot(s.page)}`;
      },
    },
    {
      id: 'signed_in_browser.passwords',
      tier: 'T0',
      description: "The accounts in the agency's password store: site, username, password number and the browser it's in - never the passwords.",
      schema: obj({ site: { type: 'string', description: 'Only this site (optional)' } }, []),
      impl: async a => {
        const rows = listPasswords(a.site ? String(a.site) : null);
        if (!rows.length) return 'No accounts in the store yet.';
        const list = rows.map(r => `#${r.id} ${r.site} - ${r.username} (browser ${r.profile})${r.confirmed_at ? '' : ' - NOT CONFIRMED'}${r.note ? ` - ${r.note}` : ''}`).join('\n');
        return rows.some(r => !r.confirmed_at) ? `${list}\n\n${UNCONFIRMED}` : list;
      },
    },
    {
      id: 'signed_in_browser.confirm_password',
      tier: 'T0',
      description: "Mark a store account as working: call once you've seen it work - the sign-up finished (you're in the account, its email or code confirmation is done) or you signed in with it. Until then it's NOT CONFIRMED and may not exist.",
      schema: obj({ password_id: { type: 'string', description: 'The password number from make_password or passwords' } }, ['password_id']),
      impl: async a => {
        const row = confirmPassword(String(a.password_id ?? ''));
        return `#${row.id} (${row.username} at ${row.site}) is confirmed.`;
      },
    },
    {
      id: 'signed_in_browser.show_person',
      tier: 'T1',
      description:
        "For what only a person can do on a page: a CAPTCHA puzzle (after tick_security_check didn't pass it), a code sent to their phone, an ID check. Fill in everything else first and call this while you're still on that page: the tab is kept as it is, with the browser's debugger off it (so a check like Cloudflare sees a normal browser), in a \"Waiting on you\" tab group, and a request is filed whose button brings the person straight to it. They do the check, press Submit and close the tab. Don't file a request yourself as well. Your next browser step starts on a new page; get on with other work, and you'll hear when they're done. google true instead: the person signs in to Google in a normal tab of this browser (Google won't let a driven browser sign in) - after that \"Sign in with Google\" on any site is yours: click it and choose the account.",
      schema: obj(
        {
          what: { type: 'string', description: 'For the request\'s title, in 10 words or fewer: what they need to do and why - "Pass the CAPTCHA to send the Tech Talks Daily pitch"' },
          why: { type: 'string', description: "What's filled in and waiting, and what happens once they've done it" },
          google: { type: 'boolean', description: 'True for signing in to Google in this browser, not a page you are on' },
          browser: BROWSER_ARG,
        },
        ['what'],
      ),
      impl: async (a, ctx) => {
        const n = whichBrowser(ctx, browserArg(a));
        const what = String(a.what ?? '').trim();
        const words = what.split(/\s+/).length;
        if (words > 14) return `Not done: what is ${words} words. Make it 10 words or fewer - what they need to do and why - and put the rest in why.`;
        const why = String(a.why ?? '').trim() || what;
        return a.google ? keepGoogle(ctx, n, what, why) : keepForPerson(ctx, n, what, why);
      },
    },
  ];
}

export const SIGNED_IN_TOOLS = toolsFor('signed_in_browser', 'T1', 'the browser');
registerTools(SIGNED_IN_TOOLS);

// --- Watched by a person: the live view (live-view.ts) --------------------------------
//
// Every agent's tab can be watched, and taken over: while the person has a page, the
// agent's browser tools on it wait (that agent, that page only), and only a page
// they've taken gets their input.

export type LiveTab = {
  id: string; // the page's target id
  kind: 'agent';
  browser: number;
  agent: { id: string; name: string } | null;
  page: CdpPage;
  since: number;
  request?: number;
};
const opening = new Map<string, number>(); // when each agent page was first seen
export function liveTabs(): LiveTab[] {
  const tabs: LiveTab[] = [];
  for (const s of sessions.values()) {
    if (!s.cdp || s.cdp.isClosed()) continue;
    const id = s.cdp.targetId;
    if (!opening.has(id)) opening.set(id, Date.now());
    tabs.push({ id, kind: 'agent', browser: s.browser, agent: s.agent ?? null, page: s.cdp, since: opening.get(id)!, request: s.request });
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
  if (!freed) throw new Error("The person has taken over this tab and hasn't handed it back. Work on something else and try it later.");
}

// Browsers the link already had online before this file was loaded (at the end, so
// everything above is set up first).
for (const b of listBrowsers()) {
  const conn = b.online ? browserConn(b.n) : null;
  if (conn && !conn.closed) browserOnline(b.n, conn);
}
