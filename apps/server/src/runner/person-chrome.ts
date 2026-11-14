import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { platform } from 'node:os';
import { join } from 'node:path';
import { getSecret, setSecret } from '../vault.js';

// The person's own Chrome (apps/person-chrome), for a check the agents' browser
// fails — Cloudflare's Turnstile most of all. show_person copies the filled-in
// page here; the extension opens it in their Chrome, they pass the check and
// press Submit, and the sign-in cookies come back to the agents' profile.
//
// Phase A is that handoff. Phase B (not built) drives the same tab — click, type,
// read — through the extension's own script, never Chrome's debugger: attaching
// a debugger is what makes these checks fail.
//
// The copy is held in the vault, on this computer, until they finish or it
// expires. It is not written to the kept-pages file. Field values and cookies
// are never logged.

export const PERSON_CHROME_EXTENSION_ID = 'cakbmeciolclkddbahjokaoependhhlp';
const VAULT_ID = 'person-chrome';
const MAX_HANDOFFS = 20;
const MAX_AGE_MS = 7 * 24 * 3_600_000;
const MAX_BODY = 2_000_000;

export type PersonField = {
  tag: 'INPUT' | 'TEXTAREA' | 'SELECT';
  type: string;
  name: string;
  id: string;
  value: string;
  checked: boolean;
  placeholder: string;
  autocomplete: string;
  label: string;
};
export type PersonCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
  expires?: number;
};
export type PersonFile = { name: string; fileName: string };
export type PersonHandoff = {
  v: 1;
  id: string;
  created: number;
  requestId: number | null;
  profile: number;
  site: string;
  url: string;
  title: string;
  what: string;
  fields: PersonField[];
  files: PersonFile[];
  storage: { local: Record<string, string>; session: Record<string, string> };
  cookies: PersonCookie[];
  // Copied from an agency hosted elsewhere (the cloud), through the app on this
  // computer: finished here, it waits for the app to send it back (app routes below).
  remote?: true;
};

export type RawField = {
  tag?: string;
  type?: string;
  name?: string;
  id?: string;
  value?: string;
  checked?: boolean;
  placeholder?: string;
  autocomplete?: string;
  label?: string;
  fileName?: string;
};
export type RawCookie = {
  name?: string;
  value?: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expires?: number;
  partitionKey?: unknown;
};
export type RawSnapshot = {
  title?: string;
  fields?: RawField[];
  files?: { name?: string; fileName?: string }[];
  storage?: { local?: Record<string, string>; session?: Record<string, string> };
  storageError?: string | null;
  cookies?: RawCookie[];
};

const CAPTCHA_NAME = /^(g-recaptcha-response|h-captcha-response|cf-turnstile-response)$/i;
const SKIP_TYPE = new Set(['hidden', 'submit', 'button', 'image', 'reset', 'file']);
const KEEP_TYPE = new Set(['text', 'email', 'password', 'tel', 'url', 'number', 'search', 'checkbox', 'radio', 'textarea', 'select', '']);

// What the page runs, in the page view's own world (cdp.ts). Hidden fields are
// left out here too: a fresh load in their Chrome gets its own CSRF token, and
// copying the old one would break Submit. Captcha tokens are never read.
export const SNAPSHOT_EXPR = `(() => {
  const skip = /^(g-recaptcha-response|h-captcha-response|cf-turnstile-response)$/i;
  const fields = [];
  const files = [];
  let storageError = null;
  const nodes = document.querySelectorAll('input, textarea, select');
  for (const el of nodes) {
    const tag = el.tagName;
    const type = (el.getAttribute('type') || (tag === 'TEXTAREA' ? 'textarea' : tag === 'SELECT' ? 'select' : 'text')).toLowerCase();
    const name = el.getAttribute('name') || '';
    const id = el.id || '';
    if (skip.test(name) || skip.test(id)) continue;
    if (type === 'file') {
      let fileName = '';
      try { fileName = el.files && el.files[0] ? el.files[0].name : ''; } catch (e) { storageError = storageError || String(e).slice(0, 200); }
      files.push({ name, fileName });
      continue;
    }
    let label = '';
    try {
      const labelled = id && window.CSS && CSS.escape ? document.querySelector('label[for="' + CSS.escape(id) + '"]') : null;
      const wrap = el.closest ? el.closest('label') : null;
      const node = labelled || wrap;
      if (node) label = (node.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
    } catch (e) { /* a label that can't be read doesn't drop the field */ }
    fields.push({
      tag, type, name, id,
      value: 'value' in el ? String(el.value ?? '').slice(0, 20000) : '',
      checked: !!el.checked,
      placeholder: (el.placeholder || '').slice(0, 200),
      autocomplete: el.getAttribute('autocomplete') || '',
      label,
    });
    if (fields.length >= 200) break;
  }
  const dump = (store) => {
    const out = {};
    try {
      for (let i = 0; i < store.length && i < 200; i++) {
        const k = store.key(i);
        if (!k || skip.test(k)) continue;
        const v = store.getItem(k);
        if (v == null || v.length > 8000) continue;
        out[k] = v;
      }
    } catch (e) { storageError = String(e).slice(0, 200); }
    return out;
  };
  let storage = { local: {}, session: {} };
  try { storage = { local: dump(localStorage), session: dump(sessionStorage) }; }
  catch (e) { storageError = String(e).slice(0, 200); }
  return { title: String(document.title || '').slice(0, 200), fields, files, storage, storageError };
})()`;

