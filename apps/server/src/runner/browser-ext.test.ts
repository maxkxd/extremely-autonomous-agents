import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { _testing as profilesTesting, adoptProfileFolders, PROFILES_DIR } from './agent-profiles.js';
import { __leaveAloneForTest, __setBrowserConnForTest, agentTabCount, doneWithKeptPage, cleanUpBrowsers, closeRequestsWithLostPages, CONNECT_A_BROWSER, GOOGLE_SIGN_IN, hasKeptPage, keptCaptcha, NO_BROWSER, onPersonDone, pageViewForTests, PROFILE_DIDNT_OPEN, showKeptPage, SIGNED_IN_TOOLS } from './browser.js';
import type { CdpConn } from './cdp.js';
import { all, one, resetDbForTests, run as exec } from './db.js';
import { runEnded, type RunCtx } from './tools.js';

// The agents' browser on the extension (docs/browser-extension.md), against a fake of
// the small DevTools browser the extension emulates: agent tabs only, tab groups, a
// tab detached for the person, closed by the person, the browser going offline and
// coming back.

type Tab = { url: string; group?: { key: string; title: string; collapsed?: boolean }; attached: boolean; openerId?: string; captcha?: boolean; checkbox?: boolean };
type Call = { method: string; params: Record<string, any>; sessionId?: string };

class FakeBrowser implements CdpConn {
  closed = false;
  tabs = new Map<string, Tab>();
  calls: Call[] = [];
  private seq = 0;
  private listeners = new Map<string, Set<(p: any, s?: string) => void>>();
  private closers = new Set<() => void>();
  // A new tab's flags (a page with a CAPTCHA on it).
  next: Partial<Tab> = {};
  constructor(seed: Record<string, Partial<Tab>> = {}) {
    for (const [id, t] of Object.entries(seed)) this.tabs.set(id, { url: 'about:blank', attached: false, ...t });
  }
  on(method: string, fn: (p: any, s?: string) => void) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(fn);
    return () => void this.listeners.get(method)?.delete(fn);
  }
  onClose(fn: () => void) {
    this.closers.add(fn);
  }
  close() {
    this.closed = true;
    for (const fn of this.closers) fn();
  }
  emit(method: string, params: unknown, sessionId?: string) {
    for (const fn of this.listeners.get(method) ?? []) fn(params, sessionId);
  }
  // The person closes a tab.
  personCloses(targetId: string) {
    this.tabs.delete(targetId);
    this.emit('Target.targetDestroyed', { targetId });
    this.emit('EAA.tabClosedByPerson', { targetId });
  }
  of(method: string) {
    return this.calls.filter(c => c.method === method);
  }
  private tab(id: string) {
    const t = this.tabs.get(id);
    if (!t) throw new Error('Not an agent tab');
    return t;
  }
  async send<T = any>(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<T> {
    if (this.closed) throw new Error('The browser closed.');
    this.calls.push({ method, params, sessionId });
    return this.answer(method, params, sessionId) as T;
  }
  private answer(method: string, p: Record<string, any>, sessionId?: string): unknown {
    if (!sessionId) {
      switch (method) {
        case 'Target.createTarget': {
          const id = `t:${++this.seq}`;
          this.tabs.set(id, { url: p.url, group: p.eaaGroup, attached: false, ...this.next });
          this.next = {};
          return { targetId: id };
        }
        case 'Target.attachToTarget':
          this.tab(p.targetId).attached = true;
          return { sessionId: p.targetId };
        case 'Target.detachFromTarget':
          if (this.tabs.has(p.sessionId)) {
            const t = this.tab(p.sessionId);
            t.attached = false;
            // A check that passes by itself once nobody is driving the tab.
            t.checkbox = false;
          }
          this.emit('Target.detachedFromTarget', { sessionId: p.sessionId, targetId: p.sessionId });
          return {};
        case 'Target.closeTarget':
          this.tab(p.targetId);
          this.tabs.delete(p.targetId);
          this.emit('Target.targetDestroyed', { targetId: p.targetId });
          return { success: true };
        case 'Target.activateTarget':
          this.tab(p.targetId);
          return {};
        case 'Target.getTargets':
          return { targetInfos: [...this.tabs].map(([targetId, t]) => ({ targetId, type: 'page', url: t.url, title: '', openerId: t.openerId, attached: t.attached })) };
        case 'Target.getTargetInfo':
          return { targetInfo: { targetId: p.targetId, type: 'page', url: this.tab(p.targetId).url, title: '' } };
        case 'EAA.groupTab':
          this.tab(p.targetId).group = { key: p.key, title: p.title, collapsed: p.collapsed };
          return {};
        case 'EAA.releaseTab':
          this.tabs.delete(p.targetId);
          return {};
        default:
          throw new Error(`Not supported in the extension: ${method}`);
      }
    }
    const t = this.tab(sessionId);
    if (!t.attached) throw new Error('Debugger is not attached to the tab');
    switch (method) {
      case 'Page.navigate':
        t.url = p.url;
        return {};
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: `f-${sessionId}`, url: t.url }, childFrames: t.checkbox ? [{ frame: { id: 'cf', url: 'https://challenges.cloudflare.com/turnstile/v0/x' } }] : [] } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: 7 };
      case 'DOM.getFrameOwner':
        return { backendNodeId: 1 };
      case 'DOM.resolveNode':
        return { object: { objectId: 'o1' } };
      case 'Runtime.callFunctionOn':
        return { result: { value: { width: 300, height: 65, shown: true, x: 0, y: 0 } } };
      case 'Runtime.evaluate':
        return { result: { value: this.evaluate(String(p.expression), t) } };
      default:
        return {};
    }
  }
  private evaluate(expr: string, t: Tab) {
    const call = expr.includes('window.__eaa') && expr.includes('})().') ? expr.slice(expr.lastIndexOf('})().') + 5) : expr;
    if (call.startsWith('view(') || call.includes('.view(')) return { title: 'A form', text: 'Fill this in', items: ['[1] button "Send"'], size: 1e6 };
    if (call.startsWith('settle(')) return true;
    if (call.startsWith('find(')) return true;
    if (expr === 'document.readyState') return 'complete';
    if (expr === 'location.href') return t.url;
    if (expr.includes('cf-turnstile-response')) return !!t.captcha;
    if (expr.includes('scrollIntoView')) return { x: 5, y: 5 };
    if (expr.includes('innerWidth')) return { w: 1280, h: 900 };
    return null;
  }
}

