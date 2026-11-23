import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { pageViewForTests as view } from './browser.js';
import { browserConn, handleBrowserConnectPage, handleBrowserLinkUpgrade, listBrowsers, onBrowserOnline, pairCode } from './browser-link.js';
import { CdpPage, type CdpConn } from './cdp.js';

// The browser connector end to end, with nothing faked: a real Edge / Chrome /
// Chromium, headless, with the EXTREMELY extension (apps/person-chrome) side-loaded,
// no DevTools port. It pairs itself from the connect page (as the app opens it),
// and the agents' CdpPage drives it through the link (browser-link.ts):
// a form, a cross-site iframe, a popup, a screenshot, tab groups, detach and
// re-attach, and the browser going away.
//
// Branded Chrome 137+ ignores --load-extension, so this tries Edge first, then Chrome,
// then a Chromium / Chrome for Testing (Playwright's or Puppeteer's download). Set
// EAA_E2E_BROWSER to an executable to use only that one. Skipped, with the reason,
// when none of them loads the extension.

const EXT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../person-chrome');
const CONNECT_MS = 30_000; // a first start of a browser (and its extension) can be slow on Windows

function newestIn(dir: string, prefix: string, rel: string[]): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(d => d.startsWith(prefix))
    .sort()
    .reverse()
    .map(d => join(dir, d, ...rel));
}

