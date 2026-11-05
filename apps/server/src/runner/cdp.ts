// A browser driven over its own DevTools address, one page at a time, with
// Node's WebSocket - no automation library.
//
// Why not Playwright on the agents' profiles: connected to a browser, it attaches
// to every page in it, the person's too, and Google's sign-in refuses a page that's
// attached ("This browser or app may not be secure"). Here only an agent's own page
// is ever attached; a window opened for the person never is, so to Google it's the
// plain browser it is. (World Asset Register's runner drives Chrome the same way.)
//
// Nothing here turns on Runtime events (Runtime.enable), which pages can notice:
// scripts are run with Runtime.evaluate alone.

type Listener = (params: any, sessionId?: string) => void;

export class Cdp {
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

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser closed.'));
    const id = ++this.seq;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve, reject }));
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
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// One page an agent works in: its own window, attached to it alone.
export class CdpPage {
  private closedFlag = false;
  private constructor(
    private cdp: Cdp,
    readonly targetId: string,
    private session: string,
  ) {
    const off = [
      cdp.on('Target.detachedFromTarget', p => p.sessionId === session && (this.closedFlag = true)),
      cdp.on('Target.targetDestroyed', p => p.targetId === targetId && (this.closedFlag = true)),
    ];
    cdp.onClose(() => {
      this.closedFlag = true;
      off.forEach(f => f());
    });
  }

  // A new window (shown, but not brought in front of what the person's doing).
  static async open(cdp: Cdp, bounds: Bounds): Promise<CdpPage> {
    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank', newWindow: true, background: true, ...bounds });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    return new CdpPage(cdp, targetId, sessionId);
  }

  private send<T = any>(method: string, params: Record<string, unknown> = {}) {
    return this.cdp.send<T>(method, params, this.session);
  }

  isClosed() {
    return this.closedFlag || this.cdp.closed;
  }

  async close() {
    await this.cdp.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
    this.closedFlag = true;
  }

  // Every request the page makes goes through allow() first.
  async guard(allow: (url: string) => Promise<boolean>) {
    this.cdp.on('Fetch.requestPaused', (p, sessionId) => {
      if (sessionId !== this.session) return;
      void allow(p.request.url).then(
        ok => this.send(ok ? 'Fetch.continueRequest' : 'Fetch.failRequest', ok ? { requestId: p.requestId } : { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {}),
        () => this.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {}),
      );
    });
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split('\n')[0] ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  // Until the page's document has been read (or the time's up - a page that never
  // finishes loading is still worth looking at).
  async ready(ms = 15_000) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const state = await this.evaluate<string>('document.readyState').catch(() => 'loading');
      if (state !== 'loading') return;
      await sleep(100);
    }
  }

  async goto(url: string, ms = 30_000) {
    const r = await this.send<{ errorText?: string }>('Page.navigate', { url });
    if (r.errorText) throw new Error(`Couldn't open ${url}: ${r.errorText}`);
    await sleep(150);
    await this.ready(ms);
  }

  url() {
    return this.evaluate<string>('location.href');
  }

  async back() {
    const h = await this.send<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
    if (h.currentIndex < 1) return;
    await this.send('Page.navigateToHistoryEntry', { entryId: h.entries[h.currentIndex - 1].id });
    await sleep(150);
    await this.ready();
  }

  // The middle of a numbered element, scrolled into view.
  private async point(ref: number) {
    const p = await this.evaluate<{ x: number; y: number } | null>(
      `(() => { const e = document.querySelector('[data-eaa-ref="${ref}"]'); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (!p) throw new Error(`There's no [${ref}] on the page now - look at it again (scroll, or open it) and use a number from what you see.`);
    return p;
  }

  async click(ref: number) {
    const { x, y } = await this.point(ref);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  // Replaces what's in a field, typed in as a person would (so the page sees input).
  async fill(ref: number, text: string) {
    const ok = await this.evaluate<boolean>(
      `(() => { const e = document.querySelector('[data-eaa-ref="${ref}"]'); if (!e) return false; e.scrollIntoView({ block: 'center' }); e.focus();
        if (typeof e.select === 'function') e.select();
        else { const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
        return true; })()`,
    );
    if (!ok) await this.point(ref); // says it's gone
    if (text) await this.send('Input.insertText', { text });
    else for (const type of ['keyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
  }

  async pressEnter() {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }

  // A dropdown's options, or null when it isn't one.
  options(ref: number) {
    return this.evaluate<string[] | null>(
      `(() => { const e = document.querySelector('[data-eaa-ref="${ref}"]'); return e instanceof HTMLSelectElement ? [...e.options].map(o => o.text.replace(/\\s+/g, ' ').trim()) : null; })()`,
    );
  }

  async select(ref: number, index: number) {
    await this.evaluate(
      `(() => { const e = document.querySelector('[data-eaa-ref="${ref}"]'); e.selectedIndex = ${index}; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
  }

  async wheel(deltaY: number) {
    const size = await this.evaluate<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })');
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: size.w / 2, y: size.h / 2, deltaX: 0, deltaY });
  }
}
