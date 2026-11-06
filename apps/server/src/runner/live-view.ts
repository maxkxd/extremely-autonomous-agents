import { spawn, type ChildProcess } from 'node:child_process';
import { readMeta } from '../files.js';
import type { PersonInput } from './cdp.js';
import { all } from './db.js';
import { closePersonWindow, heldSince, hold, listProfiles, liveTabs, openProfileWindow, personScreens, release, screenSize, type LiveTab } from './browser.js';

// The agents' browser, live in the app (the Agents' browser page): every agent's page
// in the profiles' browsers, small and about once a second; the one the person
// watches as it changes; and that one taken over - their mouse, keys, pasted text and
// scrolling go to it, and its agent waits on it until it's handed back. The same here
// and in the cloud: these are ordinary requests to the agency, so from elsewhere they
// go through the end-to-end encrypted relay like the rest.
//
// In the cloud the person's own window (signing in, a CAPTCHA) is on a screen of its
// own (browser.ts personScreens): the plain browser with nothing attached, because
// Google refuses one with a debugging connection. That screen is streamed from the
// display itself (ffmpeg) and their input typed into it (xdotool), never through
// DevTools.
//
// Frames are pulled, not pushed: the app asks for the next one after the one it has,
// and a page is only streamed while somebody keeps asking.

const THUMB_MS = 1000;
const WATCH_IDLE_MS = 5000;
const FRAME_WAIT_MS = 2500;

type Frame = { data: string; width: number; height: number };
type Source = {
  id: string;
  kind: 'agent' | 'person';
  profile: number;
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

// --- A person's screen in the cloud: frames from the display, input with xdotool ---
const SCREEN_PREFIX = 'screen:';
function grabStream(display: string, onFrame: (f: Frame) => void, fps = 6): ChildProcess {
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-framerate', String(fps), '-video_size', `${screenSize.width}x${screenSize.height}`, '-i', display, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '7', 'pipe:1'], {
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let buf = Buffer.alloc(0);
  ff.stdout!.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    // Each JPEG runs from FFD8 to FFD9.
    for (;;) {
      const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
      const end = start < 0 ? -1 : buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (start < 0 || end < 0) break;
      onFrame({ data: buf.subarray(start, end + 2).toString('base64'), ...screenSize });
      buf = buf.subarray(end + 2);
    }
    if (buf.length > 8 * 1024 * 1024) buf = Buffer.alloc(0);
  });
  ff.on('error', () => {});
  return ff;
}
const grabOne = (display: string, width = 320) =>
  new Promise<string | null>(resolve => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-video_size', `${screenSize.width}x${screenSize.height}`, '-i', display, '-frames:v', '1', '-vf', `scale=${width}:-1`, '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '8', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parts: Buffer[] = [];
    ff.stdout!.on('data', d => parts.push(d));
    ff.on('close', () => resolve(parts.length ? Buffer.concat(parts).toString('base64') : null));
    ff.on('error', () => resolve(null));
  });

