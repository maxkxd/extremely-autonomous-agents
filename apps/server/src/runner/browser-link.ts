import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { platform } from 'node:os';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { LOGO, PAGE_CSS, letters } from '../signin-page.js';
import { getSecret, setSecret } from '../vault.js';
import type { CdpConn } from './cdp.js';

// The link between this agency and the EXTREMELY extension in the person's own
// Chrome or Edge (docs/browser-extension.md). Each paired browser profile keeps one
// WebSocket open to /api/browser-link; over it the extension plays a DevTools
// browser, so the agents' tools (browser.ts) drive it through an ordinary CdpConn.
//
// Pairing hands the extension a token. Only its sha256 is kept, in the vault, so a
// copy of the vault can't be replayed as a browser. Tokens and pairing codes are
// never logged.

const PATH = '/api/browser-link';
const VAULT_ID = 'browser-link';
const PROTOCOL = 1;
// A call the extension never answers fails after this, like a DevTools browser's (cdp.ts).
const SEND_TIMEOUT_MS = 60_000;
// The extension pings every 20 s; a connection silent for this long is a laptop that
// slept or a network that dropped without a close, so it's ended instead of trusted.
const SILENT_MS = 70_000;
// EAA.downloadFile sends up to 50 MB as base64.
const MAX_FRAME = 80 * 1024 * 1024;
// No 0/O, 1/I/L: the person may type the code from one screen into another.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const MAX_OPEN_CODES = 20;

// Changeable by tests only (browser-link.test.ts).
let firstFrameMs = 10_000;
let codeTtlMs = 10 * 60_000;
export const _testing = {
  setFirstFrameMs: (ms: number) => void (firstFrameMs = ms),
  setCodeTtlMs: (ms: number) => void (codeTtlMs = ms),
  setOpener: (fn: (url: string) => void) => void (opener = fn),
};

export type LinkedBrowser = { n: number; name: string; kind: 'chrome' | 'edge'; online: boolean; since?: number; lastSeen?: number; version?: string };

type Kind = LinkedBrowser['kind'];
type Stored = { n: number; name: string; kind: Kind; version?: string; tokenHash: string; created: number; lastSeen?: number };
type Store = { v: 1; browsers: Stored[] };

const log = (...a: unknown[]) => console.log('[browser-link]', ...a);
const logError = (...a: unknown[]) => console.error('[browser-link]', ...a);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// --- The paired browsers, kept in the vault ---------------------------------------------

// Read once and held here: listBrowsers() is called on every page poll, and the vault
// is a file. Every change is written back through one chain, so two changes in the
// same moment can't overwrite each other.
let store: Store = { v: 1, browsers: [] };
const ready: Promise<void> = getSecret<Store>(VAULT_ID)
  .then(s => {
    if (s && Array.isArray(s.browsers)) store = { v: 1, browsers: s.browsers.filter(b => Number.isInteger(b?.n) && typeof b.tokenHash === 'string') };
  })
  .catch(e => logError('could not read the paired browsers; none until one pairs again:', errText(e)));

