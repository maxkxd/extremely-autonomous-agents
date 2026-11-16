// A browser driven one page at a time over the DevTools protocol - no automation
// library. In the app the connection is the EXTREMELY extension's relay in the
// person's own Chrome or Edge (browser-link.ts, docs/browser-extension.md); in tests
// it's a browser's own DevTools address (Cdp, below).
//
// Only an agent's own tab is ever attached, never the person's, and a tab kept for
// the person is detached first: to Google, Cloudflare and hCaptcha it's the plain
// browser it is.
//
// Nothing here turns on Runtime events (Runtime.enable), which pages can notice:
// scripts are run with Runtime.evaluate alone - and in a world of their own
// (Page.createIsolatedWorld), so nothing the agent's page view adds is in the page's.

type Listener = (params: any, sessionId?: string) => void;

// What CdpPage needs from a browser connection. Cdp (a DevTools address, used by
// tests) and the extension's relay (browser-link.ts) both are one.
export interface CdpConn {
  readonly closed: boolean;
  send<T = any>(method: string, params?: Record<string, unknown>, sessionId?: string, timeout?: number): Promise<T>;
  on(method: string, fn: Listener): () => void;
  onClose(fn: () => void): void;
  close(): void;
}

// A call the browser never answers (a page stuck in a dialog, a renderer that hung)
// fails after this, instead of holding its run for ever.
const SEND_TIMEOUT_MS = 60_000;

export class Cdp implements CdpConn {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private closers = new Set<() => void>();
  closed = false;

  private constructor(private ws: WebSocket) {
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data as ArrayBuffer).toString());
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` ${msg.error.data}` : ''}`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params, msg.sessionId);
      }
    });
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('The browser closed.'));
      this.pending.clear();
      for (const fn of this.closers) fn();
    });
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new Error("Couldn't reach the browser.")), { once: true });
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeout = SEND_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser closed.'));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`The browser didn't answer ${method} in ${Math.round(timeout / 1000)} s.`));
      }, timeout);
      timer.unref?.();
      this.pending.set(id, {
        resolve: v => (clearTimeout(timer), resolve(v)),
        reject: e => (clearTimeout(timer), reject(e)),
      });
    });
  }

  on(method: string, fn: Listener): () => void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  onClose(fn: () => void) {
    this.closers.add(fn);
  }

  close() {
    this.ws.close();
  }
}

export type Bounds = { left: number; top: number; width: number; height: number };
// A person's input on a page they've taken over (live-view.ts), in the page's own pixels.
export type PersonInput =
  | { type: 'mouse'; action: 'mousePressed' | 'mouseReleased' | 'mouseMoved'; x: number; y: number; button?: 'left' | 'middle' | 'right' | 'none'; buttons?: number; clickCount?: number; modifiers?: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: number }
  | { type: 'key'; action: 'down' | 'up'; key: string; code: string; keyCode: number; text?: string; modifiers?: number }
  | { type: 'text'; text: string };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