// The browser's key names, as X knows them. A key with a character is typed as text.
const KEYSYM: Record<string, string> = {
  Enter: 'Return', Backspace: 'BackSpace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Insert: 'Insert',
  ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', ' ': 'space',
};
for (let i = 1; i <= 12; i++) KEYSYM[`F${i}`] = `F${i}`;
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);
const xdotool = (display: string, args: string[]) =>
  new Promise<void>(resolve => {
    const p = spawn('xdotool', args, { env: { ...process.env, DISPLAY: display }, stdio: 'ignore' });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
async function typeInto(display: string, e: PersonInput) {
  const btn = (b?: string) => (b === 'right' ? '3' : b === 'middle' ? '2' : '1');
  if (e.type === 'mouse') {
    const at = ['mousemove', String(Math.round(e.x)), String(Math.round(e.y))];
    if (e.action === 'mouseMoved') return xdotool(display, at);
    return xdotool(display, [...at, e.action === 'mousePressed' ? 'mousedown' : 'mouseup', btn(e.button)]);
  }
  if (e.type === 'wheel') {
    const dy = e.deltaY, dx = e.deltaX;
    const n = Math.min(10, Math.max(1, Math.round(Math.abs(dy || dx) / 60)));
    const button = Math.abs(dy) >= Math.abs(dx) ? (dy > 0 ? '5' : '4') : dx > 0 ? '7' : '6';
    return xdotool(display, ['mousemove', String(Math.round(e.x)), String(Math.round(e.y)), 'click', '--repeat', String(n), '--delay', '10', button]);
  }
  if (e.type === 'text') return xdotool(display, ['type', '--delay', '4', '--', e.text]);
  if (e.action !== 'down' || MODIFIER_KEYS.has(e.key)) return;
  const mods = e.modifiers ?? 0;
  const combo = [mods & 2 ? 'ctrl' : '', mods & 1 ? 'alt' : '', mods & 4 ? 'super' : ''].filter(Boolean);
  if (e.text && !combo.length) return xdotool(display, ['type', '--delay', '0', '--', e.text]);
  const sym = KEYSYM[e.key] ?? (e.key.length === 1 ? e.key.toLowerCase() : null);
  if (!sym) return;
  if (mods & 8 && !e.text) combo.push('shift');
  return xdotool(display, ['key', '--clearmodifiers', [...combo, sym].join('+')]);
}

// --- Every page there is to watch: agents' pages, and the person's screens ---
function sources(): Source[] {
  const agents: Source[] = liveTabs().map(t => ({
    id: t.id,
    kind: 'agent',
    profile: t.profile,
    agent: t.agent,
    request: null,
    since: t.since,
    held: heldSince(t.id),
    url: () => t.page.url().catch(() => ''),
    title: () => t.page.title().catch(() => ''),
    thumb: () => t.page.thumbnail().catch(() => null),
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
  const screens: Source[] = personScreens().map(s => ({
    id: `${SCREEN_PREFIX}${s.profile}`,
    kind: 'person',
    profile: s.profile,
    agent: null,
    request: s.request ?? null,
    since: s.since,
    held: s.since, // always theirs
    url: async () => s.url,
    title: async () => 'Your window',
    thumb: () => grabOne(s.display),
    stream: async onFrame => {
      const ff = grabStream(s.display, onFrame);
      return async () => void ff.kill();
    },
    input: e => typeInto(s.display, e),
  }));
  return [...agents, ...screens];
}
const sourceOf = (id: unknown) => {
  const s = sources().find(x => x.id === id);
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
  const all = sources();
  for (const id of thumbs.keys()) if (!all.some(s => s.id === id)) thumbs.delete(id);
  return {
    profiles: await listProfiles(),
    needs: await needs(),
    tabs: await Promise.all(
      all.map(async s => ({
        id: s.id,
        kind: s.kind,
        profile: s.profile,
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
setInterval(() => {
  const ids = new Set(sources().map(s => s.id));
  for (const [id, w] of watching)
    if (Date.now() - w.asked > WATCH_IDLE_MS || !ids.has(id)) {
      watching.delete(id);
      void w.stop?.();
    }
}, 1000).unref();

export async function frame(id: string, after: number) {
  const s = sourceOf(id);
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
  const s = sourceOf(id);
  if (s.held == null) throw new Error('Take control of this page first: until then it’s the agent’s.');
  if (!Array.isArray(events)) throw new Error('events: a list.');
  for (const e of events.slice(0, 50) as PersonInput[]) {
    if (!e || !INPUTS.has(e.type)) continue;
    if (e.type === 'text' && (typeof e.text !== 'string' || e.text.length > 20_000)) continue;
    await s.input(e);
  }
  return { ok: true };
}

// take: the person has it, its agent waits. done: finished (the person's window closes,
// and the request it came from is told). handback: back to its agent, or closed, unfinished.
export async function control(id: string, action: unknown) {
  const s = sourceOf(id);
  if (action === 'take') {
    if (s.kind === 'agent') hold(id);
  } else if (action === 'done' || action === 'handback') {
    if (s.kind === 'agent') release(id);
    else closePersonWindow(s.profile, action === 'done');
  } else throw new Error('action: take, done or handback.');
  return { ok: true };
}

// "Open a profile to sign in": the person's own window on that profile - on their screen
// here, or (in the cloud) on a screen of its own, shown on the page.
export async function openForPerson(profile: unknown, url: unknown) {
  const r = await openProfileWindow(Number(profile ?? 1) || 1, typeof url === 'string' && url ? url : 'https://www.google.com');
  return { tab: (r as { live?: string }).live ?? null };
}