let writes: Promise<void> = Promise.resolve();
function persist(): Promise<void> {
  const run = writes.then(() => setSecret(VAULT_ID, store));
  writes = run.catch(e => logError('could not save the paired browsers:', errText(e)));
  return run;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// The browser this token belongs to. Every stored hash is compared in full, in
// constant time, so the answer's timing doesn't say how close a guess was.
function browserForToken(token: unknown): Stored | null {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const got = Buffer.from(sha256(token), 'hex');
  let found: Stored | null = null;
  for (const b of store.browsers) {
    const want = Buffer.from(b.tokenHash, 'hex');
    if (want.length === got.length && timingSafeEqual(want, got)) found = b;
  }
  return found;
}

// --- Pairing codes (memory only: one use, short-lived) ----------------------------------

const codes = new Map<string, number>(); // code -> expires at

function pruneCodes(now = Date.now()) {
  for (const [c, until] of codes) if (until <= now) codes.delete(c);
}

const normalizeCode = (c: unknown) => {
  const s = typeof c === 'string' ? c.toUpperCase().replace(/[^0-9A-Z]/g, '') : '';
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : '';
};

// Wrong codes since the last one was made. The link is reachable from the network
// (the local agency listens on every interface, a hosted one on the internet), and a
// guessed code would pair a fake "browser" that agents then type store passwords
// into. So a run of wrong guesses spends every open code: a guesser gets at most this
// many tries per Connect a browser, and the person just presses it again.
const MAX_WRONG_CODES = 10;
let wrongCodes = 0;

// One use: taking it deletes it, whether or not the pairing then works.
function takeCode(raw: unknown): 'ok' | 'expired' | 'unknown' {
  const code = normalizeCode(raw);
  const until = code ? codes.get(code) : undefined;
  if (until === undefined) {
    if (++wrongCodes >= MAX_WRONG_CODES && codes.size) {
      logError(`${wrongCodes} wrong pairing codes: every open code is cancelled`);
      codes.clear();
    }
    return 'unknown';
  }
  codes.delete(code);
  return until > Date.now() ? 'ok' : 'expired';
}

const linkPort = () => Number(process.env.PORT ?? 5175);

// An http(s) address, as the WebSocket address of this endpoint on the same host.
function wsAddress(base: string): string {
  let u: URL;
  try {
    u = new URL(base);
  } catch {
    throw new Error("That isn't a web address.");
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'ws:' && u.protocol !== 'wss:') throw new Error("That isn't a web address.");
  const scheme = u.protocol === 'https:' || u.protocol === 'wss:' ? 'wss:' : 'ws:';
  return `${scheme}//${u.host}${u.pathname.replace(/\/+$/, '')}${PATH}`;
}

// A new one-time code, and where the extension should take it (contract: Pairing).
export function pairCode(base?: string): { code: string; url: string; link: string } {
  pruneCodes();
  if (codes.size >= MAX_OPEN_CODES) {
    // Oldest first: Map keeps insertion order.
    const oldest = codes.keys().next().value;
    if (oldest) codes.delete(oldest);
  }
  let code = '';
  do {
    let s = '';
    for (let i = 0; i < 8; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    code = `${s.slice(0, 4)}-${s.slice(4)}`;
  } while (codes.has(code));
  codes.set(code, Date.now() + codeTtlMs);
  wrongCodes = 0;
  // Hosted on a server: its public address (Railway names it for us), so the person's
  // browser reaches it over wss from their own computer.
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const pub = process.env.EAA_PUBLIC_URL?.trim() || (railway ? `https://${railway}` : '');
  const url = pub ? wsAddress(pub) : base ? wsAddress(base) : `ws://127.0.0.1:${linkPort()}${PATH}`;
  const n = process.env.EAA_ORG_NAME?.trim() || 'EXTREMELY';
  const link = 'eaa1:' + Buffer.from(JSON.stringify({ u: url, c: code, n })).toString('base64url');
  log(`pairing code made for ${url} (${codes.size} open)`);
  return { code, url, link };
}

// --- The relay: one CdpConn per online browser -------------------------------------------

type Listener = (params: any, sessionId?: string) => void;

export class ExtensionCdp implements CdpConn {
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private closers = new Set<() => void>();
  closed = false;

  constructor(private ws: WebSocket) {}

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeout = SEND_TIMEOUT_MS): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser went offline.'));
    const id = ++this.seq;
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
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }), err => {
        if (err) this.settle(id, undefined, new Error(`The browser couldn't be sent ${method}: ${err.message}`));
      });
    });
  }

  on(method: string, fn: Listener): () => void {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(fn);
    return () => this.listeners.get(method)?.delete(fn);
  }

  onClose(fn: () => void) {
    if (this.closed) queueMicrotask(fn);
    else this.closers.add(fn);
  }

  close() {
    this.ws.close(1000);
  }

  // A frame from the extension after hello: a command's answer or an event.
  handle(msg: Record<string, unknown>) {
    if (typeof msg.id === 'number') {
      const e = msg.error as { message?: unknown; data?: unknown } | undefined;
      if (e) this.settle(msg.id, undefined, new Error(`${typeof e.message === 'string' ? e.message : 'The browser refused that.'}${e.data ? ` ${String(e.data)}` : ''}`));
      else this.settle(msg.id, msg.result ?? {});
      return;
    }
    if (typeof msg.method === 'string') {
      for (const fn of this.listeners.get(msg.method) ?? []) {
        try {
          fn(msg.params ?? {}, typeof msg.sessionId === 'string' ? msg.sessionId : undefined);
        } catch (err) {
          logError(`a listener for ${msg.method} failed:`, errText(err));
        }
      }
    }
  }

  private settle(id: number, result: unknown, error?: Error) {
    const p = this.pending.get(id);
    if (!p) return; // answered after its timeout: already reported to its caller
    this.pending.delete(id);
    if (error) p.reject(error);
    else p.resolve(result);
  }

  // The socket closed: every waiting call fails now rather than at its timeout.
  shut() {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(new Error('The browser went offline.'));
    this.pending.clear();
    for (const fn of this.closers) {
      try {
        fn();
      } catch (err) {
        logError('a close listener failed:', errText(err));
      }
    }
    this.closers.clear();
  }
}