// The keys an agent can press (signed_in_browser.press).
export const KEYS = {
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Escape: { code: 'Escape', vk: 27 },
  Tab: { code: 'Tab', vk: 9 },
  Backspace: { code: 'Backspace', vk: 8 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  PageDown: { code: 'PageDown', vk: 34 },
  PageUp: { code: 'PageUp', vk: 33 },
  Space: { code: 'Space', vk: 32, text: ' ' },
} as const satisfies Record<string, { code: string; vk: number; text?: string }>;
export type Key = keyof typeof KEYS;

// A character's key, for typing key by key (a masked field that only listens to keys).
// Null: no key of its own here, so it goes in as text.
function keyOf(ch: string): { code: string; vk: number; shift?: boolean } | null {
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, vk: ch.charCodeAt(0) };
  if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}`, vk: ch.toUpperCase().charCodeAt(0) };
  if (/^[A-Z]$/.test(ch)) return { code: `Key${ch}`, vk: ch.charCodeAt(0), shift: true };
  const other: Record<string, { code: string; vk: number; shift?: boolean }> = {
    ' ': { code: 'Space', vk: 32 }, '/': { code: 'Slash', vk: 191 }, '-': { code: 'Minus', vk: 189 }, '.': { code: 'Period', vk: 190 },
    ',': { code: 'Comma', vk: 188 }, '@': { code: 'Digit2', vk: 50, shift: true }, '+': { code: 'Equal', vk: 187, shift: true },
    '(': { code: 'Digit9', vk: 57, shift: true }, ')': { code: 'Digit0', vk: 48, shift: true }, ':': { code: 'Semicolon', vk: 186, shift: true },
    '_': { code: 'Minus', vk: 189, shift: true },
  };
  return other[ch] ?? null;
}

// The same text, a mask's own separators aside: "01/15/1990" is "01151990", and
// "(555) 010-1234" is "5550101234".
export const looseText = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();

// The browser's own date fields, and what each takes.
const DATE_FORMS = { date: 'a date, e.g. 1990-01-15 or 01/15/1990', month: 'a month, e.g. 1990-01', 'datetime-local': 'a date and time, e.g. 1990-01-15 09:30', time: 'a time, e.g. 09:30 or 9:30 pm', week: 'a week, e.g. 1990-W03' } as const;
type DateKind = keyof typeof DATE_FORMS;
// The order a page's date field shows its parts in (from its language): month-day-year in the US.
export type DateOrder = 'mdy' | 'dmy' | 'ymd';
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const fullYear = (y: number) => (y >= 100 ? y : y + (y > (new Date().getFullYear() % 100) ? 1900 : 2000));
const realDate = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

function dateParts(text: string, order: DateOrder): { y: number; m: number; d: number } | null {
  const s = text.trim().toLowerCase();
  let m: RegExpExecArray | null;
  if ((m = /^(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})/.exec(s))) return { y: +m[1], m: +m[2], d: +m[3] };
  if ((m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2}|\d{4})\b/.exec(s))) {
    const a = +m[1], b = +m[2], y = fullYear(+m[3]);
    if (a > 12) return { y, m: b, d: a };
    if (b > 12) return { y, m: a, d: b };
    return order === 'dmy' ? { y, m: b, d: a } : { y, m: a, d: b };
  }
  if ((m = /^(\d{8})$/.exec(s))) {
    const t = m[1];
    if (order === 'ymd' || +t.slice(0, 4) > 1300) return { y: +t.slice(0, 4), m: +t.slice(4, 6), d: +t.slice(6) };
    return order === 'dmy' ? { y: +t.slice(4), m: +t.slice(2, 4), d: +t.slice(0, 2) } : { y: +t.slice(4), m: +t.slice(0, 2), d: +t.slice(2, 4) };
  }
  // Words: "January 15, 1990", "15 Jan 1990".
  const month = MONTHS.findIndex(n => new RegExp(`\\b${n}`).test(s));
  if (month >= 0) {
    const year = /\b(\d{4})\b/.exec(s);
    const day = /\b(\d{1,2})(?:st|nd|rd|th)?\b/.exec(s.replace(/\b\d{4}\b/, ''));
    if (year && day) return { y: +year[1], m: month + 1, d: +day[1] };
  }
  return null;
}

function timePart(text: string): string | null {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap])?\.?m?\.?\s*$/i.exec(text.trim()) ?? /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!m) return null;
  let h = +m[1];
  const ap = m[4]?.toLowerCase();
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  if (h > 23 || +m[2] > 59) return null;
  return `${pad(h)}:${m[2]}${m[3] ? `:${m[3]}` : ''}`;
}

// What a browser date field's value is for what the agent typed: "01/15/1990",
// "15 January 1990" and "1990-01-15" are all 1990-01-15. Null when it isn't one.
export function dateValue(kind: DateKind, text: string, order: DateOrder = 'mdy'): string | null {
  const s = text.trim();
  if (kind === 'time') return timePart(s);
  if (kind === 'week') {
    const w = /^(\d{4})-?w(\d{1,2})$/i.exec(s);
    return w && +w[2] >= 1 && +w[2] <= 53 ? `${w[1]}-W${pad(+w[2])}` : null;
  }
  if (kind === 'month') {
    let m = /^(\d{4})[-/. ](\d{1,2})$/.exec(s);
    if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${pad(+m[2])}`;
    m = /^(\d{1,2})[-/. ](\d{4})$/.exec(s);
    if (m && +m[1] >= 1 && +m[1] <= 12) return `${m[2]}-${pad(+m[1])}`;
    const month = MONTHS.findIndex(n => new RegExp(`\\b${n}`, 'i').test(s));
    const year = /\b(\d{4})\b/.exec(s);
    if (month >= 0 && year) return `${year[1]}-${pad(month + 1)}`;
    const p = dateParts(s, order);
    return p && realDate(p.y, p.m, p.d) ? `${pad(p.y, 4)}-${pad(p.m)}` : null;
  }
  const p = dateParts(s, order);
  if (!p || !realDate(p.y, p.m, p.d)) return null;
  const date = `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}`;
  if (kind === 'date') return date;
  return `${date}T${timePart(s) ?? '00:00'}`;
}
// A numbered control in the page: through the page view's finder (browser.ts), which
// also finds one the page drew again since it was numbered.
const EL = (ref: number) => `(window.__eaa ? window.__eaa.find(${Number(ref)}) : document.querySelector('[data-eaa-ref="${Number(ref)}"]'))`;

const gone = (ref: number) => `There's no [${ref}] on the page now - look at it again (scroll, or open it) and use a number from what you see.`;

// The controls inside an embedded frame are numbered from here up: frame 1's from
// 10001, frame 2's from 20001, so a number says which document it's in.
export const FRAME_BASE = 10_000;
type Frame = {
  no: number;
  id: string;
  url: string;
  session: string; // the frame's own, for one in another process
  owner: string; // the session of the document its <iframe> is in
  parent?: string; // that document's frame id, when it's a frame too
  context?: number; // its isolated world: the page's own scripts can't see the helpers
};