export function cookieMatchesSite(domain: string, site: string): boolean {
  const d = domain.replace(/^\./, '').toLowerCase();
  const s = site.toLowerCase();
  if (!d || !s) return false;
  return d === s || s.endsWith('.' + d) || d.endsWith('.' + s);
}

export function prepareCookie(c: RawCookie): PersonCookie | null {
  if (!c || typeof c.name !== 'string' || !c.name || typeof c.value !== 'string') return null;
  if (c.partitionKey) return null;
  if (c.name.length > 200 || c.value.length > 8192) return null;
  const sameSite = c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None' ? c.sameSite : 'Lax';
  const secure = !!c.secure;
  if (sameSite === 'None' && !secure) return null;
  const domain = typeof c.domain === 'string' ? c.domain : '';
  if (!domain) return null;
  const expires = typeof c.expires === 'number' && c.expires > 0 ? c.expires : undefined;
  return {
    name: c.name,
    value: c.value,
    domain,
    path: c.path || '/',
    secure,
    httpOnly: !!c.httpOnly,
    sameSite,
    ...(expires ? { expires } : {}),
  };
}

export function cookiesForSite(cookies: PersonCookie[], site: string): PersonCookie[] {
  return cookies.filter(c => cookieMatchesSite(c.domain, site));
}

export type PreparedSnapshot = {
  title: string;
  fields: PersonField[];
  files: PersonFile[];
  storage: { local: Record<string, string>; session: Record<string, string> };
  cookies: PersonCookie[];
  droppedStorage: number;
  droppedCookies: number;
  storageError: string | null;
};

// The gate between the page and the vault: captcha tokens, hidden fields, empty
// boxes and other sites' cookies never get kept.
export function prepareSnapshot(raw: RawSnapshot, site: string): PreparedSnapshot {
  const fields: PersonField[] = [];
  const files: PersonFile[] = [];
  const takeFile = (name?: string, fileName?: string) => {
    if (!name && !fileName) return;
    files.push({ name: name || '', fileName: fileName || '' });
  };
  for (const f of raw.files ?? []) takeFile(f.name, f.fileName);
  for (const f of raw.fields ?? []) {
    const type = (f.type || '').toLowerCase();
    const name = f.name || '';
    if (CAPTCHA_NAME.test(name) || CAPTCHA_NAME.test(f.id || '')) continue;
    if (type === 'file') {
      takeFile(name, f.fileName);
      continue;
    }
    if (SKIP_TYPE.has(type)) continue;
    const tag = f.tag === 'TEXTAREA' || f.tag === 'SELECT' ? f.tag : 'INPUT';
    const norm = tag === 'TEXTAREA' ? 'textarea' : tag === 'SELECT' ? 'select' : type || 'text';
    if (tag === 'INPUT' && !KEEP_TYPE.has(norm)) continue;
    const value = String(f.value ?? '').slice(0, 20_000);
    const checked = !!f.checked;
    if ((norm === 'checkbox' || norm === 'radio') ? !checked : !value.trim()) continue;
    fields.push({
      tag,
      type: norm,
      name,
      id: f.id || '',
      value,
      checked,
      placeholder: (f.placeholder || '').slice(0, 200),
      autocomplete: f.autocomplete || '',
      label: (f.label || '').slice(0, 120),
    });
    if (fields.length >= 200) break;
  }
  const storage: PreparedSnapshot['storage'] = { local: {}, session: {} };
  let droppedStorage = 0;
  for (const which of ['local', 'session'] as const) {
    const src = raw.storage?.[which] ?? {};
    let used = 0;
    for (const [k, v] of Object.entries(src)) {
      if (!k || CAPTCHA_NAME.test(k) || typeof v !== 'string' || v.length > 8000) {
        droppedStorage++;
        continue;
      }
      if (used + k.length + v.length > 64_000) {
        droppedStorage++;
        continue;
      }
      storage[which][k] = v;
      used += k.length + v.length;
    }
  }
  const cookies: PersonCookie[] = [];
  let droppedCookies = 0;
  for (const c of raw.cookies ?? []) {
    const mapped = prepareCookie(c);
    if (!mapped || !cookieMatchesSite(mapped.domain, site)) {
      droppedCookies++;
      continue;
    }
    cookies.push(mapped);
  }
  return {
    title: String(raw.title ?? '').slice(0, 200),
    fields,
    files,
    storage,
    cookies,
    droppedStorage,
    droppedCookies,
    storageError: raw.storageError ? String(raw.storageError).slice(0, 200) : null,
  };
}