type Live = { ws: WebSocket; conn: ExtensionCdp; since: number };
const live = new Map<number, Live>();
const lastSeen = new Map<number, number>();
const onlineFns = new Set<(n: number, conn: CdpConn) => void>();
const offlineFns = new Set<(n: number) => void>();

function fire<A extends unknown[]>(fns: Set<(...a: A) => void>, ...args: A) {
  for (const fn of fns) {
    try {
      fn(...args);
    } catch (err) {
      logError('a browser online/offline listener failed:', errText(err));
    }
  }
}

export function listBrowsers(): LinkedBrowser[] {
  return [...store.browsers]
    .sort((a, b) => a.n - b.n)
    .map(b => {
      const l = live.get(b.n);
      const seen = lastSeen.get(b.n) ?? b.lastSeen;
      return { n: b.n, name: b.name, kind: b.kind, online: !!l, ...(l ? { since: l.since } : {}), ...(seen ? { lastSeen: seen } : {}), ...(b.version ? { version: b.version } : {}) };
    });
}

export function browserConn(n: number): CdpConn | null {
  const l = live.get(n);
  return l && !l.conn.closed ? l.conn : null;
}

export function onBrowserOnline(fn: (n: number, conn: CdpConn) => void): () => void {
  onlineFns.add(fn);
  return () => onlineFns.delete(fn);
}

export function onBrowserOffline(fn: (n: number) => void): () => void {
  offlineFns.add(fn);
  return () => offlineFns.delete(fn);
}

export function renameBrowser(n: number, name: string): void {
  const b = store.browsers.find(x => x.n === n);
  if (!b) throw new Error('That browser isn\'t paired.');
  const clean = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!clean) throw new Error('A name, please.');
  b.name = clean;
  log(`browser ${n} renamed`);
  void persist().catch(() => {}); // persist() logs its own failure
}

// Revoked at once in memory, so the token stops working even before the vault is written.
export function removeBrowser(n: number): void {
  const before = store.browsers.length;
  store.browsers = store.browsers.filter(b => b.n !== n);
  if (store.browsers.length === before) throw new Error('That browser isn\'t paired.');
  lastSeen.delete(n);
  log(`browser ${n} removed`);
  const l = live.get(n);
  if (l) refuse(l.ws, 'This browser was removed from EXTREMELY. Pair it again to use it.');
  void persist().catch(() => {});
}