const done: { request: number; text: string }[] = [];
const agent = (id: string, name: string) => ({ id, name, tiers: {} });
const ctx = (runId: string, a = agent('zz-ext-a', 'Lead Finder')) => ({ agent: a, runId, level: 0, now: () => Date.now(), fleet: async () => [], wake: () => {} }) as unknown as RunCtx;
const tool = (name: string) => SIGNED_IN_TOOLS.find(t => t.id === `signed_in_browser.${name}`)!;
const call = (name: string, args: Record<string, unknown>, c: RunCtx) => Promise.resolve(tool(name).impl(args, c));
const tick = () => new Promise(r => setTimeout(r, 50));
const lastRequest = () => one<{ id: number; what: string; evidence: string | null; status: string }>('SELECT id, what, evidence, status FROM requests ORDER BY id DESC LIMIT 1')!;

before(() => {
  resetDbForTests();
  pageViewForTests.allowAllFrames();
  __leaveAloneForTest(20);
  // As the app does (api.ts): the person's done, the request is answered.
  onPersonDone((request, text) => {
    done.push({ request, text });
    exec("UPDATE requests SET status = 'done', answer = ?, answered_at = ? WHERE id = ? AND status = 'open'", text, Date.now(), request);
  });
});

let b1 = new FakeBrowser();

