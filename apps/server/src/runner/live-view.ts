import { readMeta } from '../files.js';
import type { PersonInput } from './cdp.js';
import { all } from './db.js';
import { finishKeptPage, heldSince, hold, liveTabs, openPersonTab, pairedBrowsers, release, type LiveTab } from './browser.js';

// The agents' tabs, live in the app: every agent's tab in the person's browsers, small
// and about once a second; the one the person watches as it changes; and that one
// taken over - their mouse, keys, pasted text and scrolling go to it, and its agent
// waits on it until it's handed back. Frames come through the extension's relay
// (Page.startScreencast over chrome.debugger), the same wherever the agency runs:
// these are ordinary requests to the agency, so from elsewhere they go through the
// end-to-end encrypted relay like the rest.
//
// A tab kept for the person isn't here: it's a normal tab in their browser, with the
// debugger off it, and the request's button brings it up there.
//
// Frames are pulled, not pushed: the app asks for the next one after the one it has,
// and a page is only streamed while somebody keeps asking.

const THUMB_MS = 1000;
const WATCH_IDLE_MS = 5000;
const FRAME_WAIT_MS = 2500;

type Frame = { data: string; width: number; height: number };
type Source = {
  id: string;
  kind: 'agent';
  browser: number;
  agent: { id: string; name: string } | null;
  request: number | null;
  since: number;
  held: number | null;
  url: () => Promise<string>;
  title: () => Promise<string>;
  thumb: () => Promise<string | null>;
  stream: (onFrame: (f: Frame) => void) => Promise<() => Promise<void>>;
  input: (e: PersonInput) => Promise<void>;
  page?: LiveTab['page'];
};

// --- Every tab there is to watch ---
// A thumbnail is drawn inside the page: a hung one gets none rather than holding the list.
const THUMB_WAIT_MS = 2500;
const soon = <T>(p: Promise<T>, ms: number, otherwise: T): Promise<T> =>
  Promise.race([p.catch(() => otherwise), new Promise<T>(r => setTimeout(() => r(otherwise), ms).unref())]);
async function sources(): Promise<Source[]> {
  return liveTabs().map(t => ({
    id: t.id,
    kind: 'agent',
    browser: t.browser,
    agent: t.agent,
    request: t.request ?? null,
    since: t.since,
    held: heldSince(t.id),
    // From the browser, not the page: one hung page (it happens - a run-away script on a
    // sign-up form) held the whole list for a minute, so the screen never loaded.
    url: () => t.page.info().then(i => i.url, () => ''),
    title: () => t.page.info().then(i => i.title, () => ''),
    thumb: () => soon(t.page.thumbnail(), THUMB_WAIT_MS, null),
    stream: async onFrame => {
      const stop = await t.page.screencast(onFrame);
      // A page that isn't changing sends no frames: how it looks now, to start.
      const data = await t.page.thumbnail(1, 60).catch(() => null);
      const size = await t.page.evaluate<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })').catch(() => ({ w: 1280, h: 900 }));
      if (data) onFrame({ data, width: size.w, height: size.h });
      return stop;
    },
    input: e => t.page.input(e),
    page: t.page,
  }));
}
const sourceOf = async (id: unknown) => {
  const s = (await sources()).find(x => x.id === id);
  if (!s) throw new Error('That page has closed.');
  return s;
};

// --- Thumbnails: every page, about once a second while the page list is open ---
const thumbs = new Map<string, { at: number; data: string | null }>();
async function thumb(s: Source) {
  const had = thumbs.get(s.id);
  if (had && Date.now() - had.at < THUMB_MS) return had.data;
  const latest = watching.get(s.id)?.frame?.data;
  const data = latest ?? (await Promise.race([s.thumb(), new Promise<null>(r => setTimeout(() => r(null), 1500))]));
  thumbs.set(s.id, { at: Date.now(), data: data ?? had?.data ?? null });
  return data ?? had?.data ?? null;
}