export const storeLinks = (): { chrome?: string; edge?: string } => ({
  ...(process.env.EAA_STORE_CHROME ? { chrome: process.env.EAA_STORE_CHROME } : {}),
  ...(process.env.EAA_STORE_EDGE ? { edge: process.env.EAA_STORE_EDGE } : {}),
});

// --- The WebSocket endpoint ---------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });

function refuse(ws: WebSocket, error: string) {
  try {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', error }));
  } catch (e) {
    logError('could not send the refusal:', errText(e));
  }
  ws.close(1008);
}

// True when this upgrade was for the link (answered or refused here); false leaves it
// to the caller.
export function handleBrowserLinkUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (path !== PATH) return false;
  // A web page can open a WebSocket to any address, the person's loopback included;
  // only the extension's own origin (or none, outside a browser) may talk to this.
  const origin = req.headers.origin;
  if (origin && !origin.startsWith('chrome-extension://')) {
    logError('refused a connection from a web page origin');
    socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\ncontent-length: 0\r\n\r\n');
    return true;
  }
  wss.handleUpgrade(req, socket, head, ws => accept(ws));
  return true;
}

function parse(data: RawData): Record<string, unknown> | null {
  try {
    const v = JSON.parse(Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const kindOf = (v: unknown): Kind => (v === 'edge' ? 'edge' : 'chrome');
const versionOf = (v: unknown) => (typeof v === 'string' ? v.slice(0, 40) : undefined);

function accept(ws: WebSocket) {
  let n: number | null = null; // set once hello or pair succeeds
  let conn: ExtensionCdp | null = null;
  let busy = false; // a pair or hello in progress: later frames wait for it
  let lastFrame = Date.now();

  const deadline = setTimeout(() => {
    if (n == null) {
      logError('closed a connection that sent no hello or pair in time');
      refuse(ws, 'No hello in time.');
    }
  }, firstFrameMs);
  deadline.unref?.();
  const watchdog = setInterval(() => {
    if (Date.now() - lastFrame > SILENT_MS) {
      logError(`browser ${n ?? '?'} went silent; closing its connection`);
      ws.terminate();
    }
  }, 15_000);
  watchdog.unref?.();

  // This connection becomes browser n's live one, replacing any older one.
  const goOnline = (b: Stored) => {
    n = b.n;
    conn = new ExtensionCdp(ws);
    const old = live.get(b.n);
    live.set(b.n, { ws, conn, since: Date.now() });
    lastSeen.set(b.n, Date.now());
    if (old) refuse(old.ws, 'This browser connected again; this older connection is closed.');
    log(`browser ${b.n} online (${b.kind}${b.version ? ` ${b.version}` : ''})${old ? ', replacing an older connection' : ''}`);
    fire(onlineFns, b.n, conn);
  };

  const first = async (msg: Record<string, unknown>) => {
    if (msg.protocol !== PROTOCOL) {
      logError(`refused protocol ${String(msg.protocol)}`);
      return refuse(ws, 'Update the EXTREMELY extension');
    }
    await ready;
    if (msg.type === 'hello') {
      const b = browserForToken(msg.token);
      if (!b) {
        logError('refused a hello with an unknown token');
        return refuse(ws, "This browser isn't paired with this agency any more. Pair it again.");
      }
      if (n != null && n !== b.n) return refuse(ws, 'That token is for another browser.');
      b.kind = kindOf(msg.browser);
      b.version = versionOf(msg.version) ?? b.version;
      b.lastSeen = Date.now();
      void persist().catch(() => {});
      if (n == null) goOnline(b);
      ws.send(JSON.stringify({ type: 'hello-ok', browser: b.n, name: b.name, protocol: PROTOCOL }));
      return;
    }
    if (msg.type === 'pair') {
      if (n != null) return refuse(ws, 'This connection is already paired.');
      const got = takeCode(msg.code);
      if (got !== 'ok') {
        logError(`refused a pairing: ${got} code`);
        return refuse(ws, got === 'expired' ? 'That code has expired. Press Connect a browser again for a new one.' : "That code isn't right, or was already used. Press Connect a browser again for a new one.");
      }
      const used = new Set(store.browsers.map(b => b.n));
      let next = 1;
      while (used.has(next)) next++;
      const kind = kindOf(msg.browser);
      const label = typeof msg.label === 'string' ? msg.label.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
      const token = randomBytes(32).toString('base64url');
      const b: Stored = { n: next, name: label || (kind === 'edge' ? 'Edge' : 'Chrome'), kind, version: versionOf(msg.version), tokenHash: sha256(token), created: Date.now(), lastSeen: Date.now() };
      store.browsers.push(b);
      try {
        await persist();
      } catch (e) {
        // Not saved means it wouldn't survive a restart: better to say so now.
        store.browsers = store.browsers.filter(x => x !== b);
        return refuse(ws, `The agency couldn't save this pairing: ${errText(e)}`);
      }
      log(`browser ${b.n} paired (${kind})`);
      ws.send(JSON.stringify({ type: 'paired', token, browser: b.n, name: b.name }));
      // The extension may carry on over this connection, or reconnect with hello.
      goOnline(b);
      return;
    }
    logError(`refused a first frame of type ${String(msg.type).slice(0, 30)}`);
    refuse(ws, 'Send hello or pair first.');
  };

  const queue: Record<string, unknown>[] = [];
  const drain = async () => {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && ws.readyState === ws.OPEN) {
        const msg = queue.shift()!;
        if (msg.type === 'ping') {
          if (n != null) lastSeen.set(n, Date.now());
          ws.send(JSON.stringify({ type: 'pong' }));
        } else if (msg.type === 'hello' || msg.type === 'pair' || n == null) {
          await first(msg);
        } else if (conn) {
          conn.handle(msg);
        }
      }
    } catch (e) {
      logError('a frame failed:', errText(e));
      refuse(ws, 'Something went wrong in the agency.');
    } finally {
      busy = false;
    }
  };

  ws.on('message', data => {
    lastFrame = Date.now();
    const msg = parse(data);
    if (!msg) {
      logError(`browser ${n ?? '?'} sent a frame that isn't JSON; ignored`);
      return;
    }
    queue.push(msg);
    void drain();
  });
  ws.on('error', e => logError(`browser ${n ?? '?'} connection error:`, e.message));
  ws.on('close', () => {
    clearTimeout(deadline);
    clearInterval(watchdog);
    const mine = conn;
    mine?.shut();
    if (n == null || live.get(n)?.conn !== mine) return; // never online, or replaced by a newer one
    live.delete(n);
    const b = store.browsers.find(x => x.n === n);
    if (b) {
      b.lastSeen = lastSeen.get(n) ?? Date.now();
      void persist().catch(() => {});
    }
    log(`browser ${n} offline`);
    fire(offlineFns, n);
  });
}

// --- Opening the connect page in the person's default browser (the local app only) -------

let opener = (url: string) => openDefaultBrowser(url);

function openDefaultBrowser(url: string) {
  // rundll32 rather than `cmd /c start`: no shell, so nothing in the address is parsed.
  const [cmd, args] = platform() === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : platform() === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' });
  child.on('error', e => logError('could not open the default browser:', e.message));
  child.unref();
}

export function openConnectPage(link: string) {
  if (typeof link !== 'string' || link.length > 4000 || !/^eaa1:[A-Za-z0-9_-]+$/.test(link)) throw new Error("That isn't a pairing link.");
  opener(`http://127.0.0.1:${linkPort()}/browser/connect#${link}`);
  log('opened the connect page in the default browser');
}

// --- The connect page --------------------------------------------------------------------

const fromHere = (req: IncomingMessage) => /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket.remoteAddress ?? '');
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// The extension's content script (on loopback only) reads the link from the address's
// hash and pairs, then sets body[data-eaa] to "paired" or "error:<message>" and posts
// {eaa: 'paired' | 'error', error?}. Any other data-eaa value means it's there and
// working. Nothing within 4 s: no extension in this browser.
function connectPage(): string {
  const links = storeLinks();
  const stores = [links.chrome && `<a href="${esc(links.chrome)}">Chrome Web Store</a>`, links.edge && `<a href="${esc(links.edge)}">Edge Add-ons</a>`].filter(Boolean);
  const install = stores.length
    ? `The EXTREMELY extension isn't installed in this browser. Get it from the ${stores.join(' or ')}, then press Connect a browser again.`
    : `Install the <a href="https://extremely.agency/extension">EXTREMELY extension</a>, then press Connect a browser again.`;
  const heading = 'Connecting';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${heading} · EXTREMELY</title>
<link rel="icon" type="image/png" href="${LOGO}">
<style>
${PAGE_CSS}
  .card { max-width: 30rem; }
  #install { margin-top: 20px; color: #a8a8a8; font-size: 14px; line-height: 1.5; }
  #install[hidden] { display: none; }
  #install a { color: inherit; }
</style></head>
<body><div class="card">
<img class="logo" src="${LOGO}" alt="">
<h1 id="h" class="wave">${letters(heading)}</h1>
<p id="status">Connecting this browser to EXTREMELY…</p>
<p id="install" hidden>${install}</p>
</div>
<script>
const letters = t => [...t].map((c, i) => '<span style="--i:' + i + '">' + (c === ' ' ? '&nbsp;' : c.replace(/[&<>"]/g, x => '&#' + x.charCodeAt(0) + ';')) + '</span>').join('');
const h = document.getElementById('h'), p = document.getElementById('status'), install = document.getElementById('install');
let settled = false, seen = false;
function settle(ok, text) {
  if (settled) return;
  settled = true;
  // The code is spent either way; keep it out of the address bar and history.
  history.replaceState(null, '', location.pathname);
  const word = ok ? 'Connected' : 'Not connected';
  document.title = word + ' · EXTREMELY';
  p.textContent = text;
  h.classList.add('swap');
  setTimeout(() => { h.className = ok ? 'float' : 'still'; h.innerHTML = letters(word); }, 300);
}
function check() {
  const v = document.body.dataset.eaa || '';
  if (!v) return;
  seen = true;
  if (v === 'paired') settle(true, 'This browser is connected. You can close this tab.');
  else if (v.startsWith('error:')) settle(false, v.slice(6) || "The extension couldn't connect.");
}
new MutationObserver(check).observe(document.body, { attributes: true, attributeFilter: ['data-eaa'] });
addEventListener('message', e => {
  if (e.source !== window || !e.data || typeof e.data !== 'object' || !e.data.eaa) return;
  seen = true;
  if (e.data.eaa === 'paired') settle(true, 'This browser is connected. You can close this tab.');
  else if (e.data.eaa === 'error') settle(false, String(e.data.error || "The extension couldn't connect."));
});
if (!location.hash.startsWith('#eaa1:')) settle(false, 'This page has no pairing code. Press Connect a browser again.');
check();
setTimeout(() => {
  if (seen || settled) return;
  settle(false, '');
  p.hidden = true;
  install.hidden = false;
}, 4000);
</script></body></html>`;
}

// True when this request was the connect page. Served before sign-in (index.ts), so
// only to this computer: it's the person's own browser opening it.
export function handleBrowserConnectPage(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (url.pathname !== '/browser/connect') return false;
  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Not allowed.' }));
    return true;
  }
  if (!fromHere(req)) {
    logError('refused the connect page to a request not from this computer');
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Only on this computer.' }));
    return true;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(connectPage());
  return true;
}
