import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { _testing, createProfile, openProfile, PROFILES_DIR } from './agent-profiles.js';
import { browserConn, handleBrowserConnectPage, handleBrowserLinkUpgrade, linkReady, listBrowsers, managedProfile } from './browser-link.js';
import { CdpPage } from './cdp.js';

// An agents' profile end to end, with nothing faked but headless: the SERVER starts a
// real Edge (or Chromium) on a profile folder of its own, with the EXTREMELY extension
// loaded and no DevTools port; the extension pairs itself into that profile's number
// from the connect page the browser starts on, and a page opens in it through the link.
// Then the browser closes, and the server opens it again: already paired, it comes
// back by itself (no connect page).
//
// Headless is the only test-only change (_testing.setExtraArgs). Branded Chrome ignores
// --load-extension, so only Edge and Chromium are tried; EAA_E2E_BROWSER names one.
// Skipped, with the reason, when none is here.

function candidate(): { exe: string; kind: 'edge' | 'chromium' } | null {
  const env = process.env;
  if (env.EAA_E2E_BROWSER) return { exe: env.EAA_E2E_BROWSER, kind: /edge/i.test(env.EAA_E2E_BROWSER) ? 'edge' : 'chromium' };
  const newest = (dir: string, prefix: string, rel: string[]) => (existsSync(dir) ? readdirSync(dir).filter(d => d.startsWith(prefix)).sort().reverse().map(d => join(dir, d, ...rel)) : []);
  const edge =
    process.platform === 'win32'
      ? [join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'), join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe')]
      : process.platform === 'darwin'
        ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
        : ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'];
  const chromium =
    process.platform === 'win32'
      ? [join(env.LOCALAPPDATA ?? '', 'Chromium', 'Application', 'chrome.exe'), ...newest(join(env.LOCALAPPDATA ?? '', 'ms-playwright'), 'chromium-', ['chrome-win64', 'chrome.exe'])]
      : process.platform === 'darwin'
        ? ['/Applications/Chromium.app/Contents/MacOS/Chromium']
        : ['/usr/bin/chromium', '/usr/bin/chromium-browser', ...newest(join(homedir(), '.cache', 'ms-playwright'), 'chromium-', ['chrome-linux', 'chrome'])];
  const e = edge.find(p => existsSync(p));
  if (e) return { exe: e, kind: 'edge' };
  const c = chromium.find(p => existsSync(p));
  return c ? { exe: c, kind: 'chromium' } : null;
}

let server: Server;
const found = candidate();
const procs: ChildProcess[] = [];
const html = (title: string) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1></body></html>`;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (handleBrowserConnectPage(req, res, url)) return;
    if (url.pathname === '/site') return void res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html('Supplier portal'));
    res.writeHead(404).end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (!handleBrowserLinkUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  // The connect page and the link a profile is given are on this agency's port.
  process.env.PORT = String((server.address() as AddressInfo).port);
  await linkReady();
  if (!found) return;
  _testing.setBrowser(found);
  _testing.setExtraArgs(['--headless=new', '--disable-sync', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]);
  // Started as the app starts it, but kept here so the test can close it and clean up.
  _testing.setSpawn((exe, args, opts) => {
    const p = spawn(exe, args, { ...opts, detached: false });
    procs.push(p);
    return p;
  });
  _testing.setWaits(45_000, 20_000);
});

const ended = (p: ChildProcess) => (p.exitCode !== null || p.signalCode !== null ? Promise.resolve() : new Promise<void>(r => p.once('exit', () => r())));
after(async () => {
  for (const p of procs) {
    p.kill();
    await ended(p);
  }
  server?.close();
});

const until = async (ok: () => boolean, ms: number, what: string) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 100));
  }
};

let n = 0;

test("the server opens a new agents' profile itself: it pairs into its number and a page opens in it", { timeout: 90_000 }, async t => {
  if (!found) return t.skip('no Edge or Chromium on this machine');
  n = createProfile();
  await openProfile(n, { force: true });
  assert.equal(procs.length, 1, 'one browser started');
  const args = procs[0].spawnargs;
  assert.ok(args.some(a => a.startsWith('--load-extension=')));
  assert.ok(!args.some(a => /remote-debugging/.test(a)), 'no debugging port');
  assert.ok(args.some(a => a.includes('/browser/connect#eaa1:')), 'it started on the connect page');
  const listed = listBrowsers().find(b => b.n === n);
  assert.ok(listed?.online && listed.managed);
  assert.equal(listed!.name, `Agents' profile ${n}`);
  assert.equal(managedProfile(n)?.paired, true);
  const conn = browserConn(n)!;
  const page = await CdpPage.open(conn, { left: 0, top: 0, width: 1200, height: 800 }, 'about:blank', { eaaGroup: { key: 'run-p', title: 'Supplier Agent' } });
  await page.goto(`http://127.0.0.1:${process.env.PORT}/site`);
  assert.equal(await page.title(), 'Supplier portal');
  await page.close();
});

test('closed, then opened again: already paired, it comes back by itself', { timeout: 90_000 }, async t => {
  if (!found || !n) return t.skip('no Edge or Chromium on this machine');
  // Closed as the app closes one (Edge starts itself again at launch, so the process it
  // was started as is long gone): whatever runs on its folder.
  assert.ok(await _testing.close(join(PROFILES_DIR, managedProfile(n)!.dir), true), 'closed'); // headless: no window to ask
  await until(() => !browserConn(n), 15_000, 'offline');
  // Its folder's lock goes with the browser (Windows deletes it on close); a moment for that.
  await new Promise(r => setTimeout(r, 1500));
  await openProfile(n, { force: true });
  assert.equal(procs.length, 2);
  assert.ok(!procs[1].spawnargs.some(a => a.includes('/browser/connect#')), 'paired: started without the connect page');
  assert.ok(browserConn(n));
});