// --- What waits on the person: open requests with an "Open in signed-in browser" line ---
const BROWSER_LINE = /^\s*Open in signed-in browser:\s*(https?:\/\/[^\s<>"']+?)[.,]?(?:\s*\((?:profile|browser)\s*(\d+)\))?\.?\s*$/im;
const siteOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};
async function needs() {
  const open = all<{ id: number; agent_id: string; what: string; why: string; evidence: string | null; created_at: number }>(
    "SELECT id, agent_id, what, why, evidence, created_at FROM requests WHERE status = 'open' ORDER BY created_at",
  );
  const said = all<{ request_id: number; text: string }>("SELECT request_id, text FROM request_messages WHERE request_id IN (SELECT id FROM requests WHERE status = 'open') ORDER BY id DESC");
  const out = [];
  for (const r of open) {
    const texts = [...said.filter(m => m.request_id === r.id).map(m => m.text), r.what, r.why, r.evidence ?? ''];
    const m = texts.map(t => BROWSER_LINE.exec(t)).find(Boolean);
    if (!m) continue;
    out.push({ request: r.id, agent: { id: r.agent_id, name: (await readMeta(r.agent_id))?.name ?? r.agent_id }, what: r.what, url: m[1], site: siteOf(m[1]), profile: Number(m[2] ?? 1), since: r.created_at });
  }
  return out;
}

// profile: the browser's number (the field kept its old name for the app).
export async function liveState(withThumbs: boolean) {
  const all = await sources();
  for (const id of thumbs.keys()) if (!all.some(s => s.id === id)) thumbs.delete(id);
  return {
    profiles: pairedBrowsers().filter(b => b.online).map(b => b.n),
    needs: await needs(),
    tabs: await Promise.all(
      all.map(async s => ({
        id: s.id,
        kind: s.kind,
        profile: s.browser,
        agent: s.agent,
        request: s.request,
        since: s.since,
        held: s.held,
        url: await s.url(),
        title: await s.title(),
        thumb: withThumbs ? await thumb(s) : null,
      })),
    ),
  };
}

// --- The page being watched: streamed while asked for, the latest frame kept ---
type Watch = { seq: number; frame: Frame | null; asked: number; stop: (() => Promise<void>) | null; waiters: Set<() => void> };
const watching = new Map<string, Watch>();
setInterval(async () => {
  const ids = new Set((await sources()).map(s => s.id));
  for (const [id, w] of watching)
    if (Date.now() - w.asked > WATCH_IDLE_MS || !ids.has(id)) {
      watching.delete(id);
      void w.stop?.();
    }
}, 1000).unref();

export async function frame(id: string, after: number) {
  const s = await sourceOf(id);
  let w = watching.get(id);
  if (!w) {
    const fresh: Watch = { seq: 0, frame: null, asked: Date.now(), stop: null, waiters: new Set() };
    w = fresh;
    watching.set(id, fresh);
    fresh.stop = await s.stream(f => {
      fresh.frame = f;
      fresh.seq++;
      for (const wake of fresh.waiters) wake();
      fresh.waiters.clear();
    });
  }
  w.asked = Date.now();
  if (w.seq <= after) {
    const watch = w;
    await new Promise<void>(r => {
      const timer = setTimeout(r, FRAME_WAIT_MS);
      watch.waiters.add(() => (clearTimeout(timer), r()));
    });
  }
  return { seq: w.seq, ...(w.seq > after && w.frame ? w.frame : { data: null, width: 0, height: 0 }), held: s.held };
}

// --- The person's input: only on a page they have ---
const INPUTS = new Set(['mouse', 'wheel', 'key', 'text']);
export async function input(id: string, events: unknown) {
  const s = await sourceOf(id);
  if (s.held == null) throw new Error('Take control of this page first: until then it’s the agent’s.');
  if (!Array.isArray(events)) throw new Error('events: a list.');
  for (const e of events.slice(0, 50) as PersonInput[]) {
    if (!e || !INPUTS.has(e.type)) continue;
    if (e.type === 'text' && (typeof e.text !== 'string' || e.text.length > 20_000)) continue;
    await s.input(e);
  }
  return { ok: true };
}

// take: the person has it, its agent waits. done: finished (a page kept for them closes,
// and the request it came from is answered). handback: back to its agent, unfinished.
export async function control(id: string, action: unknown) {
  await sourceOf(id);
  if (action === 'take') hold(id);
  else if (action === 'done' || action === 'handback') {
    release(id);
    if (action === 'done') await finishKeptPage(id);
  } else throw new Error('action: take, done or handback.');
  return { ok: true };
}

// "Open a page": a plain tab of the person's own in that browser, in front.
export async function openForPerson(browser: unknown, url: unknown) {
  await openPersonTab(browser, typeof url === 'string' && url ? url : 'https://www.google.com');
  return { tab: null };
}