// Chrome or Edge, not whatever window the app is open in: the extension only runs there.
function browserExe(kind: PersonBrowser): string | null {
  if (platform() !== 'win32') return null;
  const local = process.env.LOCALAPPDATA;
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const candidates =
    kind === 'edge'
      ? [local && join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
      : [local && join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'), join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')];
  return candidates.filter((p): p is string => !!p).find(p => existsSync(p)) ?? null;
}
const browserTitle = (kind: PersonBrowser) => (kind === 'edge' ? 'Microsoft Edge' : 'Google Chrome');
// Tests swap this for one that opens nothing.
let opener = (kind: PersonBrowser, url: string) => openPersonBrowser(kind, url);
export const setPersonBrowserOpener = (fn: typeof opener) => void (opener = fn);
export function openPersonBrowser(kind: PersonBrowser, url: string) {
  const bin = browserExe(kind);
  const name = browserTitle(kind);
  if (platform() === 'win32' && !bin) {
    console.error(`[person-chrome] ${name} was not found`);
    throw new Error(`${name} was not found. Install it, then press this again.`);
  }
  const child =
    bin != null
      ? spawn(bin, [url], { detached: true, stdio: 'ignore' })
      : platform() === 'darwin'
        ? spawn('open', ['-a', name, url], { detached: true, stdio: 'ignore' })
        : spawn(kind === 'edge' ? 'microsoft-edge' : 'google-chrome', [url], { detached: true, stdio: 'ignore' });
  child.on('error', e => console.error(`[person-chrome] could not open ${name}:`, e.message));
  child.unref();
  console.log(`[person-chrome] opening ${name} at`, url);
}
async function connectedBrowser(): Promise<PersonBrowser> {
  const s = (await getSecret<Store>(VAULT_ID)) ?? { handoffs: [] };
  return s.browser === 'edge' ? 'edge' : 'chrome';
}
export async function openPersonChromePage(id: string) {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('That page is not waiting.');
  openPersonBrowser(await connectedBrowser(), chromeGoUrl(id));
}
export function openPersonChromeConnect(kind: PersonBrowser = 'chrome') {
  const q = kind === 'edge' ? '?browser=edge' : '';
  openPersonBrowser(kind, connectUrl() + q);
}

export const personChromePort = () => Number(process.env.PORT ?? 5175);
export const chromeGoUrl = (id: string) => `http://127.0.0.1:${personChromePort()}/person-chrome/go?id=${encodeURIComponent(id)}`;
export const chromeLine = (id: string) => `Open in your browser: ${chromeGoUrl(id)}`;
export const connectUrl = () => `http://127.0.0.1:${personChromePort()}/person-chrome/connect`;

export function personChromeEvidence(id: string, browserLine: string) {
  return [
    chromeLine(id),
    browserLine,
    "The form is already filled in, including what the agent saved on this page. Finish in your browser: pass the check and press Submit. Your own login on that site is set aside until that tab closes, then put back. The agents' browser tab is there too. Then close the tab (or press Done).",
  ].join('\n');
}

