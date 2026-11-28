import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { _testing, adoptProfileFolders, bundledBrowser, cantOpen, createProfile, forgetDisabledExtension, launchArgs, madeByEdge, openProfile, PROFILES_DIR } from './agent-profiles.js';
import { browserConn, handleBrowserLinkUpgrade, linkReady, listBrowsers, managedProfile, pairCode, removeBrowser } from './browser-link.js';
import { one, resetDbForTests, run as exec } from './db.js';
import { listPasswords, savePassword } from './passwords.js';

// Agents' profiles (agent-profiles.ts): the folders the app opens itself as normal
// browsers with the extension loaded. The browser is faked (an injected spawn); the
// link is real, with Node's WebSocket as the extension in it. Test persona: Sam
// Rivera's agency, whose agents used profile folders 1 and 2 before the extension.

let server: Server;
let port = 0;
const wsUrl = () => `ws://127.0.0.1:${port}/api/browser-link`;

before(async () => {
  resetDbForTests();
  server = createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    if (!handleBrowserLinkUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  // The connect page and the link a profile is given are on this agency's own port.
  process.env.PORT = String(port);
  await linkReady();
});
const sockets: WebSocket[] = [];
after(() => {
  for (const ws of sockets) ws.close();
  server.close();
});

// A fake extension pairing with a link's code (as the connect page makes it do).
async function pairWith(link: string, label = 'Edge'): Promise<{ browser: number; name: string; ws: WebSocket }> {
  const { u, c } = JSON.parse(Buffer.from(link.replace(/^.*eaa1:/, ''), 'base64url').toString('utf8'));
  assert.equal(u, wsUrl(), 'the link is for this agency on loopback');
  const ws = new WebSocket(u);
  sockets.push(ws);
  await new Promise<void>((r, j) => (ws.addEventListener('open', () => r(), { once: true }), ws.addEventListener('error', () => j(new Error('did not open')), { once: true })));
  const reply = new Promise<any>(r => ws.addEventListener('message', ev => r(JSON.parse(String(ev.data))), { once: true }));
  ws.send(JSON.stringify({ type: 'pair', code: c, protocol: 1, version: '0.2.0', browser: 'edge', label }));
  const got = await reply;
  assert.equal(got.type, 'paired', JSON.stringify(got));
  return { browser: got.browser, name: got.name, ws };
}

const profileFolder = (name: string, kind: 'state' | 'default' | 'empty') => {
  const dir = join(PROFILES_DIR, name);
  mkdirSync(kind === 'default' ? join(dir, 'Default') : dir, { recursive: true });
  if (kind === 'state') writeFileSync(join(dir, 'Local State'), '{}');
  return dir;
};

// The injected browser: every start's arguments, and what it does once started.
type Start = { exe: string; args: string[] };
const starts: Start[] = [];
let onStart: (s: Start) => void = () => {};
function fakeSpawn(exe: string, args: string[]) {
  const s = { exe, args };
  starts.push(s);
  const proc = Object.assign(new EventEmitter(), { pid: 4000 + starts.length, exitCode: null, signalCode: null, unref() {} });
  queueMicrotask(() => onStart(s));
  return proc as any;
}
const connectLink = (s: Start) => s.args.find(a => a.includes('/browser/connect#'))?.replace(/^.*#/, '') ?? null;

test('launch arguments: its own folder and the extension, never a debugging port', () => {
  const args = launchArgs('/data/browser-profiles/3', '/app/extension', 'http://127.0.0.1:5175/browser/connect#eaa1:x');
  assert.ok(args.includes('--user-data-dir=/data/browser-profiles/3'));
  assert.ok(args.includes('--load-extension=/app/extension'));
  assert.ok(args.includes('--no-first-run'));
  assert.equal(args.at(-1), 'http://127.0.0.1:5175/browser/connect#eaa1:x');
  assert.ok(!args.some(a => /remote-debugging/.test(a)));
  _testing.setExtraArgs(['--remote-debugging-port=0']);
  try {
    assert.throws(() => launchArgs('/d', '/e'), /never opens with a debugging port/);
  } finally {
    _testing.setExtraArgs([]);
  }
});

test('the browser shipped with the app: found from its BROWSER.json, none when the folder has none', () => {
  const dir = join(PROFILES_DIR, '..', 'shipped-browser');
  mkdirSync(join(dir, 'app'), { recursive: true });
  assert.equal(bundledBrowser(dir), null); // no BROWSER.json (NONE.txt, a development build)
  writeFileSync(join(dir, 'BROWSER.json'), JSON.stringify({ name: 'Chrome for Testing', version: '1.0', exe: 'app/chrome.exe' }));
  assert.equal(bundledBrowser(dir), null); // named, but not there
  writeFileSync(join(dir, 'app', 'chrome.exe'), '');
  assert.deepEqual(bundledBrowser(dir), { exe: join(dir, 'app', 'chrome.exe'), kind: 'chromium' });
  assert.equal(bundledBrowser(undefined), null);
});

test("a profile folder Edge made is told apart from one Chromium made", () => {
  const edge = join(PROFILES_DIR, '..', 'made-by-edge');
  const chromium = join(PROFILES_DIR, '..', 'made-by-chromium');
  mkdirSync(edge, { recursive: true });
  mkdirSync(chromium, { recursive: true });
  writeFileSync(join(edge, 'Local State'), JSON.stringify({ edge: { retrigger_features: [] }, profile: {} }));
  writeFileSync(join(chromium, 'Local State'), JSON.stringify({ profile: {} }));
  assert.equal(madeByEdge(edge), true);
  assert.equal(madeByEdge(chromium), false);
  assert.equal(madeByEdge(join(PROFILES_DIR, '..', 'no-folder')), false);
});

test('launch arguments keep a command-line extension switched on in newer Edge', () => {
  assert.ok(launchArgs('/d', '/e').some(a => a.startsWith('--disable-features=') && a.includes('DisableLoadExtensionCommandLineSwitch')));
});

test("an extension the browser switched off as a developer extension is forgotten before a start; others stay", async () => {
  const dir = join(PROFILES_DIR, '..', 'secure-prefs-test'); // not a profile folder the others would count
  mkdirSync(join(dir, 'Default'), { recursive: true });
  const file = join(dir, 'Default', 'Secure Preferences');
  const prefs = {
    extensions: {
      settings: {
        ours: { location: 8, disable_reasons: [1 << 24] },
        oldFormat: { location: 8, disable_reasons: (1 << 24) | 8 },
        fine: { location: 8, disable_reasons: [] },
        store: { location: 1, disable_reasons: [1 << 24] },
      },
    },
    protection: { macs: { extensions: { settings: { ours: 'A', oldFormat: 'B', fine: 'C', store: 'D' } } } },
  };
  writeFileSync(file, JSON.stringify(prefs));
  await forgetDisabledExtension(dir);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(after.extensions.settings).sort(), ['fine', 'store']);
  assert.deepEqual(Object.keys(after.protection.macs.extensions.settings).sort(), ['fine', 'store']);
  await forgetDisabledExtension(join(PROFILES_DIR, '..', 'no-such-profile')); // nothing there: nothing happens
});

let samWork = 0; // the person's own browser, paired before this update came
const BEFORE_PAIRING = Date.now() - 86_400_000;

test("folders from before become agents' profiles; a clash keeps the person's browser and moves the folder's accounts", async () => {
  // Sam paired their own Chrome as browser 1 after the extension came, before this update...
  samWork = (await pairWith(pairCode({ local: true }).link, 'Chrome - Work')).browser;
  assert.equal(samWork, 1);
  // ...while folder 1's account is from the agents' own browser before, and one more
  // was made in Sam's browser 1 since.
  const old = await savePassword({ site: 'linkedin.com', username: 'agents@x.test', password: 'p', profile: 1, agentId: 'zz-a' });
  exec('UPDATE passwords SET created_at = ? WHERE id = ?', BEFORE_PAIRING, old);
  const since = await savePassword({ site: 'linkedin.com', username: 'sam@x.test', password: 'p', profile: 1, agentId: 'zz-a' });
  profileFolder('1', 'state');
  profileFolder('2', 'default');
  profileFolder('3', 'empty'); // made by the old app and never used: not a profile
  mkdirSync(join(PROFILES_DIR, 'notes'), { recursive: true });

  const r = await adoptProfileFolders();
  assert.deepEqual(r.adopted, [2]);
  // Folder 1 takes the next number; 3 is free (its folder has nothing of a profile in it).
  assert.deepEqual(r.renumbered, [{ folder: '1', n: 3, passwords: 1 }]);
  assert.equal(managedProfile(2)?.dir, '2');
  assert.equal(managedProfile(3)?.dir, '1');
  assert.equal(managedProfile(3)?.name, "Agents' profile 3");
  assert.equal(managedProfile(1), null, "browser 1 is still Sam's");
  const rows = listPasswords('linkedin.com');
  assert.equal(rows.find(x => x.id === old)?.profile, 3, "the folder's account went with it");
  assert.equal(rows.find(x => x.id === since)?.profile, 1, "Sam's browser keeps its own");
  const listed = listBrowsers();
  assert.deepEqual(listed.map(b => [b.n, b.managed]), [[1, false], [2, true], [3, true]]);

  // Again (the next start): nothing changes.
  assert.deepEqual(await adoptProfileFolders(), { adopted: [], renumbered: [] });
  assert.equal(listPasswords('linkedin.com').find(x => x.id === old)?.profile, 3);
});

test("a person's browser skips a profile folder's number; the folder then gets it", async () => {
  profileFolder('4', 'state'); // appeared since (copied in, say), not numbered yet
  const p = await pairWith(pairCode({ local: true }).link, 'Chrome - Home');
  assert.equal(p.browser, 5, 'not 4: that is the folder\'s');
  const r = await adoptProfileFolders();
  assert.deepEqual(r.adopted, [4]);
  assert.equal(managedProfile(4)?.dir, '4');
});

test("pairCode for an agents' profile pairs it into its own number, over loopback", async () => {
  assert.throws(() => pairCode({ browser: 1 }), /isn't one of the agents' profiles/);
  assert.throws(() => pairCode({ browser: 99 }), /isn't one of the agents' profiles/);
  process.env.EAA_PUBLIC_URL = 'https://public.example.test';
  try {
    const p = pairCode({ browser: 4, local: true });
    assert.equal(p.url, wsUrl(), 'loopback even where the agency has a public address');
    const got = await pairWith(p.link, 'Edge');
    assert.equal(got.browser, 4);
    assert.equal(got.name, "Agents' profile 4");
  } finally {
    delete process.env.EAA_PUBLIC_URL;
  }
  assert.ok(browserConn(4));
  assert.equal(managedProfile(4)?.paired, true);
  assert.ok(listBrowsers().find(b => b.n === 4)?.online);
  // Removing it takes its pairing only: the number and folder stay the agents'.
  removeBrowser(4);
  assert.equal(managedProfile(4)?.paired, false);
  assert.ok(listBrowsers().some(b => b.n === 4 && b.managed));
});

test("opening one: started with its folder and the extension, pairs itself from the connect page, comes online", async () => {
  _testing.setBrowser({ exe: 'C:/fake/msedge.exe', kind: 'edge' });
  _testing.setSpawn(fakeSpawn);
  _testing.setWaits(3000, 1000);
  onStart = s => {
    const link = connectLink(s);
    if (link) void pairWith(link);
  };
  starts.length = 0;
  assert.equal(cantOpen(2), null);
  await Promise.all([openProfile(2), openProfile(2)]);
  assert.equal(starts.length, 1, 'two callers, one browser started');
  const [s] = starts;
  assert.equal(s.exe, 'C:/fake/msedge.exe');
  assert.ok(s.args.includes(`--user-data-dir=${join(PROFILES_DIR, '2')}`));
  assert.ok(s.args.some(a => a.startsWith('--load-extension=') && existsSync(join(a.slice('--load-extension='.length), 'manifest.json'))));
  assert.ok(!s.args.some(a => /remote-debugging/.test(a)));
  assert.ok(connectLink(s), 'not paired yet: it starts on the connect page');
  assert.ok(browserConn(2));
  assert.equal(managedProfile(2)?.paired, true);
  // Online already: nothing started.
  await openProfile(2);
  assert.equal(starts.length, 1);
});

test('a paired profile starts without the connect page; one whose extension forgot its pairing gets it again', async () => {
  starts.length = 0;
  // Folder 1's profile (browser 3) paired earlier, its extension's storage since cleared:
  const p = await pairWith(pairCode({ browser: 3, local: true }).link);
  p.ws.close();
  await new Promise(r => setTimeout(r, 100));
  assert.equal(browserConn(3), null);
  onStart = s => {
    const link = connectLink(s);
    if (link) void pairWith(link); // the extension doesn't say hello: only the connect page brings it back
  };
  await openProfile(3);
  assert.equal(starts.length, 2);
  assert.equal(connectLink(starts[0]), null, 'paired: started plain');
  assert.ok(starts[0].args.includes(`--user-data-dir=${join(PROFILES_DIR, '1')}`), 'browser 3 is folder 1');
  assert.ok(connectLink(starts[1]), 'then the connect page, to pair it again');
  assert.ok(browserConn(3));
});

test('one that never comes online: a plain error, then no new start for a while; Open (force) tries again', async () => {
  starts.length = 0;
  onStart = () => {}; // Edge refuses the extension: nothing ever connects
  _testing.setWaits(300, 100);
  await assert.rejects(openProfile(4), /didn't connect within/);
  assert.equal(starts.length, 1);
  assert.match(cantOpen(4) ?? '', /didn't connect/);
  await assert.rejects(openProfile(4), /didn't connect within/);
  assert.equal(starts.length, 1, 'backed off: not started again');
  await assert.rejects(openProfile(4, { force: true }), /didn't connect within/);
  assert.equal(starts.length, 2, 'a person pressed Open');
  _testing.reset();
});

test("a new agents' profile: the next number with no folder, its folder made", () => {
  const n = createProfile();
  assert.equal(n, 6);
  assert.ok(existsSync(join(PROFILES_DIR, '6')));
  assert.equal(managedProfile(6)?.paired, false);
  assert.equal(createProfile(), 7, 'two in a row get two numbers');
  _testing.setBrowser(null);
  assert.throws(() => createProfile(), /No browser in tests/);
});

test('no Edge or Chromium: it says so, and nothing starts', async () => {
  starts.length = 0;
  assert.match(cantOpen(2) ?? '', /No browser/);
  await assert.rejects(openProfile(6, { force: true }), /No browser in tests/);
  assert.equal(starts.length, 0);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM passwords WHERE profile = 6")?.n, 0);
});