// One page an agent works in: its own window, attached to it alone (and to the
// frames embedded in it, which a cross-site <iframe> needs: only those, nothing else).
export class CdpPage {
  private closedFlag = false;
  private children = new Map<string, { session: string; owner: string; parent?: string }>(); // out-of-process frames, by frame id
  private frameByNo = new Map<number, Frame>();
  private frameNo = new Map<string, number>();
  private allow?: (url: string) => Promise<boolean>;
  private mainFrame?: string;
  private mainContext?: number; // the page view's own world in the page's document
  private dialogs: string[] = []; // what the page said in alerts and confirms since last asked
  private offs: (() => void)[] = []; // its listeners on the connection, removed when it's let go
  private constructor(
    private cdp: CdpConn,
    readonly targetId: string,
    private session: string,
  ) {
    this.offs = [
      cdp.on('Target.detachedFromTarget', p => {
        if (p.sessionId === session) this.closedFlag = true;
        for (const [id, c] of this.children) if (c.session === p.sessionId) this.children.delete(id);
      }),
      cdp.on('Target.attachedToTarget', (p, parent) => {
        if (!parent || !this.owns(parent) || p.targetInfo.type !== 'iframe') return;
        this.children.set(p.targetInfo.targetId, { session: p.sessionId, owner: parent, parent: p.targetInfo.parentFrameId });
        void this.watchFrames(p.sessionId).catch(() => {});
      }),
      cdp.on('Target.targetDestroyed', p => p.targetId === targetId && (this.closedFlag = true)),
      // A new document (a navigation, or one back from the back/forward cache): its own world.
      cdp.on('Page.frameNavigated', (p, s) => {
        if (s === session && !p.frame.parentId) [this.mainContext, this.mainFrame] = [undefined, p.frame.id];
      }),
      // An alert, confirm or "leave this page?" holds the page - and every call to it -
      // until it's answered: answered as the agent's click meant it (OK), and told.
      cdp.on('Page.javascriptDialogOpening', (p, s) => {
        if (!s || !this.owns(s)) return;
        this.dialogs.push(`${p.type === 'beforeunload' ? 'Leave this page?' : p.type}: "${String(p.message ?? '').slice(0, 300)}"`);
        void cdp.send('Page.handleJavaScriptDialog', { accept: p.type !== 'prompt' }, s).catch(() => {});
      }),
    ];
    cdp.onClose(() => {
      this.closedFlag = true;
      this.dispose();
    });
  }

  private dispose() {
    this.offs.forEach(f => f());
    this.offs = [];
  }

  // A new tab, not brought in front of what the person's doing. eaaGroup: the
  // extension's tab group it goes in (a run's: its id and the agent's name). Without
  // one (a browser's own DevTools address, in tests) it's a window of its own.
  static async open(cdp: CdpConn, bounds: Bounds, url = 'about:blank', opts: { eaaGroup?: { key: string; title: string; color?: string } } = {}): Promise<CdpPage> {
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', opts.eaaGroup ? { url, background: true, eaaGroup: opts.eaaGroup } : { url, newWindow: true, background: true, ...bounds });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new CdpPage(cdp, targetId, sessionId);
    await page.watchFrames(sessionId);
    return page;
  }

  // A page already open in the browser (one kept for the person, found again after the app restarted).
  static async attach(cdp: CdpConn, targetId: string): Promise<CdpPage> {
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new CdpPage(cdp, targetId, sessionId);
    await page.watchFrames(sessionId);
    return page;
  }

  // The windows this page has opened (a "Sign in with..." pop-up, a link to a new tab).
  async popups() {
    const { targetInfos } = await this.cdp.send<{ targetInfos: { targetId: string; type: string; openerId?: string }[] }>('Target.getTargets');
    return targetInfos.filter(t => t.type === 'page' && t.openerId === this.targetId).map(t => t.targetId);
  }

  // One of those windows, to work in.
  async adopt(targetId: string): Promise<CdpPage> {
    const { sessionId } = await this.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    const page = new CdpPage(this.cdp, targetId, sessionId);
    await page.watchFrames(sessionId);
    return page;
  }

  private owns(session: string) {
    return session === this.session || [...this.children.values()].some(c => c.session === session);
  }