// --- Held copies ----------------------------------------------------------------------

export type PersonBrowser = 'chrome' | 'edge';
type Finished = { id: string; cookies: PersonCookie[]; at: number };
type Store = { token?: string; seenAt?: number; browser?: PersonBrowser; handoffs: PersonHandoff[]; finished?: Finished[] };

let chain: Promise<void> = Promise.resolve();
function update<T>(fn: (s: Store) => T | Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const s = (await getSecret<Store>(VAULT_ID)) ?? { handoffs: [] };
    if (!Array.isArray(s.handoffs)) s.handoffs = [];
    const out = await fn(s);
    await setSecret(VAULT_ID, s);
    return out;
  });
  chain = run.then(
    () => undefined,
    e => console.error('[person-chrome] store write failed:', e instanceof Error ? e.message : String(e)),
  );
  return run;
}

function expire(s: Store, now = Date.now()) {
  const keep = s.handoffs.filter(h => now - h.created < MAX_AGE_MS);
  const dropped = s.handoffs.length - keep.length;
  if (dropped) console.error(`[person-chrome] expired ${dropped} handoff${dropped === 1 ? '' : 's'}`);
  s.handoffs = keep;
}

export function queueHandoff(input: Omit<PersonHandoff, 'v' | 'id' | 'created'>): Promise<PersonHandoff> {
  const h: PersonHandoff = { v: 1, id: randomBytes(16).toString('hex'), created: Date.now(), ...input };
  return update(s => {
    expire(s);
    s.handoffs.push(h);
    const overflow = s.handoffs.length - MAX_HANDOFFS;
    if (overflow > 0) {
      const gone = s.handoffs.splice(0, overflow);
      console.error('[person-chrome] dropped old handoffs:', gone.map(g => `${g.id} (${g.site})`).join(', '));
    }
    console.log(`[person-chrome] queued ${h.id} site=${h.site} profile=${h.profile} request=${h.requestId ?? '-'} fields=${h.fields.length} cookies=${h.cookies.length} files=${h.files.length}`);
    return h;
  });
}

export function dropHandoff(id: string) {
  return update(s => {
    const before = s.handoffs.length;
    s.handoffs = s.handoffs.filter(h => h.id !== id);
    console.log(`[person-chrome] dropped ${id} removed=${before - s.handoffs.length}`);
  });
}

export async function personChromeStatus() {
  const s = (await getSecret<Store>(VAULT_ID)) ?? { handoffs: [] };
  const now = Date.now();
  const pending = (s.handoffs ?? []).filter(h => now - h.created < MAX_AGE_MS).length;
  return {
    port: personChromePort(),
    connectUrl: connectUrl(),
    extensionId: PERSON_CHROME_EXTENSION_ID,
    pending,
    connected: typeof s.seenAt === 'number',
    browser: s.browser === 'edge' ? 'edge' : typeof s.seenAt === 'number' ? 'chrome' : null,
  };
}

export function ensurePersonChromeToken() {
  return update(s => {
    if (!s.token) {
      s.token = randomBytes(32).toString('hex');
      console.log('[person-chrome] pairing token created');
    }
    return s.token;
  });
}

export function resetPersonChromeToken() {
  return update(s => {
    s.token = randomBytes(32).toString('hex');
    delete s.seenAt;
    delete s.browser;
    console.log('[person-chrome] pairing token reset; Chrome or Edge has to be connected again');
  });
}

function normalizeIncoming(c: unknown): PersonCookie | null {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  return prepareCookie({
    name: typeof o.name === 'string' ? o.name : '',
    value: typeof o.value === 'string' ? o.value : '',
    domain: typeof o.domain === 'string' ? o.domain : '',
    path: typeof o.path === 'string' ? o.path : '/',
    secure: o.secure === true,
    httpOnly: o.httpOnly === true,
    sameSite: typeof o.sameSite === 'string' ? o.sameSite : 'Lax',
    expires: typeof o.expires === 'number' ? o.expires : undefined,
  });
}

export function restoreHandoff(h: PersonHandoff) {
  return update(s => {
    if (s.handoffs.some(x => x.id === h.id)) return;
    s.handoffs.push(h);
    console.error(`[person-chrome] put ${h.id} back; the finish did not land`);
  });
}