test('no browser online: a plain answer, and one "Connect a browser" request - not one per call', async () => {
  const c = ctx('r-none');
  await assert.rejects(call('open', { url: 'https://example.com/' }, c), (e: Error) => e.message.startsWith(NO_BROWSER) && /Request #\d+/.test(e.message));
  await assert.rejects(call('look', {}, c), (e: Error) => e.message.startsWith(NO_BROWSER));
  const asks = all<{ id: number }>("SELECT id FROM requests WHERE what = ? AND status = 'open'", CONNECT_A_BROWSER);
  assert.equal(asks.length, 1);
  // A browser comes online: the request is answered, and its agent hears.
  await __setBrowserConnForTest(1, b1, 'Chrome - Work');
  assert.ok(done.some(d => d.request === asks[0].id && /online now/.test(d.text)));
});

test("a run's tab opens in its own tab group: the run's id, titled with the agent's name", async () => {
  const c = ctx('r-open');
  const out = await call('open', { url: 'https://example.com/form' }, c);
  assert.match(out, /Fill this in/);
  const made = b1.of('Target.createTarget').at(-1)!;
  assert.deepEqual(made.params.eaaGroup, { key: 'r-open', title: 'Lead Finder' });
  assert.equal(made.params.newWindow, undefined, 'a tab in the person\'s window, not a window of its own');
  assert.equal(b1.of('Target.createBrowserContext').length, 0);
  assert.equal(agentTabCount(1), 1);
  await runEnded('r-open');
  assert.equal(b1.tabs.size, 0, 'closed when the run ends');
  assert.equal(agentTabCount(1), 0);
});

let keptTab = '';
let keptRequest = 0;
test('show_person: the tab comes off the debugger, into "Waiting on you", and outlives the run', async () => {
  const c = ctx('r-kept');
  b1.next = { captcha: true };
  await call('open', { url: 'https://example.com/signup' }, c);
  keptTab = [...b1.tabs.keys()].at(-1)!;
  const said = await call('show_person', { what: 'Pass the CAPTCHA to finish the sign-up', why: 'All filled in' }, c);
  const r = lastRequest();
  keptRequest = r.id;
  assert.match(said, new RegExp(`request #${r.id} is filed`));
  assert.match(r.evidence ?? '', /Open in signed-in browser: https:\/\/example\.com\/signup/);
  assert.deepEqual(b1.of('Target.detachFromTarget').at(-1)!.params, { sessionId: keptTab });
  assert.deepEqual(b1.tabs.get(keptTab)!.group, { key: 'waiting', title: 'Waiting on you', collapsed: false });
  assert.equal(b1.tabs.get(keptTab)!.attached, false);
  assert.equal(hasKeptPage(r.id), true);
  assert.equal(await keptCaptcha(r.id), true);
  // The agent carries on: a new tab. The run ends: that one closes, the kept one stays.
  await call('open', { url: 'https://example.com/next' }, c);
  assert.equal(b1.tabs.size, 2);
  await runEnded('r-kept');
  assert.deepEqual([...b1.tabs.keys()], [keptTab]);
  assert.equal(b1.of('Browser.close').length, 0, 'the browser is the person\'s: never closed');
  // The request's button: the tab, in front.
  assert.equal(await showKeptPage(r.id), 'shown');
  assert.equal(b1.of('Target.activateTarget').at(-1)!.params.targetId, keptTab);
});

test('google true: accounts.google.com in a tab of that browser, never attached', async () => {
  const c = ctx('r-google', agent('zz-ext-b', 'Channel Manager'));
  const said = await call('show_person', { what: 'Sign in to Google for YouTube', google: true }, c);
  const r = lastRequest();
  assert.match(said, new RegExp(`request #${r.id}`));
  const made = b1.of('Target.createTarget').at(-1)!;
  assert.equal(made.params.url, GOOGLE_SIGN_IN);
  assert.equal(made.params.eaaGroup.key, 'waiting');
  const id = [...b1.tabs].find(([, t]) => t.url === GOOGLE_SIGN_IN)![0];
  assert.equal(b1.of('Target.attachToTarget').filter(x => x.params.targetId === id).length, 0, 'Google sees a tab nobody drives');
  // The person signs in and closes it: the request is answered.
  b1.personCloses(id);
  await tick();
  assert.ok(done.some(d => d.request === r.id && /Google sign-in tab/.test(d.text)));
  assert.equal(hasKeptPage(r.id), false);
});

test('the browser goes offline mid-run: the run hears so, and the kept page stays recorded', async () => {
  const c = ctx('r-offline');
  await call('open', { url: 'https://example.com/a' }, c);
  b1.close();
  await __setBrowserConnForTest(1, null, 'Chrome - Work');
  await assert.rejects(call('look', {}, c), (e: Error) => e.message.startsWith(NO_BROWSER));
  assert.equal(hasKeptPage(keptRequest), true);
  assert.equal(await showKeptPage(keptRequest), 'offline', 'nothing to bring up while it is offline');
});

test('back online: the kept page is picked up, an agent tab nobody uses is closed', async () => {
  // The run's tab from before it went offline is still in the browser, nobody's now.
  const b2 = new FakeBrowser({ [keptTab]: { url: 'https://example.com/signup', group: { key: 'waiting', title: 'Waiting on you' } }, 't:900': { url: 'https://example.com/a' } });
  b1 = b2;
  await __setBrowserConnForTest(1, b2, 'Chrome - Work');
  assert.deepEqual([...b2.tabs.keys()], [keptTab]);
  assert.equal(hasKeptPage(keptRequest), true);
  // The person closes it: their request is done, the agent hears.
  b2.personCloses(keptTab);
  await tick();
  assert.ok(done.some(d => d.request === keptRequest && /Closed the page kept for this on example\.com/.test(d.text)));
  assert.equal(hasKeptPage(keptRequest), false);
});

test('a kept page the browser lost while offline: its request is closed by the agency, not a person', async () => {
  const c = ctx('r-lost', agent('zz-ext-c', 'Directory Lister'));
  await call('open', { url: 'https://example.org/listing' }, c);
  await call('show_person', { what: 'Enter the code sent by text' }, c);
  const r = lastRequest();
  b1.close();
  await __setBrowserConnForTest(1, null);
  // The browser restarted: no agent tabs any more.
  b1 = new FakeBrowser();
  await __setBrowserConnForTest(1, b1, 'Chrome - Work');
  await tick();
  assert.equal(one<{ status: string }>('SELECT status FROM requests WHERE id = ?', r.id)!.status, 'withdrawn');
  assert.equal(hasKeptPage(r.id), false);
});

test('browser by name, profile as its old name, and the one the agent last used by default', async () => {
  const edge = new FakeBrowser();
  await __setBrowserConnForTest(2, edge, 'Edge - Agents');
  const c = ctx('r-pick', agent('zz-ext-d', 'Researcher'));
  await call('open', { url: 'https://example.com/', browser: 'edge' }, c);
  assert.equal(edge.of('Target.createTarget').length, 1);
  await call('look', {}, c); // last used: browser 2
  assert.equal(b1.of('Target.createTarget').length, 0);
  await call('open', { url: 'https://example.com/', profile: 1 }, ctx('r-pick-2', agent('zz-ext-d', 'Researcher')));
  assert.equal(b1.of('Target.createTarget').length, 1);
  await assert.rejects(call('open', { url: 'https://example.com/', browser: 'firefox' }, c), /There's no browser firefox\. The browsers are 1 \(Chrome - Work\), 2 \(Edge - Agents\)/);
  await runEnded('r-pick');
  await runEnded('r-pick-2');
});

test('tick_security_check: the tab is left alone first, and a check that passes by itself is just passed', async () => {
  const c = ctx('r-tick', agent('zz-ext-e', 'Signups'));
  await call('open', { url: 'https://example.net/join', browser: 1 }, c);
  const id = [...b1.tabs.keys()].at(-1)!;
  b1.tabs.get(id)!.checkbox = true;
  const out = await call('tick_security_check', {}, c);
  const order = b1.calls.filter(x => x.method === 'Target.detachFromTarget' || (x.method === 'Target.attachToTarget' && x.params.targetId === id)).map(x => x.method);
  assert.deepEqual(order.slice(-2), ['Target.detachFromTarget', 'Target.attachToTarget']);
  assert.match(out, /passed by itself/);
  assert.equal(b1.of('Input.dispatchMouseEvent').length, 0, 'nothing was clicked');
  // Still the run's tab, attached again.
  assert.equal(b1.tabs.get(id)!.attached, true);
  await runEnded('r-tick');
  assert.equal(b1.tabs.has(id), false);
});

// Another run ending sweeps the browser for agent tabs nobody has (closeStrayPages).
// One that lands while a tab is still being opened or kept must leave that tab alone.
class Racy extends FakeBrowser {
  sweepAt = '';
  async send<T = any>(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<T> {
    if (method === this.sweepAt) {
      this.sweepAt = '';
      await cleanUpBrowsers();
    }
    return super.send<T>(method, params, sessionId);
  }
}
test('a sweep while a tab is being opened, or kept for the person, never closes it', async () => {
  const b = new Racy();
  await __setBrowserConnForTest(7, b, 'Chrome - Race');
  const c = ctx('r-race', agent('zz-ext-r', 'Racer'));
  // Between the tab being made and it being the run's: its guard (Fetch.enable).
  b.sweepAt = 'Fetch.enable';
  await call('open', { url: 'https://example.com/', browser: 7 }, c);
  assert.equal(b.sweepAt, '', 'the sweep ran');
  assert.equal(b.of('Target.closeTarget').length, 0, 'the new tab was not swept');
  // The same for a second tab (tabs open).
  b.sweepAt = 'Fetch.enable';
  await call('tabs', { action: 'open', url: 'https://example.com/two', browser: 7 }, c);
  assert.equal(b.of('Target.closeTarget').length, 0);
  assert.equal(b.tabs.size, 2);
  // Google's sign-in tab, between being made and being kept.
  b.sweepAt = 'EAA.groupTab';
  await call('show_person', { what: 'Sign in to Google for the agents', google: true, browser: 7 }, c);
  assert.equal(b.of('Target.closeTarget').length, 0, 'the Google tab was not swept');
  await runEnded('r-race');
  assert.deepEqual([...b.tabs.values()].map(t => t.url), ['https://accounts.google.com/'], "the run's tabs close; the kept one stays");
  await __setBrowserConnForTest(7, null);
});

test('a request whose page went before an update: closed at start, and its button closes it too - never a dead button', async () => {
  const old = Date.now() - 24 * 3_600_000;
  const add = (what: string, at = old) =>
    Number(exec("INSERT INTO requests (agent_id, what, why, evidence, created_at) VALUES ('zz-ext-old', ?, 'a check', ?, ?)", what, 'Open in signed-in browser: https://www.pinterest.com/business/create/ The page is kept as the agent left it.', at).lastInsertRowid);
  const swept = add('Type a birthdate and press Continue');
  const fresh = add('Just filed', Date.now());
  const pressed = add('Pass the check');
  assert.equal(await closeRequestsWithLostPages(), 2, 'the two old ones, not the one filed a moment ago');
  const status = (id: number) => one<{ status: string; answer: string | null }>('SELECT status, answer FROM requests WHERE id = ?', id)!;
  assert.equal(status(swept).status, 'withdrawn');
  assert.match(status(swept).answer ?? '', /not by a person/);
  assert.equal(status(fresh).status, 'open');
  assert.equal(status(pressed).status, 'withdrawn');
  // A button pressed on one the sweep hasn't reached yet closes it there and then.
  const late = add('Enter the code');
  assert.equal(await showKeptPage(late), 'gone');
  assert.equal(status(late).status, 'withdrawn');
});

// --- Agents' profiles (agent-profiles.ts): an offline one opens by itself ---------------

// The browser the app starts, faked: each start's arguments, and (when it "works") the
// extension in it coming online on the link (here: the test's own browsers).
const starts: string[][] = [];
let started: (n: number) => void = () => {};
function fakeSpawn(_exe: string, args: string[]) {
  starts.push(args);
  const n = Number(/browser-profiles[\\/](\d+)/.exec(args.find(a => a.startsWith('--user-data-dir=')) ?? '')?.[1]);
  setTimeout(() => started(n), 30);
  return Object.assign(new EventEmitter(), { pid: 1, exitCode: null, signalCode: null, unref() {} }) as any;
}
async function agentsProfile(n: number) {
  mkdirSync(join(PROFILES_DIR, String(n)), { recursive: true });
  writeFileSync(join(PROFILES_DIR, String(n), 'Local State'), '{}');
  await adoptProfileFolders();
}

test("an offline agents' profile opens by itself, and the tool goes on once it's online; two runs share one start", async () => {
  await agentsProfile(21);
  profilesTesting.setBrowser({ exe: 'C:/fake/msedge.exe', kind: 'edge' });
  profilesTesting.setSpawn(fakeSpawn);
  profilesTesting.setWaits(2000, 500);
  const conns = new Map<number, FakeBrowser>();
  started = n => {
    const b = new FakeBrowser();
    conns.set(n, b);
    void __setBrowserConnForTest(n, b, `Agents' profile ${n}`);
  };
  starts.length = 0;
  const [one1, two] = await Promise.all([
    call('open', { url: 'https://example.com/', browser: 21 }, ctx('r-prof-1', agent('zz-ext-p1', 'Profile One'))),
    call('open', { url: 'https://example.com/two', browser: 21 }, ctx('r-prof-2', agent('zz-ext-p2', 'Profile Two'))),
  ]);
  assert.ok(one1 && two);
  assert.equal(starts.length, 1, 'one start for both runs');
  assert.ok(starts[0].some(a => a.startsWith('--load-extension=')));
  assert.ok(!starts[0].some(a => /remote-debugging/.test(a)));
  const b = conns.get(21)!;
  assert.equal(b.of('Target.createTarget').length, 2, "each run's tab, in the profile that opened");
  assert.equal(all("SELECT id FROM requests WHERE what = ? AND status = 'open'", CONNECT_A_BROWSER).length, 0, 'nobody was asked to open or connect a browser');
  await runEnded('r-prof-1');
  await runEnded('r-prof-2');
  await __setBrowserConnForTest(21, null);
});

test("one that won't come online: a plain answer and one request; not started again for a while", async () => {
  await agentsProfile(22);
  profilesTesting.setWaits(200, 100);
  started = () => {}; // Edge refused the extension: nothing connects
  starts.length = 0;
  const c = ctx('r-prof-3', agent('zz-ext-p3', 'Profile Three'));
  await assert.rejects(call('open', { url: 'https://example.com/', browser: 22 }, c), (e: Error) => /couldn't be opened: .*didn't connect within/.test(e.message) && /Request #\d+/.test(e.message));
  await assert.rejects(call('look', { browser: 22 }, c), (e: Error) => /couldn't be opened/.test(e.message) && /Request #\d+ tells the person: don't file another/.test(e.message));
  assert.equal(starts.length, 1, 'backed off');
  const asks = all<{ id: number; evidence: string }>("SELECT id, evidence FROM requests WHERE what = ? AND status = 'open'", PROFILE_DIDNT_OPEN(22));
  assert.equal(asks.length, 1);
  assert.match(asks[0].evidence, /press Open beside Agents' profile 22/);
  // It comes online after all (the person pressed Open): the request is answered.
  await __setBrowserConnForTest(22, new FakeBrowser(), "Agents' profile 22");
  assert.ok(done.some(d => d.request === asks[0].id && /online now/.test(d.text)));
  await __setBrowserConnForTest(22, null);
  profilesTesting.reset();
  profilesTesting.setBrowser(null);
});

test("a link the Engineer wrote on a card opens that page; it never closes the request - only the request's own lost page does", async () => {
  const b = new FakeBrowser();
  await __setBrowserConnForTest(31, b, 'Edge');
  const id = Number(
    exec("INSERT INTO requests (agent_id, what, why, evidence, created_at) VALUES ('zz-ext-x', 'Face check on X', 'a check', ?, ?)", 'Open in signed-in browser: https://x.com/i/flow/login (browser 31) The page is kept as the agent left it.', Date.now()).lastInsertRowid,
  );
  assert.equal(await showKeptPage(id, { url: 'https://x.com/i/flow/signup', browser: 31 }), 'opened');
  assert.equal(one<{ status: string }>('SELECT status FROM requests WHERE id = ?', id)!.status, 'open', 'still open');
  const made = b.of('Target.createTarget').at(-1)!;
  assert.equal(made.params.url, 'https://x.com/i/flow/signup');
  // The request's own button, its page gone: closed, its agent told.
  assert.equal(await showKeptPage(id, { url: 'https://x.com/i/flow/login', browser: 31 }), 'gone');
  assert.equal(one<{ status: string }>('SELECT status FROM requests WHERE id = ?', id)!.status, 'withdrawn');
  await __setBrowserConnForTest(31, null);
});

test('Done on a kept page: the request is answered and the tab stays open, back with its agent for its next run', async () => {
  const b = new FakeBrowser();
  await __setBrowserConnForTest(32, b, 'Edge');
  const a = agent('zz-ext-done', 'Launch Producer');
  const c = ctx('r-done', a);
  await call('open', { url: 'https://mastodon.example/auth/confirm', browser: 32 }, c);
  const tab = [...b.tabs.keys()].at(-1)!;
  await call('show_person', { what: 'Solve the puzzle to confirm the email', browser: 32 }, c);
  const r = lastRequest();
  assert.match(r.evidence ?? '', /then press Done here/);
  await runEnded('r-done');
  assert.equal(await doneWithKeptPage(r.id), true);
  assert.equal(one<{ status: string }>('SELECT status FROM requests WHERE id = ?', r.id)!.status, 'done');
  assert.match(done.find(d => d.request === r.id)!.text, /left it open for you.*tabs list/);
  assert.ok(b.tabs.has(tab), 'the tab is not closed');
  assert.deepEqual(b.tabs.get(tab)!.group, { key: 'back:zz-ext-done', title: 'Launch Producer', collapsed: true });
  assert.equal(hasKeptPage(r.id), false);
  assert.equal(agentTabCount(32), 1, "counted as the agent's tab, kept open");
  // Its next run finds it.
  const listed = await call('tabs', { action: 'list', browser: 32 }, ctx('r-done-2', a));
  assert.match(listed, /mastodon\.example/);
  await runEnded('r-done-2');
  assert.ok(b.tabs.has(tab), 'still open after the next run ends too');
  assert.equal(await doneWithKeptPage(r.id), false, 'a second Done finds nothing kept');
  await __setBrowserConnForTest(32, null);
});
