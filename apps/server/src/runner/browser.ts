import { execFile } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, extname, join, normalize, relative } from 'node:path';
import { CdpPage, FRAME_BASE, KEYS, modifierBits, type Bounds, type CdpConn, type MouseButton, type MouseOpts, type Rect } from './cdp.js';
import { browserConn, listBrowsers, managedProfile, onBrowserOffline, onBrowserOnline, type LinkedBrowser } from './browser-link.js';
import { cantOpen, createProfile, failedRecently, openProfile, profilesAvailable, setOnlineSource } from './agent-profiles.js';
import { decodePng, encodeGif } from './gif.js';
import { checkUrl, isPrivateIp } from './net.js';
import type { ToolImage } from './providers.js';
import { fileRequest, inWorkspace, onApprovalSettled, onRunEnd, registerTools, tooManyWaiting, type RunCtx, type ToolDef } from './tools.js';
import { readable } from './web.js';
import { all, one, run as exec } from './db.js';
import { setKeptPageCheck } from './kept-pages.js';
import { ACCOUNTS_PER_SITE, accountsIn, listPasswords, passwordRow, profileFor, readPassword, siteOf } from './passwords.js';
import {
  accountLine,
  accountRow,
  accountsDue,
  accountsInAsk,
  accountsOf,
  accountsOwed,
  askFiled,
  attemptFailed,
  baseDomain,
  cancelAccount,
  canWork,
  dueText,
  holdForRun,
  isAccountAsk,
  judgeAccountPage,
  markWorking,
  needAccounts,
  nudged,
  PAGE_FACTS_EXPR,
  pageKept,
  passwordTyped,
  personFinished,
  startAttempt,
  waitingInRun,
  type AccountRow,
  type PageFacts,
} from './accounts.js';
import { FLEET_ENGINEER } from './agent.js';
import { DATA_DIR } from '../paths.js';

// Browsing for agents (docs/browser-extension.md): in Chrome or Edge, through the
// EXTREMELY extension - the person's own browsers, and the agents' profiles, which the
// app opens by itself when an agent needs one (agent-profiles.ts).
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

// The paired browsers, lowest number first. In tests: theirs, and the link's agents' profiles.
export const pairedBrowsers = (): LinkedBrowser[] =>
  (testBrowsers
    ? [
        ...[...testBrowsers].map(([n, b]) => ({ n, name: b.name, kind: 'chrome' as const, online: !!b.conn && !b.conn.closed, managed: !!managedProfile(n) })),
        ...listBrowsers().filter(b => b.managed && !testBrowsers!.has(b.n)),
      ]
    : listBrowsers()
  ).sort((a, b) => a.n - b.n);
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
const onlineWaiters = new Set<(n: number) => void>(); // agent-profiles.ts, waiting for one it opened
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
  for (const fn of [...onlineWaiters]) {
    try {
      fn(n);
    } catch (e) {
      console.error('[browser] A browser-online waiter failed:', (e as Error).message);
    }
  }
}
setOnlineSource({ isOnline: n => !!connOf(n), subscribe: fn => (onlineWaiters.add(fn), () => void onlineWaiters.delete(fn)) });

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
    recordings.get(key)?.halt();
    recordings.delete(key);
    for (const p of [s.cdp, ...(s.openers ?? []), ...(s.others ?? [])]) if (p) release(p.targetId);
    dropped++;
  }
  for (const [id, w] of [...waitingPages]) if (!sessions.has(w.key)) waitingPages.delete(id);
  for (const k of kept.values()) if (k.browser === n) k.openers = [];
  for (const k of keptOpen.values()) if (k.browser === n) k.page = undefined;
  if (sh) console.log(`[browser] Browser ${n} went offline${dropped ? `: ${dropped} run tab(s) lost` : ''}.`);
  saveKept();
}

onBrowserOnline((n, conn) => void (!testBrowsers && browserOnline(n, conn)));
onBrowserOffline(n => void (!testBrowsers && browserOffline(n)));

// No browser online and none the app can open (no agents' profile, or no Edge or
// Chromium to open one in): the agent hears plainly, and one request asks the person to
// connect one (not again while it's open). Answered when a browser comes online.
export const NO_BROWSER = "No browser is online, and the app can't open one of the agents' own profiles here. Do other work; you'll be able to browse once a browser is connected.";
export const CONNECT_A_BROWSER = 'Connect a browser';
function noBrowser(ctx?: RunCtx): Error {
  let id: number | null = null;
  try {
    id = ctx ? connectRequest(ctx) : null;
  } catch (e) {
    console.error('[browser] Filing "Connect a browser" failed:', (e as Error).message);
  }
  const can = profilesAvailable();
  const why = can.ok ? '' : ` (${can.why})`;
  return new Error(id != null ? `${NO_BROWSER}${why} Request #${id} asks them to connect one: don't file another.` : `${NO_BROWSER}${why}`);
}