export function completeHandoff(id: string, cookies: unknown): Promise<{ handoff: PersonHandoff; cookies: PersonCookie[] } | null> {
  return update(s => {
    expire(s);
    const h = s.handoffs.find(x => x.id === id);
    if (!h) return null;
    s.handoffs = s.handoffs.filter(x => x.id !== id);
    const list = cookiesForSite((Array.isArray(cookies) ? cookies : []).map(normalizeIncoming).filter((c): c is PersonCookie => !!c), h.site);
    console.log(`[person-chrome] done ${id} site=${h.site} cookies=${list.length}`);
    return { handoff: h, cookies: list };
  });
}

export async function noteAbandoned(id: string) {
  const s = (await getSecret<Store>(VAULT_ID)) ?? { handoffs: [] };
  const h = (s.handoffs ?? []).find(x => x.id === id);
  if (!h) console.error('[person-chrome] abandon for an unknown handoff', id);
  else console.log(`[person-chrome] tab closed before submit ${id} site=${h.site}`);
}

export function markExtensionSeen(browser: PersonBrowser) {
  return update(s => {
    if (!s.seenAt || Date.now() - s.seenAt > 3_600_000 || s.browser !== browser) console.log(`[person-chrome] ${browser} connected`);
    s.seenAt = Date.now();
    s.browser = browser;
  });
}

// The page was submitted in the person's browser: the agents' profile gets the sign-in
// and the request is answered. Copied from the cloud, it's held here instead, for the
// app to send back (it's the app that can reach the agency).
async function finish(id: string, cookies: unknown): Promise<boolean> {
  const result = await completeHandoff(id, cookies);
  if (!result) return false;
  if (result.handoff.remote) {
    await update(s => {
      s.finished = [...(s.finished ?? []).filter(f => f.id !== id), { id, cookies: result.cookies, at: Date.now() }];
    });
    console.log(`[person-chrome] ${id} finished here; waiting for the app to send it to the agency`);
    return true;
  }
  try {
    await onDone(result.handoff, result.cookies);
  } catch (e) {
    console.error('[person-chrome] the agency could not take the finished page:', e instanceof Error ? e.message : String(e));
    await restoreHandoff(result.handoff).catch(err => console.error('[person-chrome] could not put the page back:', err instanceof Error ? err.message : String(err)));
    throw e;
  }
  return true;
}

// The agency's half when it is hosted elsewhere: the app on the person's computer
// sends back what their browser finished (POST /api/person-chrome/finish).
export async function finishFromApp(id: string, cookies: unknown) {
  if (!ID_RE.test(id)) throw new Error('Unknown page.');
  if (!(await finish(id, cookies))) throw new Error('That page is no longer waiting.');
}

// A copy made for the person's browser now, on the agency's computer. Replaces an
// earlier copy for the same request, so a second press doesn't leave two behind.
export async function queueFreshHandoff(input: Omit<PersonHandoff, 'v' | 'id' | 'created'>) {
  if (input.requestId != null) {
    await update(s => {
      s.handoffs = s.handoffs.filter(h => h.requestId !== input.requestId);
    });
  }
  return queueHandoff(input);
}