function candidates(): { name: string; exe: string }[] {
  const env = process.env;
  if (env.EAA_E2E_BROWSER) return [{ name: 'EAA_E2E_BROWSER', exe: env.EAA_E2E_BROWSER }];
  const list: { name: string; exe: string }[] = [];
  const add = (name: string, exe: string) => exe && existsSync(exe) && !list.some(c => c.exe === exe) && list.push({ name, exe });
  if (process.platform === 'win32') {
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA ?? '';
    add('Edge', join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    add('Edge', join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    add('Chrome', join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    add('Chrome', join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    add('Chrome', join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    for (const p of newestIn(join(local, 'ms-playwright'), 'chromium-', ['chrome-win64', 'chrome.exe'])) add('Chromium (Playwright)', p);
    for (const p of newestIn(join(local, 'ms-playwright'), 'chromium-', ['chrome-win', 'chrome.exe'])) add('Chromium (Playwright)', p);
    for (const p of newestIn(join(homedir(), '.cache', 'puppeteer', 'chrome'), 'win64-', ['chrome-win64', 'chrome.exe'])) add('Chrome for Testing (Puppeteer)', p);
    add('Chromium', join(local, 'Chromium', 'Application', 'chrome.exe'));
  } else if (process.platform === 'darwin') {
    add('Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    add('Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium');
    for (const p of newestIn(join(homedir(), 'Library', 'Caches', 'ms-playwright'), 'chromium-', ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'])) add('Chromium (Playwright)', p);
  } else {
    for (const p of ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) add(p.includes('edge') ? 'Edge' : 'Chrome', p);
    for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) add('Chromium', p);
    for (const p of newestIn(join(homedir(), '.cache', 'ms-playwright'), 'chromium-', ['chrome-linux', 'chrome'])) add('Chromium (Playwright)', p);
  }
  return list;
}

// --- The agency side: the link, the connect page and a tiny test site ------------------

let server: Server;
let port = 0;
let siteHits: string[] = [];

const html = (body: string, title = 'Test') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function site(path: string): string | null {
  // The iframe is on localhost, the page on 127.0.0.1: two sites, so with site
  // isolation the frame is out of process and comes in as a child session.
  if (path === '/site')
    return html(
      `<h1>Order form</h1>
      <label>Your name <input id="who"></label>
      <button id="go" onclick="document.getElementById('out').textContent = 'Hello, ' + document.getElementById('who').value">Greet me</button>
      <p id="out"></p>
      <p><a id="pop" href="/popup" target="_blank">Open the popup</a></p>
      <iframe id="fr" src="http://localhost:${port}/frame" width="400" height="120"></iframe>`,
      'Order form',
    );
  if (path === '/frame') return html(`<button onclick="this.textContent = 'Frame clicked'">Frame button</button>`, 'Frame');
  if (path === '/popup') return html(`<h1>The popup</h1>`, 'Popup page');
  if (path === '/plain') return html(`<p>Not an agent tab</p>`, 'Person tab');
  return null;
}

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (handleBrowserConnectPage(req, res, url)) return;
    siteHits.push(url.pathname);
    const body = site(url.pathname);
    if (body == null) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
  });
  server.on('upgrade', (req, socket, head) => {
    if (!handleBrowserLinkUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});

// --- The browser ----------------------------------------------------------------------

type Launched = { name: string; exe: string; proc: ChildProcess; dir: string; n: number; conn: CdpConn; exited: Promise<void>; onlines: number };
let b: Launched | null = null;
const children: { session: string; parent?: string; type?: string; url?: string }[] = [];
const tried: string[] = [];

async function launch(name: string, exe: string): Promise<Launched | null> {
  const dir = await mkdtemp(join(tmpdir(), 'eaa-e2e-'));
  const { link } = pairCode(`http://127.0.0.1:${port}`);
  let online: ((v: { n: number; conn: CdpConn }) => void) | undefined;
  const came = new Promise<{ n: number; conn: CdpConn }>(r => (online = r));
  let onlines = 0;
  const off = onBrowserOnline((n, conn) => (onlines++, online!({ n, conn })));
  const proc = spawn(
    exe,
    [
      `--user-data-dir=${dir}`,
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-features=msEdgeSidebarV2,msHubApps,EdgeEnclave',
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
      `http://127.0.0.1:${port}/browser/connect#${link}`,
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise<void>(r => proc.once('exit', () => r()));
  const timeout = new Promise<null>(r => setTimeout(() => r(null), CONNECT_MS).unref());
  const got = await Promise.race([came, timeout, exited.then(() => null)]);
  if (!got) {
    off();
    tried.push(`${name} (${exe}): the extension never connected`);
    proc.kill();
    await exited;
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
  // Steady: the same connection for a second (the pairing one carries on as the live one).
  const n = got.n;
  let conn: CdpConn | null = null;
  const end = Date.now() + 10_000;
  for (let steady = 0; steady < 10 && Date.now() < end; ) {
    const now = browserConn(n);
    steady = now && now === conn ? steady + 1 : 0;
    conn = now;
    await new Promise(r => setTimeout(r, 100));
  }
  off();
  if (!conn) {
    tried.push(`${name}: paired as browser ${n} but did not stay online`);
    proc.kill();
    await exited;
    return null;
  }
  tried.push(`${name}: loaded the extension and paired as browser ${n}`);
  return { name, exe, proc, dir, exited, n, conn, onlines };
}

before(async () => {
  for (const c of candidates()) {
    b = await launch(c.name, c.exe);
    if (b) break;
  }
  // Out-of-process iframes, as the extension forwards them: Chrome's own session id,
  // announced on the tab's session.
  b?.conn.on('Target.attachedToTarget', (p, parent) => children.push({ session: p.sessionId, parent, type: p.targetInfo?.type, url: p.targetInfo?.url }));
  console.log(`[e2e] browsers tried:\n  ${tried.join('\n  ') || 'none found'}`);
});

after(async () => {
  if (b && b.proc.exitCode == null) {
    b.proc.kill();
    await b.exited;
  }
  if (b) await rm(b.dir, { recursive: true, force: true }).catch(() => {});
  server?.close();
});

const skipReason = () => (b ? '' : candidates().length ? `no browser here loads a side-loaded extension headless (${tried.join('; ')})` : 'no Edge, Chrome or Chromium on this machine');
const bounds = { left: 0, top: 0, width: 1200, height: 800 };
const group = { key: 'run-1', title: 'Test Agent' };
const refOf = (snap: string, kind: string, label: string) => {
  const m = new RegExp(`\\[(\\d+)\\] ${kind} "${label}"`).exec(snap);
  assert.ok(m, `no ${kind} "${label}" in:\n${snap}`);
  return Number(m[1]);
};
const until = async <T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000, what = 'condition'): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
};
type Info = { targetId: string; type: string; url: string; title: string; openerId?: string; attached: boolean };
const targets = async () => (await b!.conn.send<{ targetInfos: Info[] }>('Target.getTargets')).targetInfos;

// --- The tests ----------------------------------------------------------------------

test('the browser paired itself from the connect page and is online', async t => {
  if (!b) return t.skip(skipReason());
  const listed = listBrowsers().find(x => x.n === b!.n);
  assert.ok(listed?.online, 'listed online');
  assert.equal(listed!.kind, /msedge|Microsoft Edge|microsoft-edge/i.test(b!.exe) ? 'edge' : 'chrome');
  assert.equal(listed!.version, '0.2.0');
  assert.equal(browserConn(b!.n), b!.conn);
  // Paired and online on one connection: not online, offline and online again.
  assert.equal(b!.onlines, 1, 'went online once');
  const v = await b!.conn.send<{ protocolVersion: string; product: string; extensionVersion: string }>('Browser.getVersion');
  assert.equal(v.protocolVersion, '1.3');
  assert.equal(v.extensionVersion, '0.2.0');
  // The connect page the browser started on is the person's tab: never listed.
  assert.deepEqual(await targets(), []);
});

let page: CdpPage;

test('an agent tab: open, look, fill, click, read, screenshot', async t => {
  if (!b) return t.skip(skipReason());
  page = await CdpPage.open(b!.conn, bounds, 'about:blank', { eaaGroup: group });
  assert.match(page.targetId, /^t:\d+$/);
  await page.goto(`http://127.0.0.1:${port}/site`);
  assert.equal(await page.title(), 'Order form');
  const snap = await view.snapshot(page);
  const who = refOf(snap, 'text field', 'Your name');
  const go = refOf(snap, 'button', 'Greet me');
  const filled = await page.fill(who, 'Sam Rivera');
  assert.deepEqual(filled, { ok: true, value: 'Sam Rivera' });
  await page.click(go);
  await until(async () => (await page.evaluate<string>(`document.getElementById('out').textContent`)) === 'Hello, Sam Rivera', 5000, 'the greeting');
  const after = await view.snapshot(page);
  assert.match(after, /Hello, Sam Rivera/);

  const shot = await b!.conn.send<{ data: string }>('Page.captureScreenshot', { format: 'png' }, page.targetId);
  const png = Buffer.from(shot.data, 'base64');
  assert.ok(png.length > 1000, 'a real screenshot');
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok((await page.thumbnail()).length > 100);

  const info = await page.info();
  assert.equal(info.url, `http://127.0.0.1:${port}/site`);
  assert.equal(info.title, 'Order form');
});

test('a cross-site iframe comes in as a child session and can be clicked', async t => {
  if (!b) return t.skip(skipReason());
  // Agents' frames go through the address guard, which keeps loopback out; this site is on loopback.
  view.allowAllFrames();
  const frames = await until(async () => {
    const f = await page.frames();
    return f.some((x: { url: string }) => x.url.includes(`localhost:${port}/frame`)) && f;
  }, 10_000, 'the iframe');
  assert.ok(frames.length >= 1);
  const child = await until(() => children.find(c => c.type === 'iframe' && c.parent === page.targetId), 5000, 'the child session');
  assert.equal(child.parent, page.targetId, 'announced on the tab session');
  assert.doesNotMatch(child.session, /^t:/, 'a child session keeps Chrome id');
  const snap = await view.snapshot(page);
  const btn = refOf(snap, 'button', 'Frame button');
  await page.click(btn);
  await until(async () => /button "Frame clicked"/.test(await view.snapshot(page)), 5000, 'the frame click');
});

test('a link to a new tab: an agent tab with openerId, in the same group, adoptable', async t => {
  if (!b) return t.skip(skipReason());
  const snap = await view.snapshot(page);
  await page.click(refOf(snap, 'link', 'Open the popup'));
  const ids = await until(async () => {
    const p = await page.popups();
    return p.length ? p : null;
  }, 10_000, 'the popup');
  assert.equal(ids.length, 1);
  const all = await targets();
  const pop = all.find(t => t.targetId === ids[0])!;
  assert.equal(pop.openerId, page.targetId);
  const popup = await page.adopt(ids[0]);
  await popup.ready();
  await until(async () => (await popup.title()) === 'Popup page', 5000, 'the popup to load');
  assert.match(await view.snapshot(popup), /The popup/);

  const g1 = await b!.conn.send<{ groupId: number; title?: string; collapsed?: boolean }>('EAA.tabGroup', { targetId: page.targetId });
  const g2 = await b!.conn.send<{ groupId: number; active?: boolean }>('EAA.tabGroup', { targetId: ids[0] });
  // The link opened the tab in front, in the person's window: the front went back to
  // the person's tab (the connect page here), and the agent's group stayed collapsed.
  await until(async () => !(await b!.conn.send<{ active: boolean }>('EAA.tabGroup', { targetId: ids[0] })).active, 3000, 'the front back with the person');
  if (g1.groupId === -1) {
    // This browser has no tab groups (headless may not): no group, and everything still works.
    console.log('[e2e] no tab groups in this browser: agent tabs work ungrouped');
    assert.equal(g2.groupId, -1);
  } else {
    assert.equal(g1.title, 'Test Agent');
    const now = await b!.conn.send<{ collapsed: boolean }>('EAA.tabGroup', { targetId: page.targetId });
    assert.equal(now.collapsed, true, 'still collapsed');
    assert.equal(g2.groupId, g1.groupId, 'the popup joined its opener group');
  }
  await popup.close();
  await until(async () => !(await targets()).some(t => t.targetId === ids[0]), 5000, 'the popup to close');
});

test('Target.getTargets lists agent tabs only, never the person own', async t => {
  if (!b) return t.skip(skipReason());
  // The popup is closed; the person's own tab (the connect page the browser started on) is never listed.
  const all = await targets();
  assert.deepEqual(all.map(x => x.targetId), [page.targetId]);
  assert.ok(all.every(x => !x.url.includes('/browser/connect')));
  // Attaching to a tab id that isn't an agent tab is refused.
  await assert.rejects(b!.conn.send('Target.attachToTarget', { targetId: 't:1', flatten: true }), /Not an agent tab/);
  await assert.rejects(b!.conn.send('Target.createBrowserContext'), /Not supported in the extension/);
});

test('a second run gets its own group; closeTarget closes the tab', async t => {
  if (!b) return t.skip(skipReason());
  const other = await CdpPage.open(b!.conn, bounds, `http://127.0.0.1:${port}/plain`, { eaaGroup: { key: 'run-2', title: 'Other Agent' } });
  await other.ready();
  const g1 = await b!.conn.send<{ groupId: number }>('EAA.tabGroup', { targetId: page.targetId });
  const g2 = await b!.conn.send<{ groupId: number; title?: string }>('EAA.tabGroup', { targetId: other.targetId });
  if (g1.groupId !== -1) {
    assert.notEqual(g2.groupId, g1.groupId);
    assert.equal(g2.title, 'Other Agent');
  }
  await other.close();
  await until(async () => !(await targets()).some(t => t.targetId === other.targetId), 5000, 'the tab to close');
  assert.ok(other.isClosed());
});

test('detach leaves the tab open and unattached; attach works again', async t => {
  if (!b) return t.skip(skipReason());
  const id = page.targetId;
  await page.detach();
  const was = await until(async () => (await targets()).find(x => x.targetId === id && !x.attached), 5000, 'detached');
  assert.equal(was.url, `http://127.0.0.1:${port}/site`);
  page = await CdpPage.attach(b!.conn, id);
  assert.equal(await page.title(), 'Order form');
  assert.ok((await targets()).find(x => x.targetId === id)?.attached);
  const snap = await view.snapshot(page);
  assert.match(snap, /Order form/);
});

// Connect this browser again, in a browser that's paired already and online: the
// extension sends the token it holds, so it pairs again into its own number and stays
// online. It used to become a new browser and leave its old number listed offline.
test('pairing again from the connect page keeps the browser number, online', async t => {
  if (!b) return t.skip(skipReason());
  const count = listBrowsers().length;
  const was = listBrowsers().find(x => x.n === b!.n)!;
  const oldConn = b!.conn;
  let off = () => {};
  const again = new Promise<{ n: number; conn: CdpConn }>(r => (off = onBrowserOnline((n, conn) => r({ n, conn }))));
  const { link } = pairCode(`http://127.0.0.1:${port}`);
  // The connect page, as the app opens it (here in a tab only an agency can open).
  const { targetId } = await oldConn.send<{ targetId: string }>('Target.createTarget', { url: `http://127.0.0.1:${port}/browser/connect#${link}`, eaaGroup: group });
  const got = await Promise.race([again, new Promise<null>(r => setTimeout(() => r(null), 15_000).unref())]);
  off();
  assert.ok(got, 'online again after pairing again');
  assert.equal(got.n, b!.n, 'the same number');
  // Steady on the pairing connection: no hello replacing it, nothing closing it.
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(browserConn(b!.n), got.conn, 'still the pairing connection');
  assert.ok(oldConn.closed, 'the older connection was replaced');
  assert.equal(listBrowsers().length, count, 'no second browser');
  const now = listBrowsers().find(x => x.n === b!.n)!;
  assert.ok(now.online, 'listed online');
  assert.ok(now.paired > was.paired, 'paired again');
  b!.conn = got.conn;
  // Back online, the agency closes agent tabs no live run has (the connect page's
  // among them, here). The browser works on the new connection.
  await until(async () => !(await targets()).some(x => x.targetId === targetId), 5000, 'the connect tab to close');
  page = await CdpPage.open(b!.conn, bounds, `http://127.0.0.1:${port}/site`, { eaaGroup: group });
  assert.equal(await page.title(), 'Order form');
});

test('the browser going away: offline, and waiting calls fail at once', async t => {
  if (!b) return t.skip(skipReason());
  // A call the page never answers (a promise that never settles) is waiting when the browser dies.
  const waiting = page.evaluate('new Promise(() => {})');
  const failed = assert.rejects(waiting, /went offline/);
  await new Promise(r => setTimeout(r, 300));
  const started = Date.now();
  b!.proc.kill();
  await failed;
  assert.ok(Date.now() - started < 15_000, 'rejected promptly, not at the 60 s timeout');
  await until(() => !listBrowsers().find(x => x.n === b!.n)?.online, 10_000, 'offline');
  assert.equal(browserConn(b!.n), null);
  assert.ok(page.isClosed());
  assert.ok(page.browserGone());
  await assert.rejects(b!.conn.send('Target.getTargets'), /went offline/);
});