// An agents' profile that wouldn't open: the agent hears why, and one request tells the
// person (not again while it's open, and the profile isn't tried again for a while:
// agent-profiles.ts). Answered when that browser comes online.
export const PROFILE_DIDNT_OPEN = (n: number) => `Agents' profile ${n} didn't open`;
function profileFailed(ctx: RunCtx | undefined, n: number, e: unknown): Error {
  const why = (e as Error)?.message ?? String(e);
  let id: number | null = null;
  try {
    id = ctx ? profileRequest(ctx, n, why) : null;
  } catch (err) {
    console.error(`[browser] Filing "${PROFILE_DIDNT_OPEN(n)}" failed:`, (err as Error).message);
  }
  return new Error(`Browser ${n} (the agents' profile ${n}) couldn't be opened: ${why}${id != null ? ` Request #${id} tells the person: don't file another.` : ''} Do other work, or use another browser if one is online.`);
}
function profileRequest(ctx: RunCtx, n: number, why: string): number | null {
  const what = PROFILE_DIDNT_OPEN(n);
  const open = one<{ id: number }>("SELECT id FROM requests WHERE status = 'open' AND what = ? ORDER BY id LIMIT 1", what);
  if (open) return open.id;
  if (tooManyWaiting(ctx.agent.id, ctx.runId)) return null;
  const id = fileRequest(
    ctx.agent.id,
    ctx.runId,
    {
      what,
      why: `${ctx.agent.name} works on websites in the agents' profile ${n}, which the app opens by itself, and it didn't open: ${why}`,
      evidence: `In Settings > Connectors > Browser, press Open beside Agents' profile ${n}. If it still doesn't connect, press Connect this browser to pair your own Chrome or Edge instead.`,
    },
    ctx.now(),
    ctx.wake,
  );
  exec("UPDATE requests SET stage = 'person' WHERE id = ? AND joined_to IS NULL", id);
  return id;
}
function connectRequest(ctx: RunCtx): number | null {
  const open = one<{ id: number }>("SELECT id FROM requests WHERE status = 'open' AND what = ? ORDER BY id LIMIT 1", CONNECT_A_BROWSER);
  if (open) return open.id;
  if (tooManyWaiting(ctx.agent.id, ctx.runId)) return null;
  const can = profilesAvailable();
  const id = fileRequest(
    ctx.agent.id,
    ctx.runId,
    {
      what: CONNECT_A_BROWSER,
      why: `${ctx.agent.name} works on websites in your own Chrome or Edge, through the EXTREMELY extension, and no browser is online right now.`,
      evidence: `In Settings > Connectors > Browser, press Connect this browser (the EXTREMELY extension in your Chrome or Edge). If one is paired already, open that browser and this is done.${can.ok ? '' : ` The app can't open the agents' own profiles here: ${can.why}`}`,
    },
    ctx.now(),
    ctx.wake,
  );
  exec("UPDATE requests SET stage = 'person' WHERE id = ? AND joined_to IS NULL", id);
  return id;
}
function answerConnectRequests(n: number) {
  try {
    for (const r of all<{ id: number }>("SELECT id FROM requests WHERE status = 'open' AND what IN (?, ?)", CONNECT_A_BROWSER, PROFILE_DIDNT_OPEN(n))) personDone(r.id, `Browser ${n} is online now: you can browse again.`);
  } catch (e) {
    console.error('[browser] Answering "Connect a browser" failed:', (e as Error).message);
  }
}

// Which browser a tool call is for: the one it names (number or name), else the one
// this agent last worked in, else the lowest-numbered online one, else an agents'
// profile the app can open (agent-profiles.ts: offline ones count, they open by
// themselves), else - with none at all, where the app can make one - a new one.
const lastUsed = new Map<string, number>(); // agent id -> browser
function whichBrowser(ctx: RunCtx, raw: unknown): number {
  const paired = pairedBrowsers();
  const online = paired.filter(b => connOf(b.n));
  const openable = paired.filter(b => !connOf(b.n) && b.managed && !cantOpen(b.n));
  const usable = [...online, ...openable];
  const listed = (bs: LinkedBrowser[]) => bs.map(b => `${b.n} (${b.name})`).join(', ');
  // Nothing to use: an agents' profile that failed to open says so (its request is
  // filed), rather than a second request asking for a browser.
  const none = () => {
    const stuck = paired.find(b => b.managed && failedRecently(b.n));
    return stuck ? profileFailed(ctx, stuck.n, new Error(failedRecently(stuck.n)!)) : noBrowser(ctx);
  };
  if (raw != null && String(raw).trim() !== '') {
    const text = String(raw).trim();
    const low = text.toLowerCase();
    const found = /^\d+$/.test(text) ? paired.find(b => b.n === Number(text)) : (paired.find(b => b.name.toLowerCase() === low) ?? paired.find(b => b.name.toLowerCase().includes(low)));
    if (!found) {
      if (!usable.length) throw none();
      throw new Error(`There's no browser ${text}. The browsers are ${listed(paired)}.`);
    }
    if (usable.some(b => b.n === found.n)) return found.n;
    if (found.managed && failedRecently(found.n)) throw profileFailed(ctx, found.n, new Error(failedRecently(found.n)!));
    if (!usable.length) throw none();
    throw new Error(`Browser ${found.n} (${found.name}) isn't online right now${found.managed ? ` and can't be opened (${cantOpen(found.n)})` : ''}. Usable now: ${listed(usable)}. Use one of those, or do other work and come back to it.`);
  }
  const last = lastUsed.get(ctx.agent.id);
  if (last != null && usable.some(b => b.n === last)) return last;
  if (usable.length) return usable[0].n;
  // No browser at all yet: the agents' first profile, made here (it opens on first use).
  if (!paired.length && profilesAvailable().ok) {
    try {
      return createProfile();
    } catch (e) {
      console.error("[browser] Making an agents' profile failed:", (e as Error).message);
    }
  }
  throw none();
}

// Browser n's connection, opening it first when it's an agents' profile that's offline
// (two runs needing it share one opening). Its failure is the agent's answer.
async function onlineOrOpen(ctx: RunCtx | undefined, n: number): Promise<Shared> {
  const sh = onlineShared(n);
  if (sh) return sh;
  if (!managedProfile(n)) throw noBrowser(ctx);
  try {
    await openProfile(n);
  } catch (e) {
    throw profileFailed(ctx, n, e);
  }
  const now = onlineShared(n);
  if (!now) throw profileFailed(ctx, n, new Error('It came online and went offline again at once.'));
  return now;
}
const browserArg = (a: Record<string, unknown>) => a.browser ?? a.profile;

// Agent tabs open in browser n now: every run's, the pages kept for the person, and
// tabs agents kept open past their run (keep_open).
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
// pages behind it, oldest first. others: the run's other tabs (signed_in_browser.tabs
// opened them, or it switched away from them). order: each tab's number in the tab
// list, for as long as the run has it, so "tab 2" stays tab 2.
type Driver = CdpPage;
type Windows = { page: Driver; cdp?: CdpPage; openers?: CdpPage[]; others?: CdpPage[]; followed?: Set<string>; windowClosed?: boolean };
type Session = Windows & { runId: string; browser: number; agent?: { id: string; name: string }; request?: number; order?: Map<string, number> };
const sessions = new Map<string, Session>();
const sessionKey = (runId: string, n: number) => `${runId}:${n}`;

// Every tab a run has open in a browser, numbered: the pages behind a window a site
// opened, the one it's on, and its other tabs.
function runTabs(s: Session): CdpPage[] {
  const byId = new Map<string, CdpPage>();
  for (const p of [...(s.openers ?? []), ...(s.cdp ? [s.cdp] : []), ...(s.others ?? [])]) if (!p.isClosed() && !byId.has(p.targetId)) byId.set(p.targetId, p);
  const order = (s.order ??= new Map());
  for (const id of byId.keys()) if (!order.has(id)) order.set(id, order.size + 1);
  return [...byId.values()].sort((a, b) => order.get(a.targetId)! - order.get(b.targetId)!);
}
// Working in another of the run's tabs: the rest wait as they are.
function switchTo(s: Session, page: CdpPage) {
  runTabs(s); // the tabs it has keep their numbers; the new one comes after
  s.others = [...(s.openers ?? []), ...(s.cdp ? [s.cdp] : []), ...(s.others ?? [])].filter(p => p.targetId !== page.targetId && !p.isClosed());
  s.openers = [];
  s.cdp = page;
  s.page = page;
  s.windowClosed = false;
  runTabs(s);
}
// The run's other tabs, closed (one kept open only comes off the debugger): its page
// is going to a person or a waiting click, and the run starts afresh.
async function dropOthers(s: Session) {
  for (const p of s.others ?? []) {
    release(p.targetId);
    if (keptOpen.has(p.targetId)) await park(p);
    else await p.close().catch(() => {});
  }
  s.others = [];
}

// --- Tabs an agent keeps open past its run (signed_in_browser.keep_open) -------------
//
// A run's tabs close when it ends. One the agent marks (a long export still running, a
// dashboard it comes back to) stays, off the debugger, for a day or until the agent
// closes it; that agent's later runs find it in their tab list. Written down with the
// pages kept for the person (KEPT_FILE), so a restart doesn't lose track of it.
const KEEP_OPEN_MS = 24 * 3_600_000;
type KeptOpen = { targetId: string; browser: number; agentId: string; agentName: string; runId: string; reason: string; since: number; until: number; page?: CdpPage };
const keptOpen = new Map<string, KeptOpen>(); // by target id
// A kept-open tab at its run's end: the debugger comes off, the tab stays.
async function park(p: CdpPage) {
  const k = keptOpen.get(p.targetId);
  if (k?.page === p) k.page = undefined;
  await p.detach().catch(() => {});
}
// Past their day: closed, unless a run is in one now (it closes with that run, as any tab).
async function expireKeptOpen(now: number) {
  let changed = false;
  for (const k of [...keptOpen.values()]) {
    if (k.until > now) continue;
    keptOpen.delete(k.targetId);
    changed = true;
    const inUse = [...sessions.values()].some(s => s.browser === k.browser && runTabs(s).some(p => p.targetId === k.targetId));
    if (!inUse) await connOf(k.browser)?.send('Target.closeTarget', { targetId: k.targetId }).catch(() => {});
  }
  if (changed) saveKept();
}

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
  const sh = await onlineOrOpen(ctx, n);
  sh.runs.add(ctx.runId);
  // Counted as opening until it's in sessions: in between (the guard is a round trip)
  // a sweep from another run's end would take the new tab for a stray and close it.
  sh.opening++;
  let s: Session;
  try {
    // In the run's own tab group, titled with the agent's name.
    const page = await CdpPage.open(sh.cdp, BOUNDS, 'about:blank', { eaaGroup: { key: ctx.runId, title: ctx.agent.name } });
    try {
      await page.guard(allowUrl());
    } catch (e) {
      await page.close();
      throw e;
    }
    s = { runId: ctx.runId, browser: n, page, cdp: page, agent: { id: ctx.agent.id, name: ctx.agent.name } };
    sessions.set(key, s);
  } catch (e) {
    sh.runs.delete(ctx.runId);
    throw e;
  } finally {
    sh.opening--;
  }
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
  recordings.get(key)?.halt();
  recordings.delete(key);
  if (s.cdp) release(s.cdp.targetId);
  // Every tab of the run's closes - but one the agent kept open (keep_open) stays.
  for (const p of new Set([s.page, ...(s.cdp ? [s.cdp] : []), ...(s.openers ?? []), ...(s.others ?? [])])) {
    release(p.targetId);
    if (keptOpen.has(p.targetId)) await park(p);
    else await p.close().catch(() => {});
  }
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
    ...[...sessions.values()].filter(x => x.browser === n).flatMap(x => [x.cdp, ...(x.openers ?? []), ...(x.others ?? [])]).filter((p): p is CdpPage => !!p && !p.isClosed()).map(p => p.targetId),
    ...[...kept.values()].filter(k => k.browser === n).flatMap(k => [k.targetId, ...k.openers.filter(o => !o.isClosed()).map(o => o.targetId)]),
    ...[...keptOpen.values()].filter(k => k.browser === n).map(k => k.targetId),
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
  const out: { n: number; name: string; managed: boolean; online: boolean; runs: number; tabs: number; kept: number; stray: number }[] = [];
  for (const b of pairedBrowsers()) {
    const sh = onlineShared(b.n);
    const targets = sh ? (await sh.cdp.send<{ targetInfos: { targetId: string; type: string; openerId?: string }[] }>('Target.getTargets', {}, undefined, 5_000).catch(() => ({ targetInfos: [] }))).targetInfos : [];
    out.push({ n: b.n, name: b.name, managed: b.managed, online: !!sh, runs: sh?.runs.size ?? 0, tabs: targets.filter(t => t.type === 'page').length, kept: [...kept.values()].filter(k => k.browser === b.n).length, stray: sh ? strayPages(targets, liveTargets(b.n)).length : 0 });
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
const PERSON_MAX = 60;
// How long a run waits on the person inside signed_in_browser.wait_for_person before it
// ends and is woken instead. Waiting costs nothing: no model is called meanwhile.
export let WAIT_FOR_PERSON_MIN = 60;
let WAIT_POLL_MS = 1_000;
export const __setWaitForTest = (minutes: number, pollMs: number) => void ((WAIT_FOR_PERSON_MIN = minutes), (WAIT_POLL_MS = pollMs));
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
  await expireKeptOpen(now);
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
  recordings.get(key)?.halt();
  recordings.delete(key);
  // Its own user of the browser, so the run ending doesn't close the tab under it - set
  // before anything is awaited, or a sweep in between would close it as nobody's.
  sessions.set(own, { ...s, runId: own, others: [] });
  shared.get(n)?.runs.add(own);
  // The run's other tabs aren't the waiting click's: they go now, as at the run's end.
  await dropOthers(s);
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
  const full = tooManyWaiting(ctx.agent.id, ctx.runId);
  if (full) return full;
  const said = note ?? `The page is kept as the agent left it, in a tab of ${label(n)} in its "Waiting on you" group: press the button to go straight to it, do what's asked, then press Done here.`;
  const id = fileRequest(ctx.agent.id, ctx.runId, { what, why, evidence: `${line}\n${said}` }, ctx.now(), ctx.wake);
  // It's the person's to do, not the Engineer's to work out: straight to them.
  exec("UPDATE requests SET stage = 'person' WHERE id = ? AND joined_to IS NULL", id);
  return { id, isNew: true };
}

// A page kept for a person's request: a tab in browser n, never attached while it's
// theirs. openers: the pages behind it when it's a window a site opened (a sign-in
// pop-up may need its opener), closed with it.
// account: the account (accounts.ts) the page is a sign-up or sign-in for - such pages
// share ONE request per agent, filed once the whole batch is kept (fileAccountAsk);
// until then request is unset. what, why: the agent's words for that page, for the ask.
type KeptRecord = { id: string; browser: number; targetId: string; site: string; url: string; request?: number; agent?: { id: string; name: string }; runId: string; since: number; google?: boolean; captcha?: boolean; account?: string; what?: string; why?: string };
type Kept = KeptRecord & { openers: CdpPage[] };
const kept = new Map<string, Kept>();

// Whether a page shows a human check (Cloudflare's Turnstile, reCAPTCHA, hCaptcha):
// looked at as it's kept, while the debugger is still on it. The app says so on the request.
const CAPTCHA_EXPR = `!!document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="/recaptcha/"], iframe[src*="hcaptcha.com"], .cf-turnstile, .g-recaptcha, .h-captcha, input[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]')`;

async function keepForPerson(ctx: RunCtx, n: number, what: string, why: string, accountId?: unknown) {
  const key = sessionKey(ctx.runId, n);
  const s = sessions.get(key);
  if (!s?.cdp || s.page.isClosed()) throw new Error('There is no page open in your browser to keep. Open the page, fill in everything you can, then call show_person.');
  const sh = shared.get(n);
  if (!sh) throw noBrowser(ctx);
  const url = await s.page.url().catch(() => '');
  const site = siteOfUrl(url);
  if (!site) throw new Error("This page has no web address to keep. Open the page you need the person on first.");
  // An account's page (named, or the one sign-up this run has going on this site): it
  // waits with the rest of the batch for one request, filed when they're all kept.
  const account = accountId != null && String(accountId).trim() ? ownAccount(ctx, accountId) : signUpHere(ctx, site);
  if (account?.state === 'cancelled') return `Not kept: ${account.id} was cancelled by a person. Leave it.`;
  const r = account ? null : requestFor(ctx, n, url, what, why);
  if (typeof r === 'string') return r;
  const captcha = !!(await Promise.race([s.page.evaluate<boolean>(CAPTCHA_EXPR).catch(() => false), sleep(2_000).then(() => false)]));
  // Kept before for this request or this account (the agent filled it in again): the new page replaces it.
  await letGoOfKept([...kept.values()].filter(k => (r ? k.request === r.id : k.account === account!.id)).map(k => k.id));
  const page = s.cdp;
  sessions.delete(key);
  recordings.get(key)?.halt();
  recordings.delete(key);
  // Kept from here on, before anything is awaited: out of sessions and not yet kept, a
  // sweep in between would close the very tab the person is about to get.
  const k: Kept = { id: newPageId(), browser: n, targetId: page.targetId, site, url, request: r?.id, agent: s.agent ?? { id: ctx.agent.id, name: ctx.agent.name }, runId: ctx.runId, since: Date.now(), captcha, openers: s.openers ?? [], ...(account ? { account: account.id, what, why } : {}) };
  kept.set(k.id, k);
  // The person's now, not the agent's to keep open.
  keptOpen.delete(page.targetId);
  saveKept();
  release(page.targetId);
  sh.runs.delete(ctx.runId);
  await dropOthers(s);
  // Off the debugger, so Google, Cloudflare and hCaptcha see a browser nobody is driving.
  await page.detach();
  await sh.cdp.send('EAA.groupTab', { targetId: page.targetId, ...WAITING, collapsed: false }).catch(e => console.error(`[browser] Browser ${n}: moving the kept tab to "Waiting on you" failed:`, (e as Error).message));
  watchKept();
  if (account) {
    pageKept(account.id, Date.now());
    const left = accountsOwed(ctx.agent.id).filter(x => x.id !== account.id && (x.state === 'needed' || x.state === 'started' || x.state === 'returned'));
    return `Kept for the person exactly as it is, in its own tab in ${label(n)} ("Waiting on you", with the debugger off it), for ${account.id} (${account.username ?? account.site}). No request is filed yet, on purpose: every page of this batch goes to them in ONE request. Your next browser step starts on a new page. ${left.length ? `Now the next account - still to do: ${left.map(x => `${x.id} ${x.site}`).join(', ')}. When each is working or kept like this, call signed_in_browser.wait_for_person.` : 'That was the last one: call signed_in_browser.wait_for_person now - it files the one request and waits for them.'}`;
  }
  if (!r) throw new Error('No request for this page.');
  return `This page is kept for the person exactly as it is, in its own tab in ${label(n)} (the "Waiting on you" group, with the debugger off it, so a check like Cloudflare sees a normal browser), and ${r.isNew ? `request #${r.id} is filed` : `request #${r.id} (already filed) points to it now`}. Its button brings them straight to that tab. Your next browser step starts on a new page. Don't file another request for this. Now carry on with everything else that doesn't need them - above all the rest of this batch (the other sign-ups, the other sites), each filled in up to its check and kept the same way - so they get it all at once. You'll hear when they're done: then open the site again and check it worked.`;
}

// --- Accounts' pages: one request for the whole batch (accounts.ts) ----------------------
//
// A sign-up (or a sign-in) stopped at a check only a person can do is kept like any page
// for the person - but it is never asked for on its own. Twelve sign-ups, one CAPTCHA
// each, used to be twelve requests, filed one per run. Now the pages wait unasked until
// the batch is ready (signed_in_browser.wait_for_person, or the run's end), and go to the
// person in ONE request listing every page with its own button. Pages kept later, while
// that request is still open, join it.
const ownAccount = (ctx: RunCtx, raw: unknown): AccountRow => {
  const row = accountRow(raw);
  if (!row || !canWork(row, ctx.agent.id)) throw new Error(`There's no account ${String(raw ?? '').trim()} of yours. signed_in_browser.accounts lists them.`);
  return row;
};
// The one sign-up this run has going on this site, when show_person didn't say which.
function signUpHere(ctx: RunCtx, site: string): AccountRow | null {
  const going = accountsOwed(ctx.agent.id).filter(r => r.state === 'started' && r.run_id === ctx.runId && [baseDomain(r.site), r.typed_host ? baseDomain(r.typed_host) : ''].includes(baseDomain(site)));
  return going.length === 1 ? going[0] : null;
}
export const ACCOUNT_ASK = 'accounts';
// Each page's line carries which page it is: twelve sign-ups share one address.
const PAGE_MARK = /[#&]eaa-page=(wp_\w+)$/;
const markedUrl = (k: KeptRecord) => `${k.url}${k.url.includes('#') ? '&' : '#'}eaa-page=${k.id}`;
const askPages = (request: number) => [...kept.values()].filter(k => k.request === request && k.account).sort((a, b) => a.since - b.since);
// The request as it stands: only the pages still waiting, each with its own button.
function rewriteAsk(request: number) {
  const pages = askPages(request);
  if (!pages.length) return;
  const sites = [...new Set(pages.map(k => k.site))];
  const what = pages.length === 1 ? `Finish the ${sites[0]} sign-up: one check on its page` : `Finish ${pages.length} sign-ups: one check on each page`;
  const why = `${pages[0].agent?.name ?? 'An agent'} filled in ${pages.length === 1 ? 'this page' : 'each of these pages'} as far as it can go: what's left on ${pages.length === 1 ? 'it' : 'each'} is something only a person can do (a CAPTCHA puzzle, a code sent to your phone). Do the check on each, press Submit there, then press Done beside it. The agent finishes each account as soon as you're done, and the app checks every one really works.`;
  const lines = pages.flatMap((k, i) => {
    const a = accountRow(k.account);
    return [`${i + 1}. ${k.site}${a?.username ? ` - ${a.username}` : ''}: ${(k.what || 'Do the check on this page').slice(0, 160)}`, BROWSER_LINE(markedUrl(k), k.browser)];
  });
  exec("UPDATE requests SET what = ?, why = ?, evidence = ? WHERE id = ? AND status = 'open'", what, why, `${lines.join('\n')}\nEach page is kept exactly as the agent left it, in the "Waiting on you" group of your browser.`, request);
}
// Every page this agent has kept for an account and not asked for yet, in its one
// request: the open one if there is one, else a new one. Its number, or null (nothing to ask).
export function fileAccountAsk(agent: { id: string; name: string }, runId: string | null, now = Date.now()): number | null {
  const fresh = [...kept.values()].filter(k => k.account && k.request == null && k.agent?.id === agent.id);
  let request = one<{ id: number }>("SELECT id FROM requests WHERE agent_id = ? AND status = 'open' AND service = ? ORDER BY id LIMIT 1", agent.id, ACCOUNT_ASK)?.id ?? null;
  if (!fresh.length) return request != null && askPages(request).length ? request : null;
  // Straight to the person (not the Agency Engineer to work out): it's only theirs to do.
  request ??= Number(
    exec("INSERT INTO requests (agent_id, run_id, what, why, created_at, stage, service) VALUES (?, ?, ?, ?, ?, 'person', ?)", agent.id, runId, 'Finish sign-ups', 'Pages waiting on you.', now, ACCOUNT_ASK).lastInsertRowid,
  );
  for (const k of fresh) k.request = request;
  askFiled(fresh.map(k => k.account!), request, now);
  rewriteAsk(request);
  saveKept();
  watchKept();
  return request;
}
// A run over with pages kept and never asked for (it ended without wait_for_person, or
// was cut short): asked for now.
onRunEnd(runId => {
  const agents = new Map([...kept.values()].filter(k => k.account && k.request == null && k.runId === runId && k.agent).map(k => [k.agent!.id, k.agent!]));
  for (const a of agents.values()) fileAccountAsk(a, runId);
});

// An account's page gone before the person did its check: that try failed, the account
// is owed again (its agent is woken for it: accountsTick), and the page leaves the
// request - which closes, by the agency, only when no page of it is left.
async function accountPageLost(p: { request?: number; site: string; account?: string }, why: string) {
  const now = Date.now();
  if (p.account) await attemptFailed(p.account, `the page kept for the person on ${p.site} closed before its check was done (${why})`, now);
  if (p.request == null) return;
  if (askPages(p.request).length) return rewriteAsk(p.request);
  if (accountsInAsk(p.request).some(a => a.state === 'returned')) return void personDone(p.request, 'The pages still waiting were lost; the ones already finished are with the agent.');
  exec(
    "UPDATE requests SET status = 'withdrawn', answer = ?, answered_at = ?, delivered_at = ?, stage = NULL WHERE id = ? AND status = 'open'",
    `Closed by the agency, not by a person: the pages kept for this closed before anyone got to them (${why}). The agent signs up again and asks once more.`,
    now,
    now,
    p.request,
  );
}

// The accounts and their pages, put right whatever happened in between (a restart, a
// request closed by someone else, a run that died): the record never stays on a state
// nothing will move it from. Run with every scheduler tick.
export async function reconcileAccounts(now = Date.now()) {
  await readKept();
  const running = (runId: string | null) => !!runId && !!one("SELECT 1 FROM runs WHERE id = ? AND status = 'running'", runId);
  const withPage = new Set([...kept.values(), ...(fromBefore ?? [])].map(k => k.account).filter(Boolean));
  for (const r of all<AccountRow>("SELECT * FROM accounts WHERE state IN ('started', 'waiting')")) {
    if (r.state === 'started') {
      // A run that ended (or died) mid-sign-up: nothing was seen working, so it failed.
      if (!running(r.run_id) && now - r.updated_at > 60_000) await attemptFailed(r.id, 'the run ended before the sign-up was finished and checked', now);
      continue;
    }
    const req = r.request_id != null ? one<{ status: string }>('SELECT status FROM requests WHERE id = ?', r.request_id) : null;
    if (req?.status === 'rejected') await cancelAccount(r.id, 'A person turned its request down.', now);
    else if (req && req.status !== 'open') personFinished(r.id, now, true);
    else if (!withPage.has(r.id) && now - r.updated_at > 2 * 60_000) await attemptFailed(r.id, 'the page kept for the person was lost', now);
  }
  const unasked = new Map([...kept.values()].filter(k => k.account && k.request == null && k.agent && !running(k.runId)).map(k => [k.agent!.id, k.agent!]));
  for (const a of unasked.values()) fileAccountAsk(a, null, now);
}
// And every account still owed with nobody on it: its agent is woken for it - whatever
// its ferocity, and however long ago it failed - until it works or a person cancels it.
export async function accountsTick(book: (agentId: string, trigger: string, task: string) => void, now = Date.now()) {
  await reconcileAccounts(now);
  for (const [worker, rows] of accountsDue(now)) {
    // In a run now: it has them in front of it (its instructions list them).
    if (one("SELECT 1 FROM runs WHERE agent_id = ? AND status = 'running'", worker)) continue;
    book(worker, 'request done', dueText(rows, worker));
    nudged(rows, now);
  }
}
// The one request for accounts' pages was answered (api.ts): done - each page still
// waiting counts as finished by the person; turned down - they don't want those
// accounts, which are cancelled. Its agent is woken to finish and check them, unless a
// run of it is waiting on this very request (wait_for_person): that run carries on.
export async function accountAskAnswered(request: number, status: 'done' | 'rejected', book: (agentId: string, trigger: string, task: string) => void, now = Date.now()) {
  const rows = accountsInAsk(request);
  for (const r of rows) {
    if (status === 'rejected') await cancelAccount(r.id, 'A person turned its request down.', now);
    else personFinished(r.id, now);
  }
  if (waitingInRun(request)) return;
  const worker = one<{ agent_id: string }>('SELECT agent_id FROM requests WHERE id = ?', request)?.agent_id;
  if (!worker) return;
  exec('UPDATE requests SET delivered_at = ? WHERE id = ?', now, request);
  book(worker, 'request done', askOutcome(request, status));
}
// What its agent hears once the ask is answered.
function askOutcome(request: number, status: 'done' | 'rejected'): string {
  const rows = accountsInAsk(request);
  if (status === 'rejected') return `A person turned down the sign-ups you kept for them, so these accounts are cancelled - don't make them: ${rows.map(r => `${r.id} ${r.site}`).join(', ') || 'all of them'}. The Agency Engineer asks them what they'd rather; carry on with the rest of your job.`;
  const back = rows.filter(r => r.state === 'returned');
  return [
    `The person finished with the pages you kept for them. Now finish each account and have the app check it - they are not working until it says so:`,
    ...back.map(r => accountLine(r)),
    "Each page they left open is in your tabs (signed_in_browser.tabs list): switch to it - don't open it fresh - finish what's left of the sign-up (the next step, a confirmation email's link), open the account's profile or settings page, then signed_in_browser.check_account. One whose tab is gone: open the site and see whether it's signed in. One that didn't go through: start_sign_up again, and if it needs the person again, show_person with its account_id - then wait_for_person once for all of those.",
  ].join('\n');
}

// Google's sign-in, for the person: a tab in the same browser that's never attached
// (Google refuses any page a debugger is on: "This browser or app may not be secure").
// Whatever they sign in to there, the agents are signed in to: it's one browser.
async function keepGoogle(ctx: RunCtx, n: number, what: string, why: string) {
  const r = requestFor(ctx, n, GOOGLE_SIGN_IN, what, why, `Google's sign-in is open in a tab of ${label(n)} in its "Waiting on you" group: press the button to go to it, sign in, then press Done here. The agents are signed in to Google from then on.`);
  if (typeof r === 'string') return r;
  if ([...kept.values()].some(k => k.request === r.id && k.google)) return `Request #${r.id} is already open for this, with Google's sign-in waiting in its tab in ${label(n)}. You'll hear when they're done.`;
  const sh = await onlineOrOpen(ctx, n);
  let k: Kept;
  sh.opening++; // until it's kept: a sweep meanwhile would close it as nobody's
  try {
    const { targetId } = await sh.cdp.send<{ targetId: string }>('Target.createTarget', { url: GOOGLE_SIGN_IN, background: true, eaaGroup: WAITING });
    k = { id: newPageId(), browser: n, targetId, site: 'accounts.google.com', url: GOOGLE_SIGN_IN, request: r.id, agent: { id: ctx.agent.id, name: ctx.agent.name }, runId: ctx.runId, since: Date.now(), google: true, openers: [] };
    kept.set(k.id, k);
  } finally {
    sh.opening--;
  }
  saveKept();
  await sh.cdp.send('EAA.groupTab', { targetId: k.targetId, ...WAITING, collapsed: false }).catch(() => {});
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
  if (keptOpen.get(targetId)?.browser === n) {
    keptOpen.delete(targetId);
    saveKept();
  }
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
  if (k.account) {
    // Its tab is gone, done or not: the agent looks (signed in? check_account says), and
    // the request stays for the pages still waiting.
    personFinished(k.account, Date.now(), k.request == null);
    if (k.request == null) return;
    if (askPages(k.request).length) return rewriteAsk(k.request);
    return personDone(k.request, note ?? 'The person finished with every page.');
  }
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
// The person pressed Done on the request: what they did on the page (a puzzle, a code)
// is what the agent needs next, so the tab stays open and goes back to the agent - into
// its own collapsed group, kept like keep_open for a day - and the request is answered.
// Its next run finds it in tabs list and carries on there.
// url: which page of a request with several (an accounts' request: its own Done beside
// each page) - that one goes back, and the request is answered once none is left.
export async function doneWithKeptPage(request: number, url?: string): Promise<boolean> {
  const pages = [...kept.values()].filter(x => x.request === request);
  const marked = PAGE_MARK.exec(url ?? '')?.[1];
  // Its Done pressed twice: already back with the agent.
  if (marked && !pages.some(x => x.id === marked)) return pages.length > 0 || isAccountAsk(request);
  const now = Date.now();
  const giveBack = async (k: Kept) => {
    kept.delete(k.id);
    for (const o of k.openers) await o.close().catch(() => {});
    const conn = connOf(k.browser);
    if (conn && k.agent) {
      await conn.send('EAA.groupTab', { targetId: k.targetId, key: `back:${k.agent.id}`, title: k.agent.name, collapsed: true }).catch(e => console.error(`[browser] Giving request #${request}'s tab back to ${k.agent!.name} failed:`, (e as Error).message));
      keptOpen.set(k.targetId, { targetId: k.targetId, browser: k.browser, agentId: k.agent.id, agentName: k.agent.name, runId: k.runId, reason: `The person finished request #${request} on this page`, since: now, until: now + KEEP_OPEN_MS });
    }
    if (k.account) personFinished(k.account, now);
  };
  if (pages.some(x => x.account)) {
    for (const k of marked ? pages.filter(x => x.id === marked) : pages) await giveBack(k);
    saveKept();
    if (askPages(request).length) rewriteAsk(request);
    else personDone(request, 'The person finished with every page.');
    return true;
  }
  const k = pages[0];
  if (!k) return false;
  await giveBack(k);
  saveKept();
  personDone(
    request,
    k.google
      ? 'Done: the person signed in to Google. Choose the account when a site asks ("Sign in with Google") - nothing to type.'
      : `Done: the person finished what was needed on the page on ${k.site} and left it open for you. It's in your tabs: signed_in_browser.tabs list, then switch to it (${k.url}) and carry on from where it is now - don't open it fresh.`,
  );
  return true;
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
// The request's button. shown: the tab is in front. offline: it's still kept, in a
// browser that isn't connected right now. gone: nothing is kept for it any more (lost
// before an update, or the tab went) - the request is closed there and then and its
// agent told, so a dead button never sits on a card.
// opened: a button that isn't the request's own kept page (a link the Agency Engineer
// or the agent wrote on the card, "open x.com in the agents' browser") - that address
// opens as a plain tab of the person's in that browser. Only the request's own page
// button closes the request when its page is gone.
// finished: that page of a request with several is already back with the agent.
// The page's browser offline: an agents' profile is opened (as for an agent), its kept
// pages found again or closed as lost, and the button tried once more - it opens the
// browser rather than telling the person to.
export async function showKeptPage(request: number, button?: { url?: string; browser?: number }, retried = false): Promise<'shown' | 'offline' | 'gone' | 'opened' | 'finished'> {
  const offline = async (p: { id: string; browser: number }) => {
    const n = p.browser;
    if (retried || !managedProfile(n) || cantOpen(n)) return 'offline' as const;
    try {
      await openProfile(n);
      await onlineShared(n)?.adopted;
    } catch (e) {
      console.error(`[browser] Opening browser ${n} for request #${request} failed:`, (e as Error).message);
      return 'offline' as const;
    }
    if (!kept.has(p.id)) {
      // Still waiting to be found: finding the browser's pages failed, so nothing is known.
      if ((fromBefore ?? []).some(x => x.id === p.id)) return 'offline' as const;
      // Not in it (the person closed the tab): adoptKeptPages has told its agent.
      return 'gone' as const;
    }
    return showKeptPage(request, button, true);
  };
  // Pages kept from before a restart not yet found again (readKept's own list is the
  // file as read at start, so it would still list ones found or lost since).
  const waiting = async () => (await readKept(), fromBefore ?? []);
  const marked = PAGE_MARK.exec(button?.url ?? '')?.[1];
  const k = [...kept.values()].find(x => x.request === request && (!marked || x.id === marked));
  if (marked && !k) {
    const w = (await waiting()).find(x => x.id === marked);
    return w ? offline(w) : 'finished';
  }
  if (!k) {
    const w = (await waiting()).find(x => x.request === request);
    if (w) return offline(w);
    const own = /Open in signed-in browser:\s*(https?:\/\/\S+)/.exec(one<{ evidence: string | null }>('SELECT evidence FROM requests WHERE id = ?', request)?.evidence ?? '')?.[1];
    if (button?.url && button.url !== own) {
      await openPersonTab(button.browser, button.url);
      return 'opened';
    }
    if (!own) throw new Error('There is no page to open for this.');
    await requestPageLost(request, 'it was no longer open when the button was pressed');
    return 'gone';
  }
  const conn = connOf(k.browser);
  if (!conn) return offline(k);
  try {
    await conn.send('Target.activateTarget', { targetId: k.targetId });
    return 'shown';
  } catch (e) {
    console.error(`[browser] Bringing up the tab kept for request #${request} failed:`, (e as Error).message);
    kept.delete(k.id);
    saveKept();
    await keptPageLost(k, 'its tab was no longer there');
    return 'gone';
  }
}

// An open request whose button points at a page nothing keeps any more: closed as lost,
// with the address from its own button line.
async function requestPageLost(request: number, why: string) {
  const r = one<{ evidence: string | null }>("SELECT evidence FROM requests WHERE id = ? AND status = 'open'", request);
  const url = /Open in signed-in browser:\s*(https?:\/\/\S+)/.exec(r?.evidence ?? '')?.[1];
  if (!url) return;
  await keptPageLost({ request, site: siteOfUrl(url), url }, why);
}

// Requests whose page went before this version could close them (their button stayed,
// and pressing it said "That page is gone."): once at start, after the kept pages are
// read, every open one with a page button and no kept page is closed and its agent told.
// Requests a few minutes old are left alone: their page may be on its way to the list.
export async function closeRequestsWithLostPages(now = Date.now()) {
  const keptFor = new Set([...(await readKept()), ...kept.values()].map(k => k.request).filter(r => r != null));
  const open = all<{ id: number; created_at: number }>("SELECT id, created_at FROM requests WHERE status = 'open' AND evidence LIKE '%Open in signed-in browser:%'");
  let n = 0;
  for (const r of open) {
    if (keptFor.has(r.id) || now - Number(r.created_at) < 5 * 60_000) continue;
    await requestPageLost(r.id, 'it was lost before an update');
    n++;
  }
  if (n) console.log(`[browser] Closed ${n} request(s) whose kept page was already gone.`);
  return n;
}
setTimeout(() => void closeRequestsWithLostPages().catch(e => console.error('[browser] Closing requests with lost pages failed:', (e as Error).message)), 90_000).unref();

// "Open a page" for the person (the app's live view): a plain tab of theirs in that
// browser, in front - not an agent tab, so nothing here touches it again.
export async function openPersonTab(raw: unknown, url: string) {
  const n = Number(raw) || pairedBrowsers().find(b => connOf(b.n))?.n || pairedBrowsers().find(b => b.managed && !cantOpen(b.n))?.n;
  let sh = n ? onlineShared(n) : null;
  // An agents' profile opens for it, as it does for an agent.
  if (!sh && n && managedProfile(n) && !cantOpen(n)) sh = await openProfile(n).then(() => onlineShared(n));
  if (!sh) throw new Error(n ? `Browser ${n} isn't online right now${managedProfile(n) && cantOpen(n) ? `: ${cantOpen(n)}` : ''}.` : NO_BROWSER);
  // Counted as opening until released: until then it's an agent tab no run has, which
  // a sweep would close under the person.
  sh.opening++;
  try {
    const { targetId } = await sh.cdp.send<{ targetId: string }>('Target.createTarget', { url: checkUrl(url).toString(), background: false, eaaGroup: WAITING });
    await sh.cdp.send('Target.activateTarget', { targetId }).catch(() => {});
    await sh.cdp.send('EAA.releaseTab', { targetId }).catch(e => console.error(`[browser] Browser ${n}: handing the opened tab to the person failed:`, (e as Error).message));
    return targetId;
  } finally {
    sh.opening--;
  }
}

const UNCONFIRMED = "Not confirmed: saved before the app checked sign-ups itself, so the account may not exist. Before you use one, or ask a person to: sign in with it, open its profile or settings page, and call signed_in_browser.check_account with its password_id - the app confirms it, or says why not. If the site says there's no such account, it was never made.";

// A kept page gone before the person got to it (the browser closed, it waited too
// long). Everything filled in on it is gone, so the request is closed - a request
// left open would say "everything is filled in" with nothing behind it, and its
// button would open an empty form. The agent is woken and told plainly that nobody
// turned it down: if it still needs it, it fills the page in again and files anew.
export async function keptPageLost(p: { request?: number; site: string; url: string; account?: string }, why: string) {
  if (p.account || (p.request != null && isAccountAsk(p.request))) return accountPageLost(p, why);
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
    const open = [...keptOpen.values()].map(({ page: _, ...k }) => k);
    void writeFile(KEPT_FILE, JSON.stringify({ kept: list, open })).catch(e => console.error('[browser] Writing the kept pages failed:', (e as Error).message));
  }, 300);
  saving.unref?.();
}
function readKept(): Promise<KeptRecord[]> {
  reading ??= (async () => {
    try {
      const f = JSON.parse(await readFile(KEPT_FILE, 'utf8'));
      fromBefore = (Array.isArray(f.kept) ? f.kept : []).filter((k: KeptRecord) => typeof k?.targetId === 'string' && Number.isInteger(k.browser));
      // Tabs agents kept open (keep_open), still within their day.
      for (const k of Array.isArray(f.open) ? (f.open as KeptOpen[]) : [])
        if (typeof k?.targetId === 'string' && Number.isInteger(k.browser) && k.until > Date.now() && !keptOpen.has(k.targetId)) keptOpen.set(k.targetId, { ...k, page: undefined });
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
  // Tabs agents kept open: gone with the browser if it restarted.
  for (const k of [...keptOpen.values()]) if (k.browser === n && !there.has(k.targetId)) keptOpen.delete(k.targetId);
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
  // Installed by this version (a tab kept from before the agency was updated may have an older one).
  if (window.__eaa && window.__eaa.search) return window.__eaa;
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
  // Numbering carries on after any the page already has (helpers put in again, above).
  const st = { next: [...document.querySelectorAll('[data-eaa-ref]')].reduce((m, e) => Math.max(m, +e.getAttribute('data-eaa-ref') || 0), window.__eaaBase || 0), keys: {} };
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
  const cut = (t, chars) => t.length > chars ? t.slice(0, chars) + '\\n[text cut off]' : t;
  // One element's part of the page (look with ref): its text and the controls in it.
  const viewIn = (ref, max, chars) => {
    const c = find(ref);
    if (!c) return null;
    const all = controls().filter(x => x === c || c.contains(x));
    number(all);
    const items = all.slice(0, max).map(e => describe(e, e.getAttribute('data-eaa-ref')));
    if (all.length > max) items.push('(' + (all.length - max) + ' more in it)');
    return { title: document.title, text: cut((c.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim(), chars), items };
  };
  // The controls whose kind, label, text, placeholder, name or role holds q (find).
  const search = (q, max) => {
    const w = textOf(q).toLowerCase();
    const all = controls();
    number(all);
    const hits = all.filter(e => [describe(e, ''), e.getAttribute('placeholder'), e.getAttribute('aria-label'), e.getAttribute('title'), e.getAttribute('name'), e.getAttribute('role'), labelOf(e), textOf(e.innerText).slice(0, 300)].join(' ').toLowerCase().includes(w));
    return { hits: hits.slice(0, max).map(e => describe(e, e.getAttribute('data-eaa-ref'))), total: hits.length };
  };
  return (window.__eaa = { view, find, pickOption, fileInput, settle, listIn, viewIn, search });
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

// The page's text and its numbered controls. look's choices: interactive - the
// controls only, no text; ref - only that element's part of the page; chars - how
// much of the text.
type LookOpts = { interactive?: boolean; ref?: number; chars?: number };
async function snapshot(page: Driver, opts: LookOpts = {}): Promise<string> {
  await page.ready();
  const chars = opts.chars ?? TEXT_CHARS;
  const view =
    opts.ref != null
      ? await evalAt<PageView | null>(page, opts.ref, inPage(`viewIn(${opts.ref}, ${MAX_ELEMENTS}, ${chars})`))
      : await page.evaluate<PageView>(inPage(`view(${MAX_ELEMENTS}, ${chars})`));
  if (!view) throw new Error(`There's no [${opts.ref}] on the page now - look at it again and use a number from what you see.`);
  const dialogs = page.takeDialogs();
  const text = opts.interactive ? [] : [view.text || '(no text)', ''];
  const what = opts.ref != null ? `What you can use in [${opts.ref}] (by number)` : 'What you can use (by number)';
  return [
    ...(dialogs.length ? [`The page asked (answered OK): ${dialogs.join('; ')}`, ''] : []),
    `Title: ${view.title || '(none)'}`,
    `URL: ${await page.url()}`,
    ...(opts.ref != null ? [`Only [${opts.ref}] and what's in it:`] : []),
    '',
    ...text,
    view.items.length ? `${what}:\n${view.items.join('\n')}` : opts.ref != null ? `Nothing to click in [${opts.ref}].` : 'Nothing to click on this page.',
    ...(opts.ref != null ? [] : await frameSections(page, opts)),
  ].join('\n');
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
async function frameSections(page: Driver, opts: LookOpts = {}): Promise<string[]> {
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
    out.push('', `In a frame on this page (${host}):`, ...(opts.interactive ? [] : [view.text || '(no text)', '']), view.items.length ? `What you can use in that frame (by number):\n${view.items.join('\n')}` : 'Nothing to click in that frame.');
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
  // The tab it was on closed by itself, and it has others: the last one it was in.
  if (s.cdp?.isClosed() && s.others?.some(p => !p.isClosed())) {
    s.others = s.others.filter(p => !p.isClosed());
    s.cdp = s.others.pop()!;
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
// at: a number on the page, or a point on the screen (CSS pixels, as a screenshot shows).
async function clickAndLook(page: Driver, at: number | { x: number; y: number }, s?: Windows, allow = allowUrl(), opts: MouseOpts = {}): Promise<string> {
  await page.evaluateInPage(COPY_WATCH).catch(() => {});
  try {
    if (typeof at === 'number') await page.click(at, opts);
    else await page.clickAt(at.x, at.y, opts);
  } catch (e) {
    void page.evaluateInPage(COPY_TAKE).catch(() => {});
    if (!s?.openers?.length || !page.isClosed()) throw e; // a click that closes its own window
  }
  await wait(150);
  if (typeof at === 'number') await settleAt(page, at);
  else await settle(page);
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

// --- Pointing without a number: points, screenshots, recordings -------------------------

const given = (v: unknown) => v !== undefined && v !== null && v !== '';
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round2 = (n: number) => Math.round(n * 100) / 100;
// Where the agent pointed: a number on the page, or x and y from a screenshot.
function pointArg(a: Record<string, unknown>, ref = 'ref', x = 'x', y = 'y'): number | { x: number; y: number } {
  if (given(a[ref])) {
    const n = Number(a[ref]);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${ref}: a number from the page, like 12.`);
    return n;
  }
  if (given(a[x]) && given(a[y])) {
    const p = { x: Number(a[x]), y: Number(a[y]) };
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.y < 0) throw new Error(`${x} and ${y}: a point on the screen, in pixels from its top left (as a screenshot shows it).`);
    return p;
  }
  throw new Error(`Give ${ref} (a number from the page) or ${x} and ${y} (a point in a screenshot).`);
}
const pointOn = async (page: Driver, at: number | { x: number; y: number }) => (typeof at === 'number' ? page.pointOf(at) : at);
function mouseOpts(a: Record<string, unknown>): MouseOpts {
  const button = (given(a.button) ? String(a.button).toLowerCase() : 'left') as MouseButton;
  if (!['left', 'right', 'middle'].includes(button)) throw new Error('button: left, right or middle.');
  const count = given(a.count) ? Number(a.count) : 1;
  if (![1, 2, 3].includes(count)) throw new Error('count: 1, 2 (a double click) or 3 (a triple click).');
  return { button, count, modifiers: modifierBits(a.modifiers) };
}

// What the agent saves (screenshots, recordings) goes in its workspace, the newest few
// of each kind: a long job takes hundreds.
let fileSeq = 0;
const stamp = () => `${new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)}-${String(fileSeq++ % 1000).padStart(3, '0')}`;
async function saveToWorkspace(agentId: string, dir: string, name: string, data: Buffer, keep: number): Promise<string> {
  const rel = `${dir}/${name}`;
  const full = inWorkspace(agentId, rel);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
  const files = (await readdir(dirname(full)).catch(() => [] as string[])).filter(f => /\.(jpg|png|gif|mp4)$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) await rm(join(dirname(full), f), { force: true }).catch(() => {});
  return rel;
}

// A picture of the tab - what's on screen, one element, a region zoomed in on, or the
// whole page - as JPEG at most SHOT_MAX pixels across. Its coordinates are the page's
// CSS pixels, which coordinate clicks take, and the answer says how to turn a point in
// the picture into one. It's saved in the workspace too: a model that can't be shown
// pictures (providers.ts) gets the path.
const SHOT_MAX = 1600;
const SHOTS_KEPT = 40;
type Shot = { text: string; images: ToolImage[] };
async function shoot(page: Driver, agentId: string, a: Record<string, unknown>, zoom: boolean): Promise<Shot> {
  await page.ready();
  const box = !zoom && given(a.ref) ? await page.box(Number(a.ref)) : null; // scrolled into view first
  const v = await page.viewport();
  const onScreen = (r: Rect) => {
    const x0 = clamp(r.x, 0, v.w), y0 = clamp(r.y, 0, v.h), x1 = clamp(r.x + r.width, 0, v.w), y1 = clamp(r.y + r.height, 0, v.h);
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  };
  let clip: Rect;
  let scale: number;
  let full = false;
  if (zoom) {
    const r = Array.isArray(a.region) ? a.region.map(Number) : [];
    if (r.length !== 4 || r.some(n => !Number.isFinite(n))) throw new Error('region: [x0, y0, x1, y1], two corners of the part to zoom in on, in pixels from a screenshot.');
    clip = onScreen({ x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]), width: Math.abs(r[2] - r[0]), height: Math.abs(r[3] - r[1]) });
    if (clip.width < 4 || clip.height < 4) throw new Error(`That region is off the screen or too small. The screen is ${v.w}x${v.h}: give two corners inside it, a few pixels apart at least.`);
    scale = Math.min(4, SHOT_MAX / clip.width, SHOT_MAX / clip.height);
  } else if (box) {
    clip = onScreen({ x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 });
    if (clip.width < 1 || clip.height < 1) throw new Error(`[${String(a.ref)}] isn't showing on the screen (it may be hidden). Look at the page again.`);
    scale = Math.min(2, SHOT_MAX / clip.width, SHOT_MAX / clip.height);
  } else if (a.full_page) {
    full = true;
    clip = { x: 0, y: 0, width: v.cw, height: Math.min(v.ch, 16_000) };
    scale = Math.min(1, SHOT_MAX / clip.width, 8_000 / clip.height);
  } else {
    clip = { x: 0, y: 0, width: v.w, height: v.h };
    scale = Math.min(1, SHOT_MAX / v.w);
  }
  // DevTools takes the clip from the top of the document; the agent's points are the screen's.
  const data = await page.capture(full ? clip : { ...clip, x: clip.x + v.x, y: clip.y + v.y }, scale, { dpr: v.dpr, beyond: full });
  const w = Math.round(clip.width * scale), h = Math.round(clip.height * scale);
  const s = round2(scale);
  let said: string;
  if (full)
    said = `The whole page${v.ch > clip.height ? ` (its first ${clip.height} pixels)` : ''}: ${w}x${h}, at ${s}x. Its y is from the top of the page, not of the screen: to click something in it, scroll there and take a screenshot first.`;
  else if (zoom || box)
    said = `${zoom ? 'Zoomed in on' : `[${String(a.ref)}], showing`} the screen from (${round2(clip.x)}, ${round2(clip.y)}) to (${round2(clip.x + clip.width)}, ${round2(clip.y + clip.height)}), at ${s}x (${w}x${h}): a point (px, py) in it is x = ${round2(clip.x)} + px / ${s}, y = ${round2(clip.y)} + py / ${s} for click, hover or drag.`;
  else
    said =
      s === 1
        ? `Screenshot of the tab as it is now: ${w}x${h}, one picture pixel per page pixel - a point in it is the x, y to give click, hover or drag.`
        : `Screenshot of the tab as it is now: ${w}x${h}, shrunk to ${s}x - divide a point's x and y by ${s} for click, hover or drag.`;
  const rel = await saveToWorkspace(agentId, 'browser/screenshots', `${stamp()}.jpg`, Buffer.from(data, 'base64'), SHOTS_KEPT);
  return { text: `${said}\nSaved in your workspace as ${rel}.`, images: [{ data, mimeType: 'image/jpeg' }] };
}

// A recording of the tab: start, then stop writes it to the workspace. An MP4 from the
// tab's screencast when ffmpeg is on this computer's PATH; else an animated GIF of
// screenshots taken a few times a second (the screencast's frames are JPEG, which
// nothing here can decode - gif.ts reads PNG). At most a minute, 300 frames.
const RECORD_MAX_MS = 60_000;
const RECORD_MAX_FRAMES = 300;
const GIF_EVERY_MS = 400;
const GIF_WIDTH = 800;
type Recording = { mode: 'mp4' | 'gif'; frames: { data: string; at: number }[]; started: number; ended?: number; halt: () => void };
const recordings = new Map<string, Recording>(); // by session key
let ffmpegFound: Promise<boolean> | null = null;
const hasFfmpeg = () => (ffmpegFound ??= new Promise(done => execFile('ffmpeg', ['-version'], { timeout: 5_000, windowsHide: true }, e => done(!e))));
export const __setFfmpegForTest = (found: boolean) => void (ffmpegFound = Promise.resolve(found));

async function startRecording(key: string, page: Driver): Promise<Recording> {
  if (recordings.has(key)) throw new Error("You're already recording in this browser: signed_in_browser.record stop first.");
  const rec: Recording = { mode: (await hasFfmpeg()) ? 'mp4' : 'gif', frames: [], started: Date.now(), halt: () => {} };
  const room = () => rec.frames.length < RECORD_MAX_FRAMES && Date.now() - rec.started < RECORD_MAX_MS;
  let stopCapture: () => unknown;
  if (rec.mode === 'mp4') {
    stopCapture = await page.screencast(f => void (room() && rec.frames.push({ data: f.data, at: Date.now() })));
  } else {
    let busy = false;
    const grab = async () => {
      if (busy || !room() || page.isClosed()) return;
      busy = true;
      try {
        const v = await page.viewport();
        const data = await page.capture({ x: v.x, y: v.y, width: v.w, height: v.h }, Math.min(1, GIF_WIDTH / v.w), { format: 'png', dpr: v.dpr });
        // The same picture again: the last frame just shows longer.
        if (rec.frames.at(-1)?.data !== data) rec.frames.push({ data, at: Date.now() });
      } catch {
        // A page mid-navigation: the next one.
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void grab(), GIF_EVERY_MS);
    timer.unref?.();
    await grab();
    stopCapture = () => clearInterval(timer);
  }
  const cap = setTimeout(() => rec.halt(), RECORD_MAX_MS);
  cap.unref?.();
  rec.halt = () => {
    if (rec.ended) return;
    rec.ended = Date.now();
    clearTimeout(cap);
    void Promise.resolve(stopCapture()).catch(() => {});
  };
  recordings.set(key, rec);
  return rec;
}

const ffmpeg = (args: string[]) =>
  new Promise<void>((done, fail) =>
    execFile('ffmpeg', args, { timeout: 180_000, windowsHide: true }, (e, _out, err) => (e ? fail(new Error(String(err || e.message).trim().split('\n').pop())) : done())),
  );
async function stopRecording(key: string, agentId: string): Promise<string> {
  const rec = recordings.get(key);
  if (!rec) throw new Error("You aren't recording in this browser: signed_in_browser.record start first.");
  rec.halt();
  recordings.delete(key);
  const frames = rec.frames;
  if (!frames.length) return 'Nothing was recorded: the tab sent no pictures (it may have closed, or never drawn).';
  const ended = rec.ended ?? Date.now();
  const delays = frames.map((f, i) => clamp((frames[i + 1]?.at ?? ended) - f.at, 50, 5_000));
  let file: Buffer;
  if (rec.mode === 'gif') file = encodeGif(frames.map((f, i) => ({ pixels: decodePng(Buffer.from(f.data, 'base64')), delayMs: delays[i] })));
  else {
    const dir = await mkdtemp(join(tmpdir(), 'eaa-rec-'));
    try {
      const names = frames.map((_, i) => `f${String(i + 1).padStart(5, '0')}.jpg`);
      await Promise.all(frames.map((f, i) => writeFile(join(dir, names[i]), Buffer.from(f.data, 'base64'))));
      // Each frame for as long as it was on screen (the concat list's durations); the last named twice, as ffmpeg wants.
      const list = names.map((n, i) => `file '${n}'\nduration ${(delays[i] / 1000).toFixed(3)}`).join('\n') + `\nfile '${names.at(-1)}'\n`;
      await writeFile(join(dir, 'list.txt'), list);
      const out = join(dir, 'out.mp4');
      const base = ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p', '-vsync', 'vfr'];
      // H.264 where this ffmpeg has it; its own MP4 encoder otherwise.
      await ffmpeg([...base, '-c:v', 'libx264', '-movflags', '+faststart', out]).catch(() => ffmpeg([...base, '-movflags', '+faststart', out]));
      file = await readFile(out);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const rel = await saveToWorkspace(agentId, 'browser/recordings', `${stamp()}.${rec.mode}`, file, 20);
  const secs = Math.round((ended - rec.started) / 100) / 10;
  const capped = frames.length >= RECORD_MAX_FRAMES || ended - rec.started >= RECORD_MAX_MS - 50;
  return `Recorded ${secs} s of the tab (${frames.length} frames) as ${rec.mode === 'mp4' ? 'an MP4' : 'an animated GIF'}: saved in your workspace as ${rel}.${capped ? ' It stopped at the limit (a minute, or 300 frames).' : ''}`;
}

// A file dropped on a drop zone (an image upload area with no file input), as a person
// drags one from their desktop: dragenter, dragover and drop, carrying the file.
const dropExpr = (ref: number, file: { name: string; type: string; base64: string }) => `(() => { const e = ${inPage(`find(${ref})`)}; if (!e) return null;
  e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
  const f = ${JSON.stringify(file)}; const bin = atob(f.base64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const dt = new DataTransfer(); dt.items.add(new File([bytes], f.name, { type: f.type }));
  const at = document.elementFromPoint(x, y); const target = at && e.contains(at) ? at : e;
  let taken = false;
  for (const type of ['dragenter', 'dragover', 'drop']) { const ev = new DragEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, dataTransfer: dt }); target.dispatchEvent(ev); if (type === 'drop') taken = ev.defaultPrevented; }
  return { taken }; })()`;

// run_js: an expression, or a function body (one that returns, or awaits), in the page
// view's own world - it sees the page's document, not the page's own scripts' variables.
const JS_MAX = 10_000;
// Run as written first (an expression, or statements ending in one); code that only
// works inside a function (a return, an await) is run again as an async function's body.
async function runJs(page: Driver, code: string): Promise<unknown> {
  try {
    return await page.evaluate(code);
  } catch (e) {
    if (!/Illegal return|await is only valid|Unexpected reserved word|Unexpected identifier/i.test((e as Error).message)) throw e;
    return page.evaluate(`(async () => {\n${code}\n})()`);
  }
}
function jsResult(v: unknown): string {
  if (v === undefined) return 'It ran, and gave back nothing (undefined). To see a value, end with an expression or return one.';
  let text: string;
  try {
    text = typeof v === 'string' ? v : (JSON.stringify(v, null, 2) ?? String(v));
  } catch {
    text = String(v);
  }
  return text.length > JS_MAX ? `${text.slice(0, JS_MAX)}\n[cut off - ${text.length} characters in all]` : text;
}

// A pattern the agent gave to filter by: a regular expression, or plain text if it isn't one.
function matcher(raw: unknown): (s: string) => boolean {
  const p = given(raw) ? String(raw) : '';
  if (!p) return () => true;
  try {
    const re = new RegExp(p, 'i');
    return s => re.test(s);
  } catch {
    const low = p.toLowerCase();
    return s => s.toLowerCase().includes(low);
  }
}
const sizeOf = (n?: number) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1_048_576 ? `${Math.round(n / 102.4) / 10} KB` : `${Math.round(n / 104_857.6) / 10} MB`);
const BODY_MAX = 20_000;

// The screen sizes resize knows by name.
const SIZES: Record<string, { width: number; height: number; mobile: boolean }> = { mobile: { width: 390, height: 844, mobile: true }, desktop: { width: 1366, height: 900, mobile: false } };

// The run's tabs in a browser (signed_in_browser.tabs): its session's, then the tabs this
// agent kept open in earlier runs that no run has now. Numbered in that order.
async function tabsTool(ctx: RunCtx, a: Record<string, unknown>): Promise<string> {
  const n = whichBrowser(ctx, browserArg(a));
  const key = sessionKey(ctx.runId, n);
  const action = String(a.action ?? 'list').toLowerCase();
  if (!['list', 'open', 'switch', 'close'].includes(action)) throw new Error('action: list, open, switch or close.');
  const sh = await onlineOrOpen(ctx, n);
  const current = () => {
    const s = sessions.get(key);
    if (s && backFromClosedWindow(s)) s.windowClosed = false;
    return s && !s.page.isClosed() ? s : undefined;
  };
  // This agent's kept-open tabs from earlier runs that no run is in now.
  const parked = () => {
    const s = current();
    const mine = new Set(s ? runTabs(s).map(p => p.targetId) : []);
    return [...keptOpen.values()].filter(k => k.browser === n && k.agentId === ctx.agent.id && !mine.has(k.targetId) && !(k.page && !k.page.isClosed())).sort((x, y) => x.since - y.since);
  };
  const listing = async () => {
    const s = current();
    const tabs = s ? runTabs(s) : [];
    const lines: string[] = [];
    for (const [i, p] of tabs.entries()) {
      const info = await p.info().catch(() => ({ url: '?', title: '' }));
      const k = keptOpen.get(p.targetId);
      lines.push(`${i + 1}. ${info.title || '(no title)'} - ${info.url}${p === s!.cdp ? '   <- you are here' : ''}${k ? `   (kept open until ${new Date(k.until).toLocaleString()}: ${k.reason})` : ''}`);
    }
    for (const [i, k] of parked().entries()) {
      const info = await sh.cdp
        .send<{ targetInfo: { url: string; title: string } }>('Target.getTargetInfo', { targetId: k.targetId }, undefined, 3_000)
        .then(r => r.targetInfo)
        .catch(() => ({ url: '?', title: '' }));
      lines.push(`${tabs.length + i + 1}. ${info.title || '(no title)'} - ${info.url}   (kept open from an earlier run until ${new Date(k.until).toLocaleString()}: ${k.reason})`);
    }
    return lines.length ? `Your tabs in ${label(n)}:\n${lines.join('\n')}` : `You have no tabs open in ${label(n)}: open a page (signed_in_browser.open, or tabs open).`;
  };
  if (action === 'list') return listing();

  if (action === 'open') {
    const url = checkUrl(String(a.url ?? '')).toString();
    let s = current();
    let page: CdpPage;
    if (!s) {
      // The run's first tab: the one any browser step opens.
      s = await session(ctx, n);
      page = s.page;
    } else {
      await stopIfWindowClosed(s);
      sh.opening++; // until it's the run's (s.others): a sweep meanwhile would close it
      try {
        page = await CdpPage.open(sh.cdp, BOUNDS, 'about:blank', { eaaGroup: { key: ctx.runId, title: ctx.agent.name } });
        try {
          await page.guard(allowUrl());
        } catch (e) {
          await page.close();
          throw e;
        }
        s.others = [...(s.others ?? []), page];
        switchTo(s, page);
      } finally {
        sh.opening--;
      }
    }
    await page.goto(url);
    await settle(page, 5_000, 1_500);
    return `Opened in tab ${runTabs(s).indexOf(page) + 1}; you're on it now.\n\n${await snapshot(page)}`;
  }

  const no = Number(a.tab);
  const s = current();
  const tabs = s ? runTabs(s) : [];
  const old = parked();
  if (!Number.isInteger(no) || no < 1 || no > tabs.length + old.length) throw new Error(`tab: a number from the list.\n${await listing()}`);
  const inRun = tabs[no - 1] as CdpPage | undefined;
  const k = inRun ? keptOpen.get(inRun.targetId) : old[no - 1 - tabs.length];

  if (action === 'switch') {
    if (inRun) {
      switchTo(s!, inRun);
      return `You're on tab ${no} now.\n\n${await snapshot(inRun)}`;
    }
    // A tab kept from an earlier run: the debugger goes back on it, and it's this run's too.
    const page = await CdpPage.attach(sh.cdp, k!.targetId);
    await page.guard(allowUrl());
    // Off the debugger it wasn't guarded: the page may have gone anywhere since (a
    // redirect to this computer or its network). Its next navigations are guarded again.
    const at = await page.url().catch(() => '');
    let onLan = false;
    try {
      if (/^https?:/i.test(at)) checkUrl(at);
    } catch {
      onLan = true;
    }
    if (onLan) {
      await page.detach();
      throw new Error(`That tab is on an address that isn't on the public web now (${at.slice(0, 200)}), so it's left alone. Close it (tabs close), or open what you need in a new one.`);
    }
    k!.page = page;
    let run = current();
    if (!run) {
      run = { runId: ctx.runId, browser: n, page, cdp: page, agent: { id: ctx.agent.id, name: ctx.agent.name } };
      sessions.set(key, run);
      sh.runs.add(ctx.runId);
      lastUsed.set(ctx.agent.id, n);
    } else run.others = [...(run.others ?? []), page];
    switchTo(run, page);
    return `You're on tab ${runTabs(run).indexOf(page) + 1} now (kept open: ${k!.reason}).\n\n${await snapshot(page)}`;
  }

  // close: a kept-open one is let go of too.
  if (k && keptOpen.delete(k.targetId)) saveKept();
  if (!inRun) {
    await sh.cdp.send('Target.closeTarget', { targetId: k!.targetId }).catch(() => {});
    return `Closed it.\n\n${await listing()}`;
  }
  const run = s!;
  const wasHere = inRun === run.cdp;
  release(inRun.targetId);
  await inRun.close();
  run.openers = (run.openers ?? []).filter(p => p !== inRun);
  run.others = (run.others ?? []).filter(p => p !== inRun);
  if (!wasHere) return `Closed tab ${no}.\n\n${await listing()}`;
  if (backFromClosedWindow(run)) {
    run.windowClosed = false;
    return `Closed tab ${no}. You're on tab ${runTabs(run).indexOf(run.cdp!) + 1} now.\n\n${await snapshot(run.page)}`;
  }
  return 'Closed it: that was your last tab. Your next browser step opens a new one.';
}

// --- The tools ------------------------------------------------------------------------

const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required });
const BROWSER_ARG = {
  type: 'string',
  description: 'Which browser: its number ("2") or name. Leave it out for the one you last worked in. signed_in_browser.passwords says which browser an account is in. An agents\' profile that is offline opens by itself.',
};

function toolsFor(prefix: string, actTier: 'T0' | 'T1', where: string): ToolDef[] {
  const withBrowser = (props: Record<string, unknown>) => ({ ...props, browser: BROWSER_ARG });
  const current = (ctx: RunCtx, a: Record<string, unknown>) => session(ctx, whichBrowser(ctx, browserArg(a)));
  const open = async (ctx: RunCtx, a: Record<string, unknown>) => {
    const s = await current(ctx, a);
    await stopIfWindowClosed(s);
    return s;
  };
  // By number (scrolled to, frames and all), or at a point from a screenshot.
  const click = async (a: Record<string, unknown>, ctx: RunCtx) => {
    const at = pointArg(a);
    const opts = mouseOpts(a);
    const s = await open(ctx, a);
    return clickAndLook(s.page, at, s, allowUrl(), opts);
  };
  // After a step that may change the page: settled, and seen again.
  const after = async (s: Session, ms = 1_500) => {
    await wait(150);
    await settle(s.page, ms);
    if (backFromClosedWindow(s)) return `That window closed, so you're back on the page that opened it.\n\n${await snapshot(s.page)}`;
    return snapshot(s.page);
  };
  const key = (ctx: RunCtx, a: Record<string, unknown>) => sessionKey(ctx.runId, whichBrowser(ctx, browserArg(a)));
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
      description: `Click a numbered button or link on the current page in ${where} - or a point (x, y from a screenshot) for what has no number: a canvas, a map, a chart. Right or middle button, double or triple click, and modifiers (ctrl+click) too. Not the click that pays, posts publicly as the business, or starts a new business tool: those are click_to_pay, click_to_post and click_to_start_tool. On a Copy button, the result starts with what it copied.`,
      schema: obj(
        withBrowser({
          ref: { type: 'number', description: 'The number from the last page you saw' },
          x: { type: 'number', description: 'Instead of ref: a point on the screen, in pixels from the top left, as a screenshot shows it' },
          y: { type: 'number' },
          button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Left unless you say' },
          count: { type: 'number', enum: [1, 2, 3], description: '2 for a double click, 3 for a triple click (selects a line)' },
          modifiers: { type: 'string', description: 'Keys held during the click, joined with +: "ctrl", "shift", "ctrl+shift", "cmd"' },
        }),
        [],
      ),
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
      description: `Scroll the current page in ${where} and see what's there: down (the default), up, left or right, or straight to a numbered element (to_ref). x and y scroll a panel that scrolls by itself (a list, a chat) instead of the page.`,
      schema: obj(
        withBrowser({
          direction: { type: 'string', enum: ['down', 'up', 'left', 'right'] },
          amount: { type: 'number', description: 'How far, in pixels (1600 down or up, 600 left or right, unless you say)' },
          to_ref: { type: 'number', description: 'Instead: scroll until this numbered element is in the middle of the screen' },
          x: { type: 'number', description: 'Where to turn the wheel (a point from a screenshot); the middle of the page unless you say' },
          y: { type: 'number' },
        }),
        [],
      ),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        if (given(a.to_ref)) await s.page.box(Number(a.to_ref));
        else {
          const dir = String(a.direction ?? 'down').toLowerCase();
          if (!['down', 'up', 'left', 'right'].includes(dir)) throw new Error('direction: down, up, left or right.');
          const sideways = dir === 'left' || dir === 'right';
          const amount = given(a.amount) ? Math.abs(Number(a.amount)) : sideways ? 600 : 1600;
          if (!Number.isFinite(amount)) throw new Error('amount: how far, in pixels, e.g. 800.');
          const delta = dir === 'up' || dir === 'left' ? -amount : amount;
          const at = given(a.x) && given(a.y) ? { x: Number(a.x), y: Number(a.y) } : undefined;
          await s.page.wheel(sideways ? 0 : delta, sideways ? delta : 0, at);
        }
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
      description: `See the current page in ${where} again, as it is now, without reloading it - a page given back to you after an approval, or one that changed by itself. filter "interactive" lists only what you can click or type in; ref shows only that element and what's in it (a form, a dialog); max_chars sets how much of the text.`,
      schema: obj(
        withBrowser({
          filter: { type: 'string', enum: ['all', 'interactive'], description: '"interactive": the numbered controls only, no page text' },
          ref: { type: 'number', description: 'Only this numbered element and what is inside it' },
          max_chars: { type: 'number', description: `How much of the page's text (${TEXT_CHARS} unless you say, up to 50000)` },
        }),
        [],
      ),
      impl: async (a, ctx) =>
        snapshot((await open(ctx, a)).page, {
          interactive: a.filter === 'interactive',
          ref: given(a.ref) ? Number(a.ref) : undefined,
          chars: given(a.max_chars) ? clamp(Math.round(Number(a.max_chars)) || TEXT_CHARS, 200, 50_000) : undefined,
        }),
    },
    {
      id: `${prefix}.press`,
      tier: actTier,
      description: `Press a key or a key combination in the current page in ${where}, on whatever has the focus: "Escape" closes most pop-ups and menus, "Tab" moves to the next field, the arrows move in a list, "Enter" submits; "ctrl+a", "shift+Tab", "cmd+Enter", "ctrl+shift+k". repeat presses it again (ArrowDown 5 times).`,
      schema: obj(
        withBrowser({
          key: { type: 'string', description: `A key (${Object.keys(KEYS).join(', ')}, Delete, Home, End, F1-F12, a letter, a digit) or modifiers and a key joined with + ("ctrl+a")` },
          repeat: { type: 'number', description: 'How many times (1 to 50; 1 unless you say)' },
        }),
        ['key'],
      ),
      impl: async (a, ctx) => {
        const repeat = given(a.repeat) ? Number(a.repeat) : 1;
        if (!Number.isInteger(repeat) || repeat < 1 || repeat > 50) throw new Error('repeat: a whole number from 1 to 50.');
        const s = await open(ctx, a);
        await s.page.pressCombo(String(a.key ?? ''), repeat);
        return after(s, 2_000);
      },
    },
    {
      id: `${prefix}.hover`,
      tier: actTier,
      description: `Move the mouse over a numbered element or a point (x, y from a screenshot) in ${where}, without clicking: a menu that opens on hover, a tooltip, a button that only shows then.`,
      schema: obj(withBrowser({ ref: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } }), []),
      impl: async (a, ctx) => {
        const at = pointArg(a);
        const s = await open(ctx, a);
        const p = await pointOn(s.page, at);
        await s.page.hoverAt(p.x, p.y);
        await wait(300);
        return after(s);
      },
    },
    {
      id: `${prefix}.drag`,
      tier: actTier,
      description: `Drag from one numbered element or point to another in ${where}, as a mouse does (pressed, moved there in steps, let go): a slider, a list you put in order, a card onto a column, a map.`,
      schema: obj(
        withBrowser({
          from_ref: { type: 'number', description: 'What to drag: a number from the page...' },
          from_x: { type: 'number', description: '...or a point from a screenshot' },
          from_y: { type: 'number' },
          to_ref: { type: 'number', description: 'Where to drop it: a number from the page...' },
          to_x: { type: 'number', description: '...or a point from a screenshot' },
          to_y: { type: 'number' },
        }),
        [],
      ),
      impl: async (a, ctx) => {
        const fromAt = pointArg(a, 'from_ref', 'from_x', 'from_y');
        const toAt = pointArg(a, 'to_ref', 'to_x', 'to_y');
        const s = await open(ctx, a);
        const from = await pointOn(s.page, fromAt);
        // Where it goes, measured without scrolling: scrolling it into view would move what's being dragged.
        let to: { x: number; y: number };
        if (typeof toAt !== 'number') to = toAt;
        else if (toAt >= FRAME_BASE) to = await s.page.pointOf(toAt);
        else {
          const r = await s.page.evaluate<{ x: number; y: number; h: number; w: number } | null>(
            `(() => { const e = ${inPage(`find(${toAt})`)}; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: innerWidth, h: innerHeight }; })()`,
          );
          if (!r) throw new Error(`There's no [${toAt}] on the page now - look at it again and use a number from what you see.`);
          if (r.y < 0 || r.y > r.h || r.x < 0 || r.x > r.w)
            throw new Error(`[${toAt}] is off the screen once [${String(a.from_ref ?? 'the start')}] is on it. Take a screenshot and drag by points (from_x/from_y, to_x/to_y), or scroll so both show.`);
          to = r;
        }
        await s.page.drag(from, to);
        await wait(300);
        return after(s);
      },
    },
    {
      id: `${prefix}.forward`,
      tier: 'T0',
      description: `Go forward again in ${where}, after back.`,
      schema: obj(withBrowser({}), []),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        if (!(await s.page.forward())) return `There's no page to go forward to.\n\n${await snapshot(s.page)}`;
        await settle(s.page, 3_000, 500);
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.reload`,
      tier: 'T0',
      description: `Reload the current page in ${where} (what's typed in its fields is lost).`,
      schema: obj(withBrowser({}), []),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        await s.page.reload();
        await settle(s.page, 5_000, 1_000);
        return snapshot(s.page);
      },
    },
    {
      id: `${prefix}.screenshot`,
      tier: 'T0',
      description: `A picture of the current page in ${where}, as it shows now: what's on screen, one numbered element (ref), or the whole page (full_page). For what the text doesn't tell you - a layout, a chart, a canvas, whether something looks right - and for points to click by x, y. Its coordinates are the ones click, hover and drag take.`,
      schema: obj(withBrowser({ ref: { type: 'number', description: 'Only this numbered element' }, full_page: { type: 'boolean', description: 'The whole page, not just the screen' } }), []),
      media: async (a, ctx) => shoot((await open(ctx, a)).page, ctx.agent.id, a, false),
      impl: async (a, ctx) => (await shoot((await open(ctx, a)).page, ctx.agent.id, a, false)).text,
    },
    {
      id: `${prefix}.zoom`,
      tier: 'T0',
      description: `A closer picture of part of the screen in ${where}: region is two corners [x0, y0, x1, y1] from a screenshot, shown bigger - small text, an icon, a crowded menu. Says how to turn a point in it back into click coordinates.`,
      schema: obj(withBrowser({ region: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4, description: '[x0, y0, x1, y1] in screen pixels' } }), ['region']),
      media: async (a, ctx) => shoot((await open(ctx, a)).page, ctx.agent.id, a, true),
      impl: async (a, ctx) => (await shoot((await open(ctx, a)).page, ctx.agent.id, a, true)).text,
    },
    {
      id: `${prefix}.wait`,
      tier: 'T0',
      description: `Wait in ${where}: a number of seconds (seconds, up to 30), or until some text shows on the page (for_text, up to 30 s - 10 unless you give seconds). Then see the page.`,
      schema: obj(withBrowser({ seconds: { type: 'number' }, for_text: { type: 'string', description: 'Wait until this shows on the page (any case)' } }), []),
      impl: async (a, ctx) => {
        const secs = given(a.seconds) ? Number(a.seconds) : null;
        if (secs != null && (!Number.isFinite(secs) || secs < 0 || secs > 30)) throw new Error('seconds: from 0 to 30.');
        const text = given(a.for_text) ? String(a.for_text).trim() : '';
        if (!text && secs == null) throw new Error('Give seconds (how long to wait) or for_text (what to wait for).');
        const s = await open(ctx, a);
        if (!text) {
          await wait(secs! * 1000);
          return snapshot(s.page);
        }
        const limit = (secs ?? 10) * 1000;
        const started = Date.now();
        const has = `(document.body ? document.body.innerText : '').toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`;
        for (;;) {
          if (await s.page.evaluate<boolean>(has).catch(() => false)) return `"${text}" is on the page now (after ${Math.round((Date.now() - started) / 100) / 10} s).\n\n${await snapshot(s.page)}`;
          if (Date.now() - started >= limit) break;
          await wait(Math.min(250, Math.max(0, limit - (Date.now() - started))));
        }
        return `Waited ${round2(limit / 1000)} s: "${text}" hasn't shown on the page. It may take longer, be in a frame, or need a step first (a click, a scroll).\n\n${await snapshot(s.page)}`;
      },
    },
    {
      id: `${prefix}.find`,
      tier: 'T0',
      description: `Find what you can click or type in on the current page in ${where} by what it says: its label, text, placeholder, name or kind (any case). Up to 20, with their numbers - for a long page, or one control among hundreds.`,
      schema: obj(withBrowser({ query: { type: 'string', description: 'Words it shows or is labelled with, e.g. "subscribe", "email", "next page"' } }), ['query']),
      impl: async (a, ctx) => {
        const q = String(a.query ?? '').trim();
        const s = await open(ctx, a);
        await s.page.ready();
        type Hits = { hits: string[]; total: number };
        const main = await s.page.evaluate<Hits>(inPage(`search(${JSON.stringify(q)}, 20)`));
        const hits = [...main.hits];
        let total = main.total;
        // And in the page's frames (a form hosted elsewhere), until there are 20.
        for (const f of hits.length < 20 ? (await s.page.frames().catch(() => [])).filter(f => !UNUSED_FRAME.test(f.url)).slice(0, MAX_FRAMES) : []) {
          const r = await Promise.race([s.page.evaluateInFrame<Hits>(f.no, inPage(`search(${JSON.stringify(q)}, 20)`)).catch(() => null), wait(FRAME_WAIT_MS).then(() => null)]);
          if (!r) continue;
          hits.push(...r.hits.slice(0, 20 - hits.length));
          total += r.total;
        }
        if (!hits.length) return `Nothing you can click or type in matches "${q}". It may be plain text (signed_in_browser.page_text), further down (scroll), or not there yet (wait for_text).`;
        return `${total} match "${q}"${total > hits.length ? ` (the first ${hits.length})` : ''}:\n${hits.join('\n')}`;
      },
    },
    {
      id: `${prefix}.page_text`,
      tier: 'T0',
      description: `The current page's readable text in ${where}: the article or main part when there is one, else the whole page. For reading a long page; look is for using it.`,
      schema: obj(withBrowser({ max_chars: { type: 'number', description: 'How much (20000 unless you say, up to 100000)' } }), []),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        await s.page.ready();
        const max = given(a.max_chars) ? clamp(Math.round(Number(a.max_chars)) || 20_000, 500, 100_000) : 20_000;
        const url = await s.page.url();
        const html = await s.page.evaluate<string>('document.documentElement ? document.documentElement.outerHTML.slice(0, 5000000) : ""').catch(() => '');
        let { title, text } = html ? readable(html, url) : { title: '', text: '' };
        // Readability found no article (an app, a form): what's on the page, as shown.
        if (text.trim().length < 200)
          text = await s.page.evaluate<string>("(() => { const e = document.querySelector('main, article, [role=main]') || document.body; return e ? e.innerText.replace(/\\n{3,}/g, '\\n\\n').trim() : ''; })()");
        const cut = text.length > max ? `${text.slice(0, max)}\n[cut off - ${text.length} characters in all; max_chars for more]` : text;
        return `Title: ${title || (await s.page.title().catch(() => '')) || '(none)'}\nURL: ${url}\n\n${cut || '(no text)'}`;
      },
    },
    {
      id: `${prefix}.tabs`,
      tier: 'T0',
      description: `Your tabs in ${where}: list them; open a web address in a new one (and go to it); switch to one; close one - by its number in the list. Tabs you kept open in earlier runs (keep_open) are listed too.`,
      schema: obj(
        withBrowser({
          action: { type: 'string', enum: ['list', 'open', 'switch', 'close'], description: 'list unless you say' },
          url: { type: 'string', description: 'For open: the full address' },
          tab: { type: 'number', description: 'For switch and close: its number in the list' },
        }),
        [],
      ),
      impl: async (a, ctx) => tabsTool(ctx, a),
    },
    {
      id: `${prefix}.keep_open`,
      tier: actTier,
      description: `Keep the tab you're on in ${where} open after this run ends (your tabs close when it does) - something still running there, a page you'll come back to. It stays for 24 hours or until you close it (tabs close); your next runs find it in tabs list.`,
      schema: obj(withBrowser({ reason: { type: 'string', description: 'Why it stays open, for the person who sees it in their browser' } }), ['reason']),
      impl: async (a, ctx) => {
        const reason = String(a.reason ?? '').trim();
        if (!reason) throw new Error('Say why it stays open (reason).');
        const s = await open(ctx, a);
        const page = s.cdp;
        if (!page || page.isClosed()) throw new Error('There is no tab open to keep.');
        const now = Date.now();
        const k: KeptOpen = { targetId: page.targetId, browser: s.browser, agentId: ctx.agent.id, agentName: ctx.agent.name, runId: ctx.runId, reason: reason.slice(0, 300), since: now, until: now + KEEP_OPEN_MS, page };
        keptOpen.set(page.targetId, k);
        saveKept();
        return `This tab (${(await page.info().catch(() => ({ url: '' }))).url}) stays open after your run ends, until ${new Date(k.until).toLocaleString()} or until you close it (signed_in_browser.tabs close). Your next runs find it in signed_in_browser.tabs list.`;
      },
    },
    {
      id: `${prefix}.resize`,
      tier: actTier,
      description: `Show the current tab in ${where} at another screen size - preset "mobile" (390x844, a phone) or "desktop" (1366x900), or width and height - to see a site as on a phone. Only this tab, not the window. reset goes back.`,
      schema: obj(
        withBrowser({
          preset: { type: 'string', enum: ['mobile', 'desktop'] },
          width: { type: 'number' },
          height: { type: 'number' },
          reset: { type: 'boolean', description: 'Back to the window\'s own size' },
        }),
        [],
      ),
      impl: async (a, ctx) => {
        let size: { width: number; height: number; mobile: boolean } | null = null;
        if (!a.reset) {
          if (given(a.preset)) {
            size = SIZES[String(a.preset).toLowerCase()];
            if (!size) throw new Error('preset: mobile or desktop.');
          } else {
            const width = Math.round(Number(a.width)), height = Math.round(Number(a.height));
            if (!(width >= 200 && width <= 4000 && height >= 200 && height <= 4000)) throw new Error('Give preset (mobile or desktop), width and height (200 to 4000 pixels), or reset true.');
            size = { width, height, mobile: width < 600 };
          }
        }
        const s = await open(ctx, a);
        await s.page.emulateSize(size);
        await wait(300);
        await settle(s.page, 2_000);
        return `${size ? `The tab shows as ${size.width}x${size.height}${size.mobile ? ' (as a phone, with touch)' : ''} now - only this tab; reset true goes back.` : "The tab is back to the window's own size."}\n\n${await snapshot(s.page)}`;
      },
    },
    {
      id: `${prefix}.run_js`,
      tier: actTier,
      description: `Run JavaScript on the current page in ${where} and get back what it returns (as JSON, up to ${JS_MAX} characters): an expression ("document.title", "[...document.querySelectorAll('h2')].map(h => h.innerText)") or a function body that returns (await works there). It sees and can change the page's document, not the page's own script variables. For what the other tools can't do - never to submit, pay or post.`,
      schema: obj(withBrowser({ code: { type: 'string', description: 'The expression, or a function body with return' } }), ['code']),
      impl: async (a, ctx) => {
        const code = String(a.code ?? '').trim();
        const s = await open(ctx, a);
        return jsResult(await runJs(s.page, code));
      },
    },
    {
      id: `${prefix}.console`,
      tier: 'T0',
      description: `The current tab's console in ${where} (its messages and uncaught errors), for working out why a page misbehaves: start watching, read what it said since (the last ones, optionally only those matching pattern), stop. Off unless you start it.`,
      schema: obj(
        withBrowser({
          action: { type: 'string', enum: ['start', 'read', 'stop'] },
          pattern: { type: 'string', description: 'For read: only messages matching this (text, or a regular expression)' },
          last: { type: 'number', description: 'For read: how many, newest last (50 unless you say, up to 500)' },
        }),
        ['action'],
      ),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        const page = s.page;
        const action = String(a.action ?? '').toLowerCase();
        if (action === 'start') {
          await page.watchConsole(true);
          return "Watching this tab's console from now: do what you need to, then console read. (console stop when you're done.)";
        }
        if (action === 'stop') {
          await page.watchConsole(false);
          return "Stopped watching this tab's console.";
        }
        if (action !== 'read') throw new Error('action: start, read or stop.');
        if (!page.watchingConsole) return "This tab's console isn't being watched: console start first, then do what you want to see, then read.";
        const match = matcher(a.pattern);
        const last = given(a.last) ? clamp(Math.round(Number(a.last)) || 50, 1, 500) : 50;
        const lines = page.consoleMessages().map(m => `[${m.level}] ${m.text}${m.where ? `  (${m.where})` : ''}`).filter(match);
        if (!lines.length) return given(a.pattern) ? `Nothing in the console matches "${String(a.pattern)}".` : 'Nothing in the console since you started watching.';
        return `${lines.length > last ? `The last ${last} of ${lines.length}:\n` : ''}${lines.slice(-last).join('\n')}`;
      },
    },
    {
      id: `${prefix}.network`,
      tier: 'T0',
      description: `The current tab's network requests in ${where}: start watching, read the requests since (method, address, status, type, size; url_contains narrows them), body for what one got back (by its id from read, up to ${BODY_MAX} characters), stop. Off unless you start it.`,
      schema: obj(
        withBrowser({
          action: { type: 'string', enum: ['start', 'read', 'body', 'stop'] },
          url_contains: { type: 'string', description: 'For read: only requests whose address has this' },
          request_id: { type: 'string', description: 'For body: the id read showed' },
          last: { type: 'number', description: 'For read: how many, newest last (50 unless you say, up to 200)' },
        }),
        ['action'],
      ),
      impl: async (a, ctx) => {
        const s = await open(ctx, a);
        const page = s.page;
        const action = String(a.action ?? '').toLowerCase();
        if (action === 'start') {
          await page.watchNetwork(true);
          return "Watching this tab's network from now: do what you need to (reload to see a page load from the start), then network read.";
        }
        if (action === 'stop') {
          await page.watchNetwork(false);
          return "Stopped watching this tab's network.";
        }
        if (action !== 'read' && action !== 'body') throw new Error('action: start, read, body or stop.');
        if (!page.watchingNetwork) return "This tab's network isn't being watched: network start first, then do what you want to see, then read.";
        if (action === 'body') {
          const id = String(a.request_id ?? '').trim();
          if (!id) throw new Error('request_id: the id network read showed.');
          const r = await page.responseBody(id).catch(e => {
            throw new Error(`No body for request ${id}: ${(e as Error).message}. It may have had none, or be gone (a page that moved on).`);
          });
          if (r.base64) return `Request ${id} got back ${sizeOf(Math.floor((r.body.length * 3) / 4))} of binary data (a picture or a file), not text.`;
          return r.body.length > BODY_MAX ? `${r.body.slice(0, BODY_MAX)}\n[cut off - ${r.body.length} characters in all]` : r.body || '(empty)';
        }
        const want = given(a.url_contains) ? String(a.url_contains).toLowerCase() : '';
        const last = given(a.last) ? clamp(Math.round(Number(a.last)) || 50, 1, 200) : 50;
        const list = page.requests().filter(r => !want || r.url.toLowerCase().includes(want));
        if (!list.length) return want ? `No requests to an address with "${want}" since you started watching.` : 'No requests since you started watching.';
        const lines = list.slice(-last).map(r => `${r.id}  ${r.method} ${r.failed ? `FAILED ${r.failed}` : (r.status ?? '...')} ${r.type}${r.size != null ? ` ${sizeOf(r.size)}` : ''}  ${r.url.length > 300 ? `${r.url.slice(0, 300)}...` : r.url}`);
        return `${list.length > last ? `The last ${last} of ${list.length}:\n` : ''}${lines.join('\n')}`;
      },
    },
    {
      id: `${prefix}.record`,
      tier: 'T0',
      description: `Record the current tab in ${where} as a video: start, do the steps, stop - it's saved in your workspace (an MP4, or an animated GIF), and the path given back. Up to a minute. For showing the person what happens on a page.`,
      schema: obj(withBrowser({ action: { type: 'string', enum: ['start', 'stop'] } }), ['action']),
      impl: async (a, ctx) => {
        const k = key(ctx, a);
        if (String(a.action) === 'stop') return stopRecording(k, ctx.agent.id);
        if (String(a.action) !== 'start') throw new Error('action: start or stop.');
        const s = await open(ctx, a);
        const rec = await startRecording(k, s.page);
        return `Recording this tab (${rec.mode === 'mp4' ? 'an MP4' : 'an animated GIF'}), for a minute at most: do the steps, then signed_in_browser.record stop.`;
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
// Videos for posts are what pushed this up: a 60-second launch film is 10-20 MB, and
// Bluesky, Mastodon and X all take that. The file goes into the page in one message,
// well under the link's frame size.
const UPLOAD_MAX_MB = 40;
// The agency's own studios render on this computer, outside any workspace: a film
// finished in Launch Studio or Video Studio is attached straight from there
// ("~/LaunchStudio/renders/<project>/<file>.mp4") - no copying, no hosting it first.
const STUDIOS = ['LaunchStudio', 'VideoStudio'];
function studioFile(path: string): string | null {
  const m = /^~[\/](LaunchStudio|VideoStudio)[\/](.+)$/.exec(path.trim());
  if (!m || !STUDIOS.includes(m[1])) return null;
  const root = join(homedir(), m[1]);
  const full = normalize(join(root, m[2]));
  if (relative(root, full).startsWith('..') || full === root) throw new Error('That path is outside the studio folder.');
  return full;
}
async function workspaceFile(agentId: string, path: unknown) {
  const full = studioFile(String(path ?? '')) ?? inWorkspace(agentId, path);
  const st = await stat(full).catch(() => null);
  if (!st?.isFile()) throw new Error(`No file at ${String(path)}${studioFile(String(path ?? "")) ? "" : " in your workspace"}.`);
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
      description: `Attach a file to a numbered upload field in ${where} - or to the button or label that opens one ("Upload logo"): a file from your workspace or a finished film from Launch Studio / Video Studio on this computer (path), or one on the public web (url, e.g. the logo on your website). Up to ${UPLOAD_MAX_MB} MB - a post's video goes in this way, no hosting needed.`,
      schema: obj(
        {
          ref: { type: 'number', description: 'The upload field, or the button that opens it, from the last page you saw' },
          path: { type: 'string', description: 'A file in your workspace, e.g. "kit/logo.svg" - or a finished film from the studios on this computer, e.g. "~/LaunchStudio/renders/croonzo-read-it-16x9/croonzo-read-it-16x9.mp4"' },
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
    {
      id: 'signed_in_browser.drop_file',
      tier: 'T1',
      description: `Drop a file onto a numbered drop zone in ${where}, as if dragged from the desktop ("Drag an image here") - for one with no upload field (upload_file is for those): a file from your workspace (path), or one on the public web (url). Up to ${UPLOAD_MAX_MB} MB.`,
      schema: obj(
        {
          ref: { type: 'number', description: 'The drop zone, from the last page you saw' },
          path: { type: 'string', description: 'A file in your workspace, e.g. "kit/logo.png" - or a file from the studios on this computer, e.g. "~/LaunchStudio/renders/<project>/<file>.mp4"' },
          url: { type: 'string', description: 'Or a file on the public web, https://...' },
          browser: BROWSER_ARG,
        },
        ['ref'],
      ),
      impl: async (a, ctx) => {
        const s = await session(ctx, whichBrowser(ctx, browserArg(a)));
        const file = a.path ? await workspaceFile(ctx.agent.id, a.path) : a.url ? await download(String(a.url), ctx.runId) : null;
        if (!file) throw new Error('Give path (a file in your workspace) or url (a file on the public web).');
        await stopIfWindowClosed(s);
        const ref = Number(a.ref);
        const data = { name: basename(file), type: MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', base64: (await readFile(file)).toString('base64') };
        const r = await evalAt<{ taken: boolean } | null>(s.page, ref, dropExpr(ref, data));
        if (!r) throw new Error(`There's no [${ref}] on the page now - look at it again and use a number from what you see.`);
        await wait(300);
        await settle(s.page, 3_000);
        const note = r.taken ? `Dropped ${basename(file)} on [${ref}].` : `Dropped ${basename(file)} on [${ref}], but nothing there took the drop - it may not be the drop zone (try the element around it), or the page wants upload_file.`;
        return `${note}\n\n${await snapshot(s.page)}`;
      },
    },
    decisive('click_to_pay', 'spends money (a purchase, a paid plan, a subscription)'),
    decisive('click_to_post', 'posts something publicly as the business (a post, a public reply, a review)'),
    decisive('click_to_start_tool', 'starts using a new business tool - a CRM, a help desk, an email platform - rather than an account to do your job'),
    {
      id: 'signed_in_browser.accounts',
      tier: 'T0',
      description:
        "The accounts you owe - the app's own record of every website account your job needs, and whether each really exists. need: write down every account you're going to need BEFORE signing up for any (all twelve, not one), each with its site and what it's for; asking again for one already there changes nothing. With nothing given it lists them. An account is only real once it says working: that's the app having seen it signed in (check_account), never your own word. Each stays owed, and you're woken for it, until it works or a person cancels it.",
      schema: obj(
        {
          need: {
            type: 'array',
            description: 'Accounts to write down as needed, all of them at once',
            items: { type: 'object', properties: { site: { type: 'string', description: 'The site, e.g. x.com' }, purpose: { type: 'string', description: 'What this one is for, so two on one site are told apart: "Northside Bikes brand account", "outreach account 3"' } }, required: ['site', 'purpose'] },
          },
          for_agent: { type: 'string', description: "Agency Engineer only: the agent whose accounts these are (a new agent's, made during its setup)" },
          cancel: { type: 'array', items: { type: 'string' }, description: 'Agency Engineer only: account ids a person said they no longer want' },
          person_said: { type: 'string', description: "With cancel: the person's own words" },
        },
        [],
      ),
      impl: async (a, ctx) => {
        const engineer = ctx.agent.id === FLEET_ENGINEER;
        const now = ctx.now();
        if (a.for_agent != null && !engineer && String(a.for_agent) !== ctx.agent.id) throw new Error('for_agent is the Agency Engineer\'s. Leave it out: the accounts are yours.');
        const owner = a.for_agent != null && String(a.for_agent).trim() ? String(a.for_agent).trim() : ctx.agent.id;
        if (owner !== ctx.agent.id && !one('SELECT 1 FROM agent_state WHERE agent_id = ?', owner)) throw new Error(`There's no agent "${owner}".`);
        const said: string[] = [];
        const cancel = Array.isArray(a.cancel) ? a.cancel.map(String) : [];
        if (cancel.length) {
          if (!engineer) throw new Error("Only a person cancels an account (they turn its request down, or tell the Agency Engineer). An account you owe stays owed: keep at it.");
          if (!String(a.person_said ?? '').trim()) throw new Error("Give person_said: the person's own words saying they don't want it. Without them it stays owed.");
          for (const id of cancel) said.push((await cancelAccount(id, `A person said: ${String(a.person_said).trim()}`, now)) ? `${id} is cancelled.` : `${id} wasn't cancelled (no such account, or it already works or is cancelled).`);
        }
        const need = (Array.isArray(a.need) ? a.need : []).filter((x): x is { site: string; purpose: string } => !!x && typeof x === 'object' && typeof (x as { site?: unknown }).site === 'string');
        if (need.length > 60) throw new Error('Up to 60 at a time.');
        if (need.length) {
          const rows = needAccounts(owner, need.map(x => ({ site: String(x.site), purpose: String(x.purpose ?? '') })), now);
          said.push(`Written down: ${rows.length} account${rows.length === 1 ? '' : 's'}${owner !== ctx.agent.id ? ` for ${owner}` : ''}.`);
        }
        const mine = owner !== ctx.agent.id ? accountsOf(owner).filter(r => r.state !== 'working' && r.state !== 'cancelled') : accountsOwed(ctx.agent.id);
        const working = accountsOf(owner).filter(r => r.state === 'working');
        const others = owner !== ctx.agent.id || mine.some(r => r.agent_id !== ctx.agent.id);
        return [
          ...said,
          mine.length ? `Owed (${mine.length}):\n${mine.map(r => accountLine(r, others)).join('\n')}` : 'Nothing owed.',
          working.length ? `Working (${working.length}):\n${working.map(r => `- ${r.id} ${r.site}: ${r.username} (password #${r.password_id}, browser ${r.browser ?? '?'}) - ${r.purpose}`).join('\n')}` : '',
          mine.some(r => r.state === 'needed' || r.state === 'returned')
            ? 'Do them all in one go: for each, start_sign_up, fill the form, type_password, submit, and check_account once it is signed in. At a check only a person can do: show_person with its account_id, and on to the next. When every one is working or kept for the person, wait_for_person - once.'
            : '',
        ]
          .filter(Boolean)
          .join('\n\n');
      },
    },
    {
      id: 'signed_in_browser.start_sign_up',
      tier: 'T1',
      description: `Start signing up for one of the accounts you owe (signed_in_browser.accounts): makes a strong password, kept hidden until the account is seen working - you never see it - and says which browser to sign up in (a browser holds up to ${ACCOUNTS_PER_SITE} accounts on one site). Then fill the site's form and type the password with type_password. If an earlier try already put a password into the site, the account may exist: it says so, and you sign in with that one first. new_password true: you saw the site say there is no such account (or the password is wrong) - the old one is thrown away and a new one made. You choose where: browser names one (a person's own browser too, for access only it has), new_profile true makes a fresh agents' profile; left out, the first browser with room.`,
      schema: obj(
        {
          account_id: { type: 'string', description: 'The account, from signed_in_browser.accounts' },
          username: { type: 'string', description: 'The username or email address the account will use' },
          new_password: { type: 'boolean', description: "True only after the site said the earlier try's account doesn't exist" },
          browser: { type: 'string', description: "Sign up in this browser: its number or name - a person's own one too, when the account needs something only it has (their sign-in, their access). Leave it out and the app picks the first with room." },
          new_profile: { type: 'boolean', description: "True: make a new agents' profile, with nobody's accounts in it, and sign up there." },
        },
        ['account_id', 'username'],
      ),
      impl: async (a, ctx) => {
        const row = ownAccount(ctx, a.account_id);
        const username = String(a.username ?? '').trim();
        if (!username) throw new Error('Give the username or email address the account will use.');
        if (a.new_profile === true && a.browser != null && String(a.browser).trim() !== '') throw new Error('Give browser or new_profile, not both.');
        const browsers = pairedBrowsers();
        const paired = browsers.map(b => b.n);
        let n: number;
        if (a.new_profile === true) {
          // The agent's choice: a clean agents' profile with nobody's accounts in it.
          const can = profilesAvailable();
          if (!can.ok) throw new Error(`The app can't make a new agents' profile here (${can.why}). Sign up in one of the browsers there are (${browsers.map(b => `${b.n} ${b.name}`).join(', ') || 'none yet'}), or ask the person to connect another Chrome or Edge profile.`);
          n = createProfile();
        } else if (a.browser != null && String(a.browser).trim() !== '') {
          // The agent's choice of browser, a person's own included (for an access only it has).
          const text = String(a.browser).trim();
          const low = text.toLowerCase();
          const found = /^\d+$/.test(text) ? browsers.find(b => b.n === Number(text)) : (browsers.find(b => b.name.toLowerCase() === low) ?? browsers.find(b => b.name.toLowerCase().includes(low)));
          if (!found) throw new Error(`There's no browser ${text}. The browsers are ${browsers.map(b => `${b.n} (${b.name})`).join(', ') || 'none yet'}; new_profile true makes a new agents' profile.`);
          if (accountsIn(row.site, found.n, row.id) >= ACCOUNTS_PER_SITE) throw new Error(`Browser ${found.n} already holds ${ACCOUNTS_PER_SITE} ${row.site} accounts, the most one browser takes. Pick another, or new_profile true for a new agents' profile.`);
          n = found.n;
        } else {
          // No browser yet: the agents' first profile holds it.
          if (!paired.length && profilesAvailable().ok) paired.push(createProfile());
          const picked = profileFor(row.site, paired.length ? paired : [1]);
          n = picked.profile;
          if (picked.isNew) {
            // Every browser has its fill of this site: a new agents' profile takes the next.
            const can = profilesAvailable();
            if (!can.ok)
              throw new Error(`Every browser already holds ${ACCOUNTS_PER_SITE} ${row.site} accounts, so another one there needs another browser, and the app can't make one here (${can.why}). Ask the person to connect one more Chrome or Edge profile (Settings > Connectors > Browser, Connect another profile), then start the sign-up again.`);
            n = createProfile();
          }
        }
        // A person's own browser has their accounts signed in: the agent hears so, and can choose.
        const personal = (b: number) => {
          const lb = pairedBrowsers().find(x => x.n === b);
          return lb && !lb.managed
            ? `\n\nNote: ${label(b)} is a person's own browser, with their own accounts signed in - a new account made there sits beside theirs (the site may link the two). Fine when this account needs something only that browser has. If not, call start_sign_up again with new_profile true for a clean agents' profile, before typing anything.`
            : '';
        };
        const t = await startAttempt(row.id, { username, browser: n, runId: ctx.runId, fresh: a.new_password === true, now: ctx.now() });
        const b = t.row.browser ?? n;
        if (t.reuse)
          return `${row.id}: an earlier try already typed a password into ${row.site} as ${username}, so the account may exist. Don't sign up again yet: in ${label(b)} (pass browser ${b}), open ${row.site}'s sign-in page and sign in as ${username}, typing the password with signed_in_browser.type_password, password_id "${t.passwordId}". Signed in: finish anything it still asks, open the profile or settings page, and signed_in_browser.check_account. The site says there's no such account, or the password is wrong: call start_sign_up again with new_password true, and sign up afresh.`;
        return `${row.id}: password #${t.passwordId} made for ${username} at ${row.site}. It is NOT in the password store yet - it joins it only when the app has seen the account working. Sign up in ${label(b)}: pass browser ${b} to the signed_in_browser tools, fill the form, and type the password with signed_in_browser.type_password, password_id "${t.passwordId}" (in both boxes if it asks twice). Then submit. Signed in: open the account's profile or settings page and call signed_in_browser.check_account with "${row.id}". Stopped by something only a person can do: signed_in_browser.show_person with account_id "${row.id}", then straight on to your next account.${personal(b)}`;
      },
    },
    {
      id: 'signed_in_browser.type_password',
      tier: 'T1',
      description: 'Type a password from the store into a numbered password field (you never see it). submit presses Enter afterwards.',
      schema: obj({ ref: { type: 'number' }, password_id: { type: 'string', description: 'The password number from start_sign_up or passwords' }, submit: { type: 'boolean' }, browser: BROWSER_ARG }, ['ref', 'password_id']),
      impl: async (a, ctx) => {
        const row = passwordRow(String(a.password_id ?? ''));
        const s = await session(ctx, whichBrowser(ctx, browserArg(a) ?? row?.profile));
        await stopIfWindowClosed(s);
        const typed = await s.page.fill(Number(a.ref), await readPassword(String(a.password_id ?? '')));
        // For the account it's a sign-up for: only a password the field kept can be confirmed.
        if (row) passwordTyped(row.id, typed.ok, await s.page.url().catch(() => ''), ctx.now());
        if (a.submit) await s.page.pressEnter();
        await wait(a.submit ? 1500 : 200);
        // Never what the field holds: that's the password.
        return `${typed.ok ? '' : `[${a.ref}] didn't keep the password as typed (typed, typed key by key, and set directly). Check it's the password field, not one beside it.\n\n`}${await snapshot(s.page)}`;
      },
    },
    {
      id: 'signed_in_browser.passwords',
      tier: 'T0',
      description: "The accounts in the agency's password store: site, username, password number and the browser it's in - never the passwords. Only accounts that exist are here: a sign-up still under way is in signed_in_browser.accounts.",
      schema: obj({ site: { type: 'string', description: 'Only this site (optional)' } }, []),
      impl: async a => {
        const rows = listPasswords(a.site ? String(a.site) : null);
        if (!rows.length) return 'No accounts in the store yet.';
        const list = rows.map(r => `#${r.id} ${r.site} - ${r.username} (browser ${r.profile})${r.confirmed_at ? '' : ' - NOT CONFIRMED'}${r.note ? ` - ${r.note}` : ''}`).join('\n');
        return rows.some(r => !r.confirmed_at) ? `${list}\n\n${UNCONFIRMED}` : list;
      },
    },
    {
      id: 'signed_in_browser.check_account',
      tier: 'T1',
      description:
        "Have the app check that an account you signed up for really works - the only way one becomes working and its password joins the store. Call it on a page of that site where the account shows signed in (its profile, account settings, or home page). The app reads the page itself: it must be on that site, show no sign-up or sign-in form, show the account signed in, and the password must have gone in as typed. It says working, or exactly what's missing - then fix that and check again. Your own word that a sign-up worked counts for nothing: unchecked, the account does not exist. password_id instead: an old NOT CONFIRMED store account, after signing in with it.",
      schema: obj({ account_id: { type: 'string', description: 'The account, from signed_in_browser.accounts' }, password_id: { type: 'string', description: 'Or, for an old store account marked NOT CONFIRMED: its password number' }, browser: BROWSER_ARG }, []),
      impl: async (a, ctx) => {
        const now = ctx.now();
        let row: AccountRow;
        if (a.account_id != null && String(a.account_id).trim()) row = ownAccount(ctx, a.account_id);
        else {
          // Saved before sign-ups were checked: it becomes an account in the record, checked like any.
          const pw = passwordRow(String(a.password_id ?? ''));
          if (!pw) throw new Error('Give account_id (signed_in_browser.accounts lists them).');
          if (pw.confirmed_at) return `#${pw.id} (${pw.username} at ${pw.site}) is already confirmed.`;
          const had = pw.account_id ? accountRow(pw.account_id) : undefined;
          row = had ?? needAccounts(pw.agent_id ?? ctx.agent.id, [{ site: pw.site, purpose: pw.note || `${pw.username} at ${pw.site}` }], now)[0];
          if (!had) {
            exec("UPDATE accounts SET state = 'started', username = ?, browser = ?, password_id = ?, typed_ok = 1, run_id = ?, updated_at = ? WHERE id = ? AND state != 'working'", pw.username, pw.profile, pw.id, ctx.runId, now, row.id);
            exec('UPDATE passwords SET account_id = ? WHERE id = ?', row.id, pw.id);
            row = accountRow(row.id)!;
          }
          if (!canWork(row, ctx.agent.id)) throw new Error("That account isn't yours.");
        }
        if (row.state === 'working') return `${row.id} (${row.username} at ${row.site}) is already working.`;
        if (row.state === 'cancelled') return `${row.id} was cancelled by a person. Leave it.`;
        if (row.state === 'waiting') return `${row.id}'s page is with the person: nothing to check until they've finished (signed_in_browser.wait_for_person).`;
        const n = whichBrowser(ctx, browserArg(a) ?? row.browser);
        const s = sessions.get(sessionKey(ctx.runId, n));
        if (!s?.cdp || s.page.isClosed())
          return `Not checked: you have no page open in ${label(n)}. Open a page of ${row.site} where the account shows signed in (its profile or settings) - or, if the person left its tab open, signed_in_browser.tabs list and switch to it - then check again.`;
        await untilFree(s.cdp);
        const facts = await s.page.evaluate<PageFacts>(PAGE_FACTS_EXPR);
        const problems = judgeAccountPage(row, facts);
        if (problems.length) {
          exec('UPDATE accounts SET last_error = ?, updated_at = ? WHERE id = ?', `not seen working: ${problems[0]}`.slice(0, 400), now, row.id);
          return `NOT working yet - ${row.id} (${row.username} at ${row.site}) stays owed, and is not in the password store:\n${problems.map(x => `- ${x}`).join('\n')}\n\nFix that and check again. If the sign-up itself didn't go through, start_sign_up again; if it needs the person, show_person with account_id "${row.id}".`;
        }
        const done = markWorking(row.id, now);
        const left = accountsOwed(ctx.agent.id).filter(x => x.state === 'needed' || x.state === 'started' || x.state === 'returned');
        return `Working: ${done.id} - ${done.username} at ${done.site} is signed in, and its password (#${done.password_id}) is in the password store now, in browser ${done.browser ?? n}.${left.length ? ` Still to do: ${left.map(x => `${x.id} ${x.site}`).join(', ')}.` : ''}`;
      },
    },
    {
      id: 'signed_in_browser.wait_for_person',
      tier: 'T1',
      description: `Hand the person every page you kept for an account (show_person with account_id) in ONE request, and wait here for them - up to ${WAIT_FOR_PERSON_MIN} minutes - so you carry straight on when they finish. Call it once, when every account you owe is either working or kept for them: never after the first. It comes back when they're done (their tabs are yours again: finish each sign-up and check_account), or says they haven't got to it - then end your run, and you're woken the moment they finish.`,
      schema: obj({}, []),
      impl: async (_a, ctx) => {
        const undone = accountsOwed(ctx.agent.id).filter(x => (x.state === 'needed' || x.state === 'started') && (x.next_try_at ?? 0) <= ctx.now() + 60_000);
        const request = fileAccountAsk({ id: ctx.agent.id, name: ctx.agent.name }, ctx.runId, ctx.now());
        if (request == null) return `Nothing of yours is waiting on the person: no account's page is kept for them. ${undone.length ? `Still yours to do first: ${undone.map(x => `${x.id} ${x.site}`).join(', ')}.` : 'Carry on.'}`;
        const pages = askPages(request).length;
        const release = holdForRun(request);
        const until = Date.now() + WAIT_FOR_PERSON_MIN * 60_000;
        let status = 'open';
        try {
          while (Date.now() < until && !ctx.signal?.aborted && !endedRuns.has(ctx.runId)) {
            status = one<{ status: string }>('SELECT status FROM requests WHERE id = ?', request)?.status ?? 'done';
            if (status !== 'open') break;
            await sleep(WAIT_POLL_MS);
          }
          if (status === 'open') return `Request #${request} is with the person (${pages} page${pages === 1 ? '' : 's'}), and they haven't finished in ${WAIT_FOR_PERSON_MIN} minutes. Don't wait longer and don't ask again: end your run with a summary that says these accounts are waiting on them. You'll be woken the moment they finish, whatever your ferocity.${undone.length ? ` (Before you end: ${undone.map(x => `${x.id} ${x.site}`).join(', ')} ${undone.length === 1 ? 'is' : 'are'} still yours to do.)` : ''}`;
          // Heard here, in this run: not again as news, and no second wake for it.
          exec('UPDATE requests SET delivered_at = ? WHERE id = ?', ctx.now(), request);
          return askOutcome(request, status === 'rejected' ? 'rejected' : 'done');
        } finally {
          release();
        }
      },
    },
    {
      id: 'signed_in_browser.show_person',
      tier: 'T1',
      description:
        "For what only a person can do on a page: a CAPTCHA puzzle (after tick_security_check didn't pass it), a code sent to their phone, an ID check. On a sign-up or sign-in for an account you owe, give its account_id: the page is kept but NOT asked for yet - go on to your next account, and signed_in_browser.wait_for_person hands the person every such page in one request. Any other page: fill in everything else first and call this while you're still on that page: the tab is kept as it is, with the browser's debugger off it (so a check like Cloudflare sees a normal browser), in a \"Waiting on you\" tab group, and a request is filed whose button brings the person straight to it. They do the check, press Submit and press Done on the request: the tab comes back to you still open (tabs list), so carry on there. Don't file a request yourself as well. Your next browser step starts on a new page: get on with the rest - the other sign-ups or pages of the same batch first, each filled in up to its own check and kept with show_person, so the person does them all in one go - and you'll hear when they're done. google true instead: the person signs in to Google in a normal tab of this browser (Google won't let a driven browser sign in) - after that \"Sign in with Google\" on any site is yours: click it and choose the account.",
      schema: obj(
        {
          what: { type: 'string', description: 'For the request\'s title, in 10 words or fewer: what they need to do and why - "Pass the CAPTCHA to send the Tech Talks Daily pitch"' },
          why: { type: 'string', description: "What's filled in and waiting, and what happens once they've done it" },
          google: { type: 'boolean', description: 'True for signing in to Google in this browser, not a page you are on' },
          account_id: { type: 'string', description: 'The account this page is a sign-up or sign-in for (signed_in_browser.accounts)' },
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
        return a.google ? keepGoogle(ctx, n, what, why) : keepForPerson(ctx, n, what, why, a.account_id);
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