// A copy that came from the agency through the app: checked like anything else from
// outside, then held here for the extension, marked to go back the same way.
function takeIncoming(raw: unknown): PersonHandoff {
  const h = (raw && typeof raw === 'object' ? raw : {}) as Partial<PersonHandoff>;
  if (typeof h.id !== 'string' || !ID_RE.test(h.id)) throw new Error('That page is not a copy from the agency.');
  let url: URL;
  try {
    url = new URL(String(h.url));
  } catch {
    throw new Error('That page has no web address.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('That page has no web address.');
  const site = String(h.site ?? '').toLowerCase();
  if (!site || !cookieMatchesSite(url.hostname, site)) throw new Error("That page's address doesn't match its site.");
  const arr = <T>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);
  return {
    v: 1,
    id: h.id,
    created: Date.now(),
    requestId: typeof h.requestId === 'number' ? h.requestId : null,
    profile: typeof h.profile === 'number' ? h.profile : 1,
    site,
    url: url.toString(),
    title: String(h.title ?? '').slice(0, 300),
    what: String(h.what ?? '').slice(0, 300),
    fields: arr<PersonField>(h.fields).slice(0, 500),
    files: arr<PersonFile>(h.files).slice(0, 50),
    storage: {
      local: h.storage && typeof h.storage.local === 'object' ? h.storage.local : {},
      session: h.storage && typeof h.storage.session === 'object' ? h.storage.session : {},
    },
    cookies: cookiesForSite(arr<unknown>(h.cookies).map(normalizeIncoming).filter((c): c is PersonCookie => !!c), site),
    remote: true,
  };
}

async function readHandoff(id: string): Promise<PersonHandoff | null> {
  return update(s => {
    expire(s);
    return s.handoffs.find(h => h.id === id) ?? null;
  });
}

// The agents' browser applies the cookies and answers the request. Registered
// from browser.ts so this file doesn't depend on it.
let onDone: (h: PersonHandoff, cookies: PersonCookie[]) => Promise<void> = async () => {
  console.error('[person-chrome] a handoff finished before the browser was ready to take it');
};
export const onPersonChromeDone = (fn: typeof onDone) => void (onDone = fn);

// --- The extension's requests, and the two pages it watches ---------------------------

const fromHere = (req: IncomingMessage) => /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress ?? '');

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function page(res: ServerResponse, body: string) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
    n += b.length;
    if (n > MAX_BODY) throw new Error('That upload is too large.');
    chunks.push(b);
  }
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Not JSON.');
    return v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof Error && e.message === 'That upload is too large.') throw e;
    throw new Error('Not JSON.');
  }
}