  private async watchFrames(session: string) {
    await this.cdp.send('Page.enable', {}, session);
    // Behind the person's windows, a page still acts as the one in front: keys reach it
    // (a window without focus never got an Escape), and it doesn't hold back as a page
    // in the background does.
    if (session === this.session) await this.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, session).catch(() => {});
    await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true, filter: [{ type: 'iframe', exclude: false }, { exclude: true }] }, session);
    if (this.allow) await this.fetchOn(session);
  }

  private send<T = any>(method: string, params: Record<string, unknown> = {}) {
    return this.cdp.send<T>(method, params, this.session);
  }

  isClosed() {
    return this.closedFlag || this.cdp.closed;
  }

  // Closed with its whole browser (it went offline, or quit), not on its own.
  browserGone() {
    return this.cdp.closed;
  }

  // In front of the person's other windows: its window shown (not minimised) and this tab in it.
  // raise: in front of the person's other windows too. Windows won't let another
  // program take the front, but a window that comes back from minimized does.
  async bringToFront(raise = false) {
    const w = await this.cdp.send<{ windowId: number; bounds: { windowState?: string } }>('Browser.getWindowForTarget', { targetId: this.targetId }).catch(() => null);
    if (w && raise && w.bounds.windowState !== 'minimized') await this.cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'minimized' } }).catch(() => {});
    if (w && (raise || w.bounds.windowState === 'minimized')) await this.cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: w.bounds.windowState === 'maximized' ? 'maximized' : 'normal' } }).catch(() => {});
    await this.send('Page.bringToFront');
  }

  // What the page's alerts and confirms said since last asked (each was answered OK).
  takeDialogs() {
    const d = this.dialogs;
    this.dialogs = [];
    return d;
  }

  async close() {
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
    this.closedFlag = true;
    this.dispose();
  }

  // The debugger off the tab, which stays open as it is: a security check, or the
  // person, sees a browser nobody is driving. This page object is done with; attach()
  // makes a new one on the same tab.
  async detach() {
    this.closedFlag = true;
    this.dispose();
    await this.cdp.send('Target.detachFromTarget', { sessionId: this.session }).catch(() => {});
  }

  // Every page and frame the page loads goes through allow() first: the addresses an
  // agent can be steered to. What a page then loads itself (its images, its scripts) is
  // left to the browser, which keeps public pages off this computer's network as it does
  // for anyone - pausing each of those used to slow every page, and trip the checks
  // sites time (a CAPTCHA that wouldn't load).
  async guard(allow: (url: string) => Promise<boolean>) {
    this.allow = allow;
    this.offs.push(this.cdp.on('Fetch.requestPaused', (p, sessionId) => {
      if (!sessionId || !this.owns(sessionId)) return;
      void allow(p.request.url).then(
        ok => this.cdp.send(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {}),
        () => this.cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }, sessionId).catch(() => {}),
      );
    }));
    await Promise.all([this.session, ...[...this.children.values()].map(c => c.session)].map(s => this.fetchOn(s)));
  }

  private fetchOn(session: string) {
    return this.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] }, session);
  }

  // In the page view's own world: it sees the page's document, the page never sees it.
  async evaluate<T = unknown>(expression: string): Promise<T> {
    for (let tries = 0; ; tries++) {
      try {
        this.mainFrame ??= (await this.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree')).frameTree.frame.id;
        this.mainContext ??= (await this.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: this.mainFrame, worldName: 'eaa' })).executionContextId;
        return await this.run<T>(this.session, expression, this.mainContext);
      } catch (e) {
        // A document that went away between the two (a navigation): its new one, once.
        this.mainContext = undefined;
        if (tries >= 2 || !/context|frame/i.test((e as Error).message)) throw e;
        if (/frame/i.test((e as Error).message)) this.mainFrame = undefined;
      }
    }
  }

  // In the page's own world: only for what has to be there for a moment (watching a Copy button).
  evaluateInPage<T = unknown>(expression: string): Promise<T> {
    return this.run<T>(this.session, expression);
  }

  private async run<T>(session: string, expression: string, contextId?: number): Promise<T> {
    const r = await this.cdp.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      ...(contextId ? { contextId } : {}),
    }, session);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  // --- Embedded frames ------------------------------------------------------------------

  // The frames in the page now, each with its number.
  async frames() {
    const found = new Map<string, Omit<Frame, 'no'>>();
    type Tree = { frame: { id: string; url: string }; childFrames?: Tree[] };
    const walk = async (session: string, root?: { owner: string; parent?: string }) => {
      const { frameTree } = await this.cdp.send<{ frameTree: Tree }>('Page.getFrameTree', {}, session);
      const visit = (t: Tree, parent: string | undefined, isRoot: boolean) => {
        if (!isRoot) found.set(t.frame.id, { id: t.frame.id, url: t.frame.url, session, owner: session, parent });
        else if (root) found.set(t.frame.id, { id: t.frame.id, url: t.frame.url, session, owner: root.owner, parent: root.parent });
        for (const c of t.childFrames ?? []) visit(c, t.frame.id, false);
      };
      visit(frameTree, undefined, true);
    };
    await walk(this.session);
    await Promise.all([...this.children.values()].map(c => walk(c.session, c).catch(() => {})));
    const was = new Map([...this.frameByNo.values()].map(f => [f.id, f]));
    this.frameByNo.clear();
    for (const f of found.values()) {
      const no = this.frameNo.get(f.id) ?? this.frameNo.size + 1;
      this.frameNo.set(f.id, no);
      const old = was.get(f.id);
      this.frameByNo.set(no, { ...f, no, context: old?.session === f.session ? old.context : undefined });
    }
    return [...this.frameByNo.values()].map(({ no, url }) => ({ no, url }));
  }

  evaluateInFrame<T = unknown>(no: number, expression: string): Promise<T> {
    const f = this.frameByNo.get(no);
    if (!f) throw new Error('That frame is gone.');
    return this.inFrame<T>(f, expression);
  }

  // Run where the number lives: in its frame, or the page itself.
  evaluateFor<T = unknown>(ref: number, expression: string): Promise<T> {
    const f = this.frameOf(ref);
    return f ? this.inFrame<T>(f, expression) : this.evaluate<T>(expression);
  }

  private frameOf(ref: number) {
    const n = Math.floor(ref / FRAME_BASE);
    if (!n) return null;
    const f = this.frameByNo.get(n);
    if (!f) throw new Error(gone(ref));
    return f;
  }

  // An isolated world per frame, made again when the frame has moved to a new document.
  private async inFrame<T>(f: Frame, expression: string): Promise<T> {
    for (let tries = 0; ; tries++) {
      f.context ??= (await this.cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: f.id, worldName: 'eaa' }, f.session)).executionContextId;
      try {
        return await this.run<T>(f.session, `window.__eaaBase = ${f.no * FRAME_BASE}; ${expression}`, f.context);
      } catch (e) {
        f.context = undefined;
        if (tries || !/context/i.test((e as Error).message)) throw e;
      }
    }
  }

  // Where a frame's content starts, in the coordinates of the document its <iframe> is in.
  private async ownerBox(f: Frame, scroll: boolean) {
    const send = <T = any>(m: string, p: Record<string, unknown>) => this.cdp.send<T>(m, p, f.owner);
    const { backendNodeId } = await send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: f.id });
    const { object } = await send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId });
    const { result } = await send<{ result: { value: { x: number; y: number } } }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      returnByValue: true,
      arguments: [{ value: scroll }],
      functionDeclaration: `function (scroll) { if (scroll) this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); const r = this.getBoundingClientRect(), c = getComputedStyle(this); return { x: r.x + this.clientLeft + parseFloat(c.paddingLeft), y: r.y + this.clientTop + parseFloat(c.paddingTop) }; }`,
    });
    void send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
    return result.value;
  }

  // Where a frame is in the document that has it, and whether it shows at all (a
  // CAPTCHA's puzzle frame is always there, hidden until it's needed).
  async frameBox(no: number): Promise<{ width: number; height: number; shown: boolean } | null> {
    const f = this.frameByNo.get(no);
    if (!f) return null;
    const send = <T = any>(m: string, p: Record<string, unknown>) => this.cdp.send<T>(m, p, f.owner);
    try {
      const { backendNodeId } = await send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: f.id });
      const { object } = await send<{ object: { objectId: string } }>('DOM.resolveNode', { backendNodeId });
      const { result } = await send<{ result: { value: { width: number; height: number; shown: boolean } } }>('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function () { const r = this.getBoundingClientRect(); return { width: r.width, height: r.height, shown: r.width > 20 && r.height > 20 && r.bottom > 0 && r.right > 0 && (!this.checkVisibility || this.checkVisibility({ visibilityProperty: true, opacityProperty: true })) }; }`,
      });
      void send('Runtime.releaseObject', { objectId: object.objectId }).catch(() => {});
      return result.value;
    } catch {
      return null;
    }
  }

  // A click at a point in a frame, in the frame's own pixels (a box drawn where the
  // page view can't number it: Cloudflare's checkbox is in a closed shadow root).
  async clickFrame(no: number, x: number, y: number) {
    const f = this.frameByNo.get(no);
    if (!f) throw new Error('That frame is gone.');
    await this.offset(f, true);
    const o = await this.offset(f);
    const [session, px, py] = f.session !== this.session ? [f.session, x, y] : [this.session, o.x + x, o.y + y];
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py }, session);
    await sleep(80 + Math.random() * 120);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 }, session);
    await sleep(40 + Math.random() * 60);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 }, session);
  }

  // Where a frame's content starts on the screen (outermost frame first: scrolling
  // each one in moves the ones inside it).
  private async offset(f: Frame, scroll = false) {
    const all = [...this.frameByNo.values()];
    const chain = [f];
    for (let p = all.find(x => x.id === chain[0].parent); p; p = all.find(x => x.id === chain[0].parent)) chain.unshift(p);
    let x = 0, y = 0;
    for (const g of chain) {
      const b = await this.ownerBox(g, scroll);
      x += b.x;
      y += b.y;
    }
    return { x, y };
  }

  // A numbered control in a frame, on the screen - or what's over the frame there.
  private async pointInFrame(f: Frame, ref: number): Promise<{ x: number; y: number; covered?: string; controls?: string[]; inside?: { session: string; x: number; y: number } }> {
    await this.offset(f, true);
    const p = await this.inFrame<{ x: number; y: number; covered?: string; controls?: string[] } | null>(f, this.pointExpr(ref));
    if (!p) throw new Error(gone(ref));
    if (p.covered != null) return p;
    let o = await this.offset(f);
    const h = await this.evaluate<number>('innerHeight');
    if (p.y + o.y < 0 || p.y + o.y > h) {
      await this.evaluate(`scrollBy({ top: ${p.y + o.y - h / 2}, behavior: 'instant' })`);
      o = await this.offset(f);
    }
    const x = p.x + o.x, y = p.y + o.y;
    const over = await this.evaluate<{ covered: string; controls: string[] } | null>(
      `(() => { const h = document.elementFromPoint(${x}, ${y}); if (!h || h.tagName === 'IFRAME' || h.tagName === 'FRAME') return null;
        let c = h; while (c.parentElement && c.parentElement !== document.body && !c.parentElement.querySelector('iframe, frame')) c = c.parentElement;
        return { covered: (c.innerText || c.getAttribute('aria-label') || c.tagName.toLowerCase()).replace(/\\s+/g, ' ').trim().slice(0, 160), controls: window.__eaa && window.__eaa.listIn ? window.__eaa.listIn(c) : [] }; })()`,
    );
    // A frame in another process gets the click itself, at its own coordinates: sent to
    // the page, one straight after a scroll often stopped at the <iframe> and never reached it.
    return { x, y, ...over, ...(f.session !== this.session ? { inside: { session: f.session, x: p.x, y: p.y } } : {}) };
  }

  // Until the page's document has been read (or the time's up - a page that never
  // finishes loading is still worth looking at).
  async ready(ms = 15_000) {
    const until = Date.now() + ms;
    while (Date.now() < until && !this.isClosed()) {
      const state = await this.evaluate<string>('document.readyState').catch(() => 'loading');
      if (state !== 'loading') return;
      await sleep(100);
    }
  }

  async goto(url: string, ms = 30_000) {
    const r = await this.send<{ errorText?: string }>('Page.navigate', { url });
    // "Aborted" also means the site sent the browser on somewhere else as it loaded (a
    // redirect, a sign-in hop): the page it landed on is what was asked for.
    if (r.errorText && /ERR_ABORTED/.test(r.errorText)) {
      await sleep(1_000);
      await this.ready(ms);
      const at = await this.url().catch(() => '');
      if (at && !/^(about:blank|chrome-error:)/.test(at)) return;
    }
    if (r.errorText) throw new Error(`Couldn't open ${url}: ${r.errorText}`);
    await sleep(150);
    await this.ready(ms);
  }

  url() {
    return this.evaluate<string>('location.href');
  }

  // False when there was nothing to go back to.
  async back(): Promise<boolean> {
    const h = await this.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
    if (h.currentIndex < 1) return false;
    await this.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
    await sleep(150);
    await this.ready();
    return true;
  }

  // The middle of a numbered element, scrolled into view.
  // behavior 'instant': on a page set to scroll smoothly (scroll-behavior: smooth) the
  // box is still on its way when measured, and the click lands where it was.
  // covered: the text of what's on top of it there (a pop-up the page opened), if anything.
  // Not a part of the same control: a styled dropdown's "Select..." sits over its input,
  // or its visible button over a hidden <select>, and a click there is the right click.
  private pointExpr(ref: number) {
    return `(() => { const e = ${EL(ref)}; if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); const r = e.getBoundingClientRect();
        const x = r.x + r.width / 2, y = r.y + r.height / 2, h = document.elementFromPoint(x, y);
        if (!h || h === e || e.contains(h) || h.contains(e) || (e.labels && [...e.labels].some(l => l.contains(h)))) return { x, y };
        let a = h; while (a && !a.contains(e)) a = a.parentElement;
        if (a && a !== document.body && a !== document.documentElement && a.getBoundingClientRect().height < 200
          && [...a.querySelectorAll('a[href], button, input:not([type=hidden]), textarea, select, [role=button], [role=link], [role=combobox]')].every(o => o === e || e.contains(o) || o.contains(e) || o.contains(h) || h.contains(o))) return { x, y };
        let c = h; while (c.parentElement && c.parentElement !== document.body && !c.parentElement.contains(e)) c = c.parentElement;
        return { x, y, covered: (c.innerText || c.getAttribute('aria-label') || c.tagName.toLowerCase()).replace(/\\s+/g, ' ').trim().slice(0, 160), controls: window.__eaa && window.__eaa.listIn ? window.__eaa.listIn(c) : [] }; })()`;
  }

  private async point(ref: number) {
    const f = this.frameOf(ref);
    if (f) return this.pointInFrame(f, ref);
    const p = await this.evaluate<{ x: number; y: number; covered?: string; controls?: string[] } | null>(this.pointExpr(ref));
    if (!p) throw new Error(gone(ref));
    return p;
  }

  async click(ref: number) {
    const pt = await this.point(ref);
    const { covered, controls } = pt;
    // The click would land on that instead, and say nothing (aiagentsdirectory.com's
    // "Add Your Product" pop-up over its form read as boxes that won't tick).
    if (covered != null)
      throw new Error(`Something is on top of [${ref}], so the click would land on it instead: "${covered}". Most likely a pop-up or banner the page opened: close it or deal with it first, then click [${ref}] again.${controls?.length ? ` What's on it:\n${controls.join('\n')}` : ''}`);
    const inside = (pt as { inside?: { session: string; x: number; y: number } }).inside;
    const { session, x, y } = inside ?? { session: this.session, x: pt.x, y: pt.y };
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, session);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, session);
    await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, session);
  }

  // Replaces what's in a field, typed in as a person would (so the page sees input),
  // and reads it back. A field that ignores typed-in text gets it another way: a
  // date field (Pinterest's birthdate, request #378) takes no typing at all, so it's
  // set in its own yyyy-mm-dd form; a masked field (MM/DD/YYYY, a phone number) that
  // only listens to keys gets the text key by key; and last, the value is set
  // directly with the events a page's framework listens for. ok: what's in the field
  // now is what was asked for (a mask's own slashes and spaces aside).
  // retry false: typed once and left as the page made it (a searchable list clears
  // or narrows what's typed, and that's not a failure).
  async fill(ref: number, text: string, opts: { retry?: boolean } = {}): Promise<{ ok: boolean; value: string }> {
    const f = this.frameOf(ref);
    if (f) await this.offset(f, true);
    const field = await this.evaluateFor<{ kind: string; order: DateOrder } | null>(
      ref,
      `(() => { const e = ${EL(ref)}; if (!e) return null; e.scrollIntoView({ block: 'center', behavior: 'instant' }); e.focus();
        const kind = e.tagName === 'INPUT' ? (e.type || 'text') : e.tagName === 'TEXTAREA' ? 'textarea' : e.isContentEditable ? 'editable' : e.tagName.toLowerCase();
        let order = 'mdy';
        try { order = new Intl.DateTimeFormat(navigator.language).formatToParts(new Date(2000, 10, 22)).filter(p => p.type === 'month' || p.type === 'day' || p.type === 'year').map(p => p.type[0]).join(''); } catch {}
        return { kind, order: ['mdy', 'dmy', 'ymd'].includes(order) ? order : 'mdy' }; })()`,
    );
    if (!field) {
      await this.point(ref); // says it's gone
      throw new Error(gone(ref));
    }
    const session = f?.session ?? this.session;
    const read = async () => {
      await sleep(60); // a framework's redraw after the input event
      return (await this.evaluateFor<string | null>(ref, `(() => { const e = ${EL(ref)}; if (!e) return null; return 'value' in e && !e.isContentEditable ? String(e.value) : (e.innerText || '').trim(); })()`)) ?? '';
    };

    if (Object.hasOwn(DATE_FORMS, field.kind)) {
      const kind = field.kind as DateKind;
      const want = text.trim() ? dateValue(kind, text, field.order) : '';
      if (want == null) throw new Error(`[${ref}] is a ${kind} field, and "${text}" doesn't read as one. Give it as ${DATE_FORMS[kind]}.`);
      await this.setValue(ref, want);
      let value = await read();
      if (value !== want && kind === 'date' && want) {
        await this.typeDateKeys(ref, want, field.order, session);
        value = await read();
      }
      return { ok: value === want, value };
    }

    const same = (v: string) => v === text || (!!text && looseText(v) === looseText(text));
    await this.selectAll(ref);
    if (text) await this.cdp.send('Input.insertText', { text }, session);
    else for (const type of ['keyDown', 'keyUp']) await this.cdp.send('Input.dispatchKeyEvent', { type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 }, session);
    let value = await read();
    if (same(value) || opts.retry === false) return { ok: same(value), value };
    // Key by key, as a keyboard sends it: a mask that builds the value from keydowns.
    await this.clearByKeys(ref, session, read);
    if (text) await this.typeKeys(text, session);
    value = await read();
    if (same(value)) return { ok: true, value };
    // Set outright, with the input and change events a framework listens for.
    await this.setValue(ref, text);
    value = await read();
    return { ok: same(value), value };
  }

  private async selectAll(ref: number) {
    await this.evaluateFor(
      ref,
      `(() => { const e = ${EL(ref)}; if (!e) return; e.focus();
        if (typeof e.select === 'function') e.select();
        else { const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } })()`,
    );
  }

  // Empties a field with the keyboard: all selected and Backspace, then (a mask that
  // takes one character per Backspace) from the end, one at a time.
  private async clearByKeys(ref: number, session: string, read: () => Promise<string>) {
    await this.selectAll(ref);
    await this.key('Backspace', session);
    let left = (await read()).length;
    if (!left) return;
    await this.evaluateFor(ref, `(() => { const e = ${EL(ref)}; if (!e) return; e.focus(); try { const n = (e.value || '').length; e.setSelectionRange(n, n); } catch {} })()`);
    for (let i = 0; i < Math.min(left, 120); i++) await this.key('Backspace', session);
  }

  private async key(name: Key, session: string) {
    const k: { code: string; vk: number } = KEYS[name];
    for (const type of ['rawKeyDown', 'keyUp']) await this.cdp.send('Input.dispatchKeyEvent', { type, key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk }, session);
  }

  // Each character as its key: keydown (with the character), keyup, a person's pace.
  private async typeKeys(text: string, session: string) {
    for (const ch of text) {
      const k = keyOf(ch);
      if (!k) {
        await this.cdp.send('Input.insertText', { text: ch }, session);
      } else {
        const base = { key: ch, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers: k.shift ? 8 : 0 };
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, text: ch, unmodifiedText: k.shift ? ch.toLowerCase() : ch }, session);
        await this.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, session);
      }
      await sleep(12 + Math.random() * 25);
    }
  }

  // A date field typed as a person does: its parts in the order it shows them
  // (01 22 1990 where it reads mm/dd/yyyy), the field moving on by itself.
  private async typeDateKeys(ref: number, iso: string, order: DateOrder, session: string) {
    const [y, m, d] = iso.split('-');
    const parts = { y, m, d };
    await this.evaluateFor(ref, `(() => { const e = ${EL(ref)}; if (e) { e.blur(); e.focus(); } })()`);
    for (const p of order) {
      await this.typeKeys(parts[p as 'y' | 'm' | 'd'], session);
      await sleep(40);
    }
  }

  // The field's value set outright: the browser's own setter (a framework like React
  // keeps its own copy of the value on the element and ignores a plain assignment),
  // then the input and change events it listens for.
  private async setValue(ref: number, value: string) {
    await this.evaluateFor(
      ref,
      `(() => { const e = ${EL(ref)}; if (!e) return; e.focus(); const v = ${JSON.stringify(value)};
        if (e.isContentEditable && !('value' in e)) { e.textContent = v; }
        else { const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
          const set = Object.getOwnPropertyDescriptor(proto, 'value').set; set.call(e, v); }
        e.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
        e.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
  }

  async pressEnter() {
    await this.press('Enter');
  }

  // A key, as the keyboard sends it, to whatever has the focus.
  async press(key: Key) {
    const k: { code: string; vk: number; text?: string } = KEYS[key];
    const name = key === 'Space' ? ' ' : key;
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, ...(k.text ? { text: k.text } : {}) });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
  }

  // A dropdown's options, or null when it isn't one.
  options(ref: number) {
    return this.evaluateFor<string[] | null>(
      ref,
      `(() => { const e = ${EL(ref)}; return e instanceof HTMLSelectElement ? [...e.options].map(o => o.text.replace(/\\s+/g, ' ').trim()) : null; })()`,
    );
  }

  async select(ref: number, index: number) {
    await this.evaluateFor(
      ref,
      `(() => { const e = ${EL(ref)}; e.selectedIndex = ${index}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
  }

  // Attaches files (paths on this computer) to an upload field: the one the number
  // is, or the hidden file input behind the button or label it is (findInput: the
  // page view's own lookup, an expression returning that input or null).
  async setFiles(findInput: string, files: string[], ref = 0) {
    const f = this.frameOf(ref);
    if (f) await this.inFrame(f, '1'); // its world, current
    else await this.evaluate('1');
    const session = f?.session ?? this.session;
    const r = await this.cdp.send<{ result: { objectId?: string; subtype?: string } }>('Runtime.evaluate', { expression: findInput, returnByValue: false, contextId: f ? f.context : this.mainContext }, session);
    if (!r.result.objectId || r.result.subtype === 'null') return false;
    await this.cdp.send('DOM.setFileInputFiles', { files, objectId: r.result.objectId }, session);
    return true;
  }

  // The same, with the files' contents (base64) instead of paths: put into the input
  // inside the page, as a dropped file is. The browser may be on another computer than
  // the agency (one hosted elsewhere), where a path here means nothing.
  async setFileData(findInput: string, files: { name: string; type: string; base64: string }[], ref = 0) {
    const expr = `(() => { const input = ${findInput}; if (!input) return false;
      const dt = new DataTransfer();
      for (const f of ${JSON.stringify(files)}) { const bin = atob(f.base64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); dt.items.add(new File([bytes], f.name, { type: f.type })); }
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true; })()`;
    return !!(await this.evaluateFor<boolean>(ref, expr));
  }

  // --- Watched by a person (live-view.ts) ---------------------------------------------

  // The page as it is now, small: a JPEG, base64, at `scale` of its size.
  async thumbnail(scale = 0.25, quality = 45): Promise<string> {
    const { w, h } = await this.evaluate<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
    const { data } = await this.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality, clip: { x: 0, y: 0, width: w, height: h, scale } });
    return data;
  }

  // Frames as the page changes (Page.startScreencast), each acknowledged so the
  // next one comes. Returns the stop.
  async screencast(onFrame: (f: { data: string; width: number; height: number }) => void): Promise<() => Promise<void>> {
    const off = this.cdp.on('Page.screencastFrame', (p, sessionId) => {
      if (sessionId !== this.session) return;
      onFrame({ data: p.data, width: p.metadata.deviceWidth, height: p.metadata.deviceHeight });
      void this.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
    });
    await this.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1280, maxHeight: 1000, everyNthFrame: 1 });
    return async () => {
      off();
      await this.send('Page.stopScreencast').catch(() => {});
    };
  }

  // What the person does on it, as the browser's own input: mouse, wheel, keys, pasted text.
  async input(e: PersonInput) {
    if (e.type === 'mouse') return void (await this.send('Input.dispatchMouseEvent', { type: e.action, x: e.x, y: e.y, button: e.button ?? 'left', buttons: e.buttons ?? 0, clickCount: e.clickCount ?? 0, modifiers: e.modifiers ?? 0 }));
    if (e.type === 'wheel') return void (await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: e.x, y: e.y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: e.modifiers ?? 0 }));
    if (e.type === 'text') return void (await this.send('Input.insertText', { text: e.text }));
    await this.send('Input.dispatchKeyEvent', {
      type: e.action === 'up' ? 'keyUp' : e.text ? 'keyDown' : 'rawKeyDown',
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      nativeVirtualKeyCode: e.keyCode,
      modifiers: e.modifiers ?? 0,
      ...(e.action !== 'up' && e.text ? { text: e.text, unmodifiedText: e.text } : {}),
    });
  }

  title() {
    return this.evaluate<string>('document.title');
  }

  // Its address and title as the browser itself knows them: answered even when the
  // page's own process is hung (a run-away script), where url() and title() - asked
  // inside the page - wait the full minute. For listing pages, not for acting on one.
  async info(ms = 3000): Promise<{ url: string; title: string }> {
    const { targetInfo } = await this.cdp.send<{ targetInfo: { url: string; title: string } }>('Target.getTargetInfo', { targetId: this.targetId }, undefined, ms);
    return { url: targetInfo.url, title: targetInfo.title };
  }

  async wheel(deltaY: number) {
    const size = await this.evaluate<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: size.w / 2, y: size.h / 2, deltaX: 0, deltaY });
  }
}
