import { readMeta } from '../files.js';
import type { PersonInput } from './cdp.js';
import { all } from './db.js';
import { closePersonTab, heldSince, hold, listProfiles, liveTabs, openPersonTab, release, type LiveTab } from './browser.js';

// The agents' browser, live in the app (the Agents' browser page): every agent's page
// in the profiles' browsers, small and about once a second; the one the person
// watches as it changes; and that one taken over - their mouse, keys, pasted text and
// scrolling go to it, and its agent waits on it until it's handed back. The same here
// and in the cloud: these are ordinary requests to the agency, so from elsewhere they
// go through the end-to-end encrypted relay like the rest.
//
// Frames are pulled, not pushed: the app asks for the next one after the one it has,
// and the page is only streamed while somebody keeps asking.

const THUMB_MS = 1000;
const WATCH_IDLE_MS = 5000;
const FRAME_WAIT_MS = 2500;

// --- Thumbnails: every page, about once a second while the page list is open ---
const thumbs = new Map<string, { at: number; data: string | null }>();
async function thumb(t: LiveTab) {
  const had = thumbs.get(t.id);
  if (had && Date.now() - had.at < THUMB_MS) return had.data;
  const data = await Promise.race([t.page.thumbnail().catch(() => null), new Promise<null>(r => setTimeout(() => r(null), 1500))]);
  thumbs.set(t.id, { at: Date.now(), data: data ?? had?.data ?? null });
  return data ?? had?.data ?? null;
}

// --- What waits on the person: open requests with an "Open in signed-in browser" line ---
const BROWSER_LINE = /^\s*Open in signed-in browser:\s*(https?:\/\/[^\s<>"']+?)[.,]?(?:\s*\(profile\s*(\d+)\))?\.?\s*$/im;
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

export async function liveState(withThumbs: boolean) {
  const tabs = liveTabs();
  for (const id of thumbs.keys()) if (!tabs.some(t => t.id === id)) thumbs.delete(id);
  return {
    profiles: await listProfiles(),
    needs: await needs(),
    tabs: await Promise.all(
      tabs.map(async t => ({
        id: t.id,
        kind: t.kind,
        profile: t.profile,
        agent: t.agent,
        request: t.request ?? null,
        since: t.since,
        held: t.kind === 'person' ? t.since : heldSince(t.id),
        url: await t.page.url().catch(() => ''),
        title: await t.page.title().catch(() => ''),
        thumb: withThumbs ? await thumb(t) : null,
      })),
    ),
  };
}

const tab = (id: unknown) => {
  const t = liveTabs().find(x => x.id === id);
  if (!t) throw new Error('That page has closed.');
  return t;
};

// --- The page being watched: streamed while asked for, the latest frame kept ---
type Watch = { seq: number; frame: { data: string; width: number; height: number } | null; asked: number; stop: (() => Promise<void>) | null; waiters: Set<() => void> };
const watching = new Map<string, Watch>();
setInterval(() => {
  for (const [id, w] of watching)
    if (Date.now() - w.asked > WATCH_IDLE_MS || !liveTabs().some(t => t.id === id)) {
      watching.delete(id);
      void w.stop?.();
    }
}, 1000).unref();

export async function frame(id: string, after: number) {
  const t = tab(id);
  let w = watching.get(id);
  if (!w) {
    const fresh: Watch = { seq: 0, frame: null, asked: Date.now(), stop: null, waiters: new Set() };
    w = fresh;
    watching.set(id, fresh);
    fresh.stop = await t.page.screencast(f => {
      fresh.frame = f;
      fresh.seq++;
      for (const wake of fresh.waiters) wake();
      fresh.waiters.clear();
    });
    // A page that isn't changing sends no frames: start from how it looks now.
    if (!fresh.frame) {
      const data = await t.page.thumbnail(1, 60).catch(() => null);
      const size = await t.page.evaluate<{ w: number; h: number }>('({ w: innerWidth, h: innerHeight })').catch(() => ({ w: 1280, h: 900 }));
      if (data && !fresh.frame) fresh.frame = { data, width: size.w, height: size.h };
      fresh.seq++;
    }
  }
  w.asked = Date.now();
  if (w.seq <= after) {
    const watch = w;
    await new Promise<void>(r => {
      const timer = setTimeout(r, FRAME_WAIT_MS);
      watch.waiters.add(() => (clearTimeout(timer), r()));
    });
  }
  return { seq: w.seq, ...(w.seq > after && w.frame ? w.frame : { data: null, width: 0, height: 0 }), held: t.kind === 'person' ? t.since : heldSince(id) };
}

// --- The person's input: only on a page they have ---
const INPUTS = new Set(['mouse', 'wheel', 'key', 'text']);
export async function input(id: string, events: unknown) {
  const t = tab(id);
  if (t.kind === 'agent' && heldSince(id) == null) throw new Error('Take control of this page first: until then it’s the agent’s.');
  if (!Array.isArray(events)) throw new Error('events: a list.');
  for (const e of events.slice(0, 50) as PersonInput[]) {
    if (!e || !INPUTS.has(e.type)) continue;
    if (e.type === 'text' && (typeof e.text !== 'string' || e.text.length > 20_000)) continue;
    await t.page.input(e);
  }
  return { ok: true };
}

// take: the person has it, its agent waits. done: finished (a person's page closes, and
// the request it came from is told). handback: back to its agent, or closed, unfinished.
export async function control(id: string, action: unknown) {
  const t = tab(id);
  if (action === 'take') {
    if (t.kind === 'agent') hold(id);
  } else if (action === 'done' || action === 'handback') {
    if (t.kind === 'agent') release(id);
    else await closePersonTab(id, action === 'done');
  } else throw new Error('action: take, done or handback.');
  return { ok: true };
}

// "Open a profile to sign in": a page of the person's own in that profile's browser.
export async function openForPerson(profile: unknown, url: unknown) {
  const t = await openPersonTab(Number(profile ?? 1) || 1, typeof url === 'string' && url ? url : 'https://www.google.com');
  return { tab: t.id };
}