async function authorized(req: IncomingMessage): Promise<boolean> {
  const s = (await getSecret<Store>(VAULT_ID)) ?? { handoffs: [] };
  if (!s.token) return false;
  const got = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${s.token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

const shell = (kind: 'connect' | 'go', extra: string, heading: string, copy: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${heading}</title>
<meta id="eaa-chrome" data-kind="${kind}" ${extra}>
<style>
  body { margin: 0; font: 15px/1.45 system-ui, sans-serif; background: #16161a; color: #f4f4f5; }
  main { max-width: 28rem; margin: 0 auto; padding: 2.5rem 1.25rem; }
  h1 { font-size: 1.15rem; font-weight: 650; margin: 0 0 .6rem; }
  p { margin: 0 0 .8rem; color: #c4c4cc; }
  ol { margin: 0; padding-left: 1.2rem; color: #c4c4cc; }
  li { margin: .35rem 0; }
  code { font-size: .9em; }
  #status { color: #fff; }
</style></head>
<body><main>
  <h1>${heading}</h1>
  <p id="status">${copy}</p>
  <div id="install">
    <p>If this doesn't change, the extension isn't installed in this browser yet.</p>
    <ol>
      <li>Install <b>EXTREMELY</b> from the Chrome Web Store, or load the <code>apps/person-chrome</code> folder unpacked (Developer mode, Load unpacked) at <code>chrome://extensions</code> or <code>edge://extensions</code>.</li>
      <li>Come back to this page.</li>
    </ol>
  </div>
</main></body></html>`;

const ID_RE = /^[a-f0-9]{32}$/;

// True when this request was for the extension. Anything else falls through.
export async function handlePersonChromeHttp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const ext = path.startsWith('/api/person-chrome/ext');
  const app = path.startsWith('/api/person-chrome/app/');
  const ui = path === '/person-chrome/go' || path === '/person-chrome/connect';
  if (!ext && !ui && !app) return false;
  try {
    if (!fromHere(req)) {
      console.error('[person-chrome] refused a request that was not from this computer', path);
      send(res, 403, { error: 'Only on this computer.' });
      return true;
    }
    // The app on this computer, for an agency hosted elsewhere. Its own header: a web
    // page can't send one to this address without asking first, and nothing here says yes.
    if (app) {
      if (req.headers['x-eaa-app'] !== '1') {
        console.error('[person-chrome] app route without the app header', path);
        send(res, 403, { error: 'Only the app.' });
        return true;
      }
      if (path === '/api/person-chrome/app/stage' && req.method === 'POST') {
        const h = takeIncoming((await readJson(req)).handoff);
        await update(s => {
          expire(s);
          s.handoffs = [...s.handoffs.filter(x => x.id !== h.id && (h.requestId == null || x.requestId !== h.requestId)), h].slice(-MAX_HANDOFFS);
        });
        console.log(`[person-chrome] staged ${h.id} from the agency site=${h.site} request=${h.requestId ?? '-'} fields=${h.fields.length} cookies=${h.cookies.length}`);
        opener(await connectedBrowser(), chromeGoUrl(h.id));
        send(res, 200, { ok: true });
        return true;
      }
      if (path === '/api/person-chrome/app/finished' && req.method === 'GET') {
        const s = (await getSecret<Store>(VAULT_ID)) ?? { handoffs: [] };
        send(res, 200, { finished: s.finished ?? [] });
        return true;
      }
      if (path === '/api/person-chrome/app/finished/ack' && req.method === 'POST') {
        const id = String((await readJson(req)).id ?? '');
        await update(s => {
          s.finished = (s.finished ?? []).filter(f => f.id !== id && Date.now() - f.at < MAX_AGE_MS);
        });
        console.log(`[person-chrome] ${id} sent back to the agency`);
        send(res, 200, { ok: true });
        return true;
      }
      send(res, 404, { error: 'Not found' });
      return true;
    }
    if (path === '/person-chrome/connect' && req.method === 'GET') {
      const token = await ensurePersonChromeToken();
      const edge = url.searchParams.get('browser') === 'edge';
      const name = edge ? 'Edge' : 'Chrome';
      page(res, shell('connect', `data-token="${esc(token)}"`, `Connect this ${name}`, `Connecting this ${name} to EXTREMELY…`));
      return true;
    }
    if (path === '/person-chrome/go' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      if (!ID_RE.test(id)) {
        console.error('[person-chrome] go page with a bad id');
        send(res, 400, { error: 'That link is not a page waiting on you.' });
        return true;
      }
      page(res, shell('go', `data-id="${esc(id)}"`, 'Finish in your browser', 'Opening the filled-in page…'));
      return true;
    }
    if (!ext) {
      send(res, 404, { error: 'Not found' });
      return true;
    }
    if (!(await authorized(req))) {
      console.error('[person-chrome] extension request refused', path);
      send(res, 401, { error: "This browser isn't connected to this agency. Connect Chrome or Edge from Settings." });
      return true;
    }
    if (path === '/api/person-chrome/ext/hello' && req.method === 'POST') {
      const body = await readJson(req);
      await markExtensionSeen(body.browser === 'edge' ? 'edge' : 'chrome');
      send(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/person-chrome/ext/job' && req.method === 'GET') {
      const id = url.searchParams.get('id') ?? '';
      if (!ID_RE.test(id)) {
        send(res, 400, { error: 'Unknown page.' });
        return true;
      }
      const h = await readHandoff(id);
      if (!h) {
        console.error('[person-chrome] extension asked for a page that is not waiting', id);
        send(res, 404, { error: 'That page is no longer waiting. Ask the agent to keep it again.' });
        return true;
      }
      console.log(`[person-chrome] extension took ${id} site=${h.site} fields=${h.fields.length}`);
      send(res, 200, { handoff: h });
      return true;
    }
    if (path === '/api/person-chrome/ext/done' && req.method === 'POST') {
      const body = await readJson(req);
      const id = String(body.id ?? '');
      if (!ID_RE.test(id)) {
        send(res, 400, { error: 'Unknown page.' });
        return true;
      }
      if (!(await finish(id, body.cookies))) {
        console.error('[person-chrome] done for a page that is not waiting', id);
        send(res, 404, { error: 'That page is no longer waiting.' });
        return true;
      }
      send(res, 200, { ok: true });
      return true;
    }
    if (path === '/api/person-chrome/ext/abandon' && req.method === 'POST') {
      const body = await readJson(req);
      const id = String(body.id ?? '');
      if (!ID_RE.test(id)) {
        send(res, 400, { error: 'Unknown page.' });
        return true;
      }
      await noteAbandoned(id);
      send(res, 200, { ok: true });
      return true;
    }
    send(res, 404, { error: 'Not found' });
    return true;
  } catch (e) {
    const message = e instanceof Error && e.message && e.message.length < 300 ? e.message : 'Something went wrong.';
    console.error('[person-chrome]', message);
    if (!res.headersSent) send(res, 400, { error: message });
    return true;
  }
}
