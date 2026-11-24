import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createHash } from 'node:crypto';
import { getSecret } from '../vault.js';
import { _testing, addManagedProfile, browserConn, handleBrowserLinkUpgrade, listBrowsers, onBrowserOffline, onBrowserOnline, pairCode, removeBrowser, renameBrowser } from './browser-link.js';

// A real server with the upgrade handler, and Node's own WebSocket as a fake
// extension. Test persona: Sam Rivera's work Chrome.

let server: Server;
let url = '';

before(async () => {
  server = createServer((_req, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket, head) => {
    if (!handleBrowserLinkUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/browser-link`;
});
after(() => server.close());

type Frame = Record<string, any>;

// A fake extension: every frame it gets, in order, and a wait for the next one.
class Ext {
  ws: WebSocket;
  frames: Frame[] = [];
  private waiters: ((f: Frame) => void)[] = [];
  closed: Promise<void>;
  constructor(headers?: Record<string, string>) {
    // Node's WebSocket takes headers through its undici options.
    this.ws = new WebSocket(url, headers ? ({ headers } as any) : undefined);
    this.ws.addEventListener('message', ev => {
      const f = JSON.parse(String(ev.data));
      const w = this.waiters.shift();
      if (w) w(f);
      else this.frames.push(f);
    });
    this.closed = new Promise(r => this.ws.addEventListener('close', () => r()));
  }
  open() {
    return new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('did not open')), { once: true });
    });
  }
  next(): Promise<Frame> {
    const f = this.frames.shift();
    if (f) return Promise.resolve(f);
    return new Promise(r => this.waiters.push(r));
  }
  send(f: Frame) {
    this.ws.send(JSON.stringify(f));
  }
}

async function pair(label = 'Chrome - Sam Rivera') {
  const { code } = pairCode('http://agency.example.test');
  const ext = new Ext();
  await ext.open();
  ext.send({ type: 'pair', code, protocol: 1, version: '0.2.0', browser: 'chrome', label });
  const reply = await ext.next();
  assert.equal(reply.type, 'paired');
  return { ext, token: reply.token as string, n: reply.browser as number };
}

async function hello(token: string) {
  const ext = new Ext();
  await ext.open();
  ext.send({ type: 'hello', token, protocol: 1, version: '0.2.1', browser: 'chrome', label: 'x' });
  return { ext, reply: await ext.next() };
}

const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(r => setTimeout(r, 10));
  }
};

test('pairCode: code shape, address and link', () => {
  const p = pairCode('https://agency.example.test/');
  assert.match(p.code, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(p.url, 'wss://agency.example.test/api/browser-link');
  assert.ok(p.link.startsWith('eaa1:'));
  const body = JSON.parse(Buffer.from(p.link.slice(5), 'base64url').toString('utf8'));
  assert.deepEqual(body, { u: p.url, c: p.code, n: 'EXTREMELY' });
  assert.match(pairCode().url, /^ws:\/\/127\.0\.0\.1:\d+\/api\/browser-link$/);
  process.env.EAA_PUBLIC_URL = 'https://public.example.test';
  try {
    assert.equal(pairCode('http://ignored.example.test').url, 'wss://public.example.test/api/browser-link');
  } finally {
    delete process.env.EAA_PUBLIC_URL;
  }
  assert.throws(() => pairCode('not an address'), /web address/);
});

test('pairCode: a hosted organization’s address', () => {
  const was = process.env.PORT;
  try {
    // Hosted on this computer: the organization's agency gets PORT=5185 (hosting.ts),
    // and the extension connects to it there directly.
    process.env.PORT = '5185';
    assert.equal(pairCode().url, 'ws://127.0.0.1:5185/api/browser-link');
    // Self-hosted: the app passes its host's /hosted, which passes the link on.
    assert.equal(pairCode('https://agency.example.test/hosted').url, 'wss://agency.example.test/hosted/api/browser-link');
    // In the cloud on Railway: its public domain, over wss.
    process.env.RAILWAY_PUBLIC_DOMAIN = 'org-agency.up.railway.example';
    assert.equal(pairCode('http://ignored.example.test').url, 'wss://org-agency.up.railway.example/api/browser-link');
    process.env.EAA_PUBLIC_URL = 'https://agents.example.test';
    assert.equal(pairCode().url, 'wss://agents.example.test/api/browser-link');
  } finally {
    if (was === undefined) delete process.env.PORT;
    else process.env.PORT = was;
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    delete process.env.EAA_PUBLIC_URL;
  }
});

test('pairing with a code works once; the code is spent', async () => {
  const { code } = pairCode();
  const a = new Ext();
  await a.open();
  a.send({ type: 'pair', code: code.toLowerCase(), protocol: 1, version: '0.2.0', browser: 'edge', label: 'Edge - Sam' });
  const ok = await a.next();
  assert.equal(ok.type, 'paired');
  assert.ok(typeof ok.token === 'string' && ok.token.length >= 40);
  assert.equal(ok.name, 'Edge - Sam');
  const listed = listBrowsers().find(b => b.n === ok.browser);
  assert.ok(listed?.online);
  assert.equal(listed?.kind, 'edge');

  const b = new Ext();
  await b.open();
  b.send({ type: 'pair', code, protocol: 1, version: '0.2.0', browser: 'chrome' });
  const refused = await b.next();
  assert.equal(refused.type, 'error');
  assert.match(refused.error, /already used/);
  await b.closed;
  a.ws.close();
  await a.closed;
  removeBrowser(ok.browser);
});

test('a run of wrong codes cancels the open ones: no guessing a code from the network', async () => {
  const { code } = pairCode();
  for (let i = 0; i < 10; i++) {
    const g = new Ext();
    await g.open();
    g.send({ type: 'pair', code: 'ZZZZ-ZZZZ', protocol: 1, version: '0.2.0', browser: 'chrome' });
    assert.equal((await g.next()).type, 'error');
    await g.closed;
  }
  const late = new Ext();
  await late.open();
  late.send({ type: 'pair', code, protocol: 1, version: '0.2.0', browser: 'chrome' });
  const f = await late.next();
  assert.equal(f.type, 'error', 'the real code was cancelled too');
  await late.closed;
  // A new code works again.
  const { ext, n } = await pair();
  ext.ws.close();
  await ext.closed;
  removeBrowser(n);
});

test('an expired code is refused', async () => {
  _testing.setCodeTtlMs(1);
  const { code } = pairCode();
  _testing.setCodeTtlMs(10 * 60_000);
  await new Promise(r => setTimeout(r, 10));
  const e = new Ext();
  await e.open();
  e.send({ type: 'pair', code, protocol: 1, version: '0.2.0', browser: 'chrome' });
  const f = await e.next();
  assert.equal(f.type, 'error');
  assert.match(f.error, /expired/);
  await e.closed;
});

test('hello with the token: online and listed; a wrong token is refused', async () => {
  const p = await pair();
  p.ext.ws.close();
  await p.ext.closed;
  await until(() => !listBrowsers().find(b => b.n === p.n)?.online);

  const { ext, reply } = await hello(p.token);
  assert.deepEqual(reply, { type: 'hello-ok', browser: p.n, name: 'Chrome - Sam Rivera', protocol: 1 });
  const b = listBrowsers().find(x => x.n === p.n)!;
  assert.equal(b.online, true);
  assert.equal(b.version, '0.2.1');
  assert.ok(b.since && b.lastSeen);
  assert.ok(browserConn(p.n));

  renameBrowser(p.n, '  Sam   work ');
  assert.equal(listBrowsers().find(x => x.n === p.n)!.name, 'Sam work');

  ext.send({ type: 'ping' });
  assert.deepEqual(await ext.next(), { type: 'pong' });

  const bad = await hello('A'.repeat(43));
  assert.equal(bad.reply.type, 'error');
  await bad.ext.closed;

  ext.ws.close();
  await ext.closed;
  removeBrowser(p.n);
});

test('an unknown protocol is told to update', async () => {
  const e = new Ext();
  await e.open();
  e.send({ type: 'hello', token: 'x', protocol: 99 });
  const f = await e.next();
  assert.deepEqual(f, { type: 'error', error: 'Update the EXTREMELY extension' });
  await e.closed;
});

test('ExtensionCdp: commands, answers, errors and events', async () => {
  const p = await pair();
  const conn = browserConn(p.n)!;
  assert.ok(conn);

  const answer = conn.send('Page.navigate', { url: 'https://shop.example.test' }, 't:12');
  const cmd = await p.ext.next();
  assert.deepEqual({ method: cmd.method, params: cmd.params, sessionId: cmd.sessionId }, { method: 'Page.navigate', params: { url: 'https://shop.example.test' }, sessionId: 't:12' });
  p.ext.send({ id: cmd.id, result: { frameId: 'f1' } });
  assert.deepEqual(await answer, { frameId: 'f1' });

  const noSession = conn.send('Target.getTargets');
  const cmd2 = await p.ext.next();
  assert.equal('sessionId' in cmd2, false);
  p.ext.send({ id: cmd2.id, error: { message: 'Not an agent tab' } });
  await assert.rejects(noSession, /Not an agent tab/);

  const got: [unknown, string | undefined][] = [];
  const off = conn.on('Page.loadEventFired', (params, sessionId) => got.push([params, sessionId]));
  p.ext.send({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 't:12' });
  p.ext.send({ method: 'Target.targetDestroyed', params: { targetId: 't:12' } });
  await until(() => got.length === 1);
  assert.deepEqual(got[0], [{ timestamp: 1 }, 't:12']);
  off();

  await assert.rejects(conn.send('Page.reload', {}, 't:12', 50), /didn't answer Page\.reload/);

  // The socket closes: waiting calls fail, onClose and offline fire.
  let offline = 0;
  let closed = 0;
  const stop = onBrowserOffline(n => n === p.n && offline++);
  conn.onClose(() => closed++);
  const waiting = conn.send('Runtime.evaluate', { expression: '1' }, 't:12');
  await p.ext.next();
  p.ext.ws.close();
  await assert.rejects(waiting, /went offline/);
  await until(() => offline === 1 && closed === 1);
  assert.equal(conn.closed, true);
  assert.equal(browserConn(p.n), null);
  await assert.rejects(conn.send('Page.reload'), /went offline/);
  stop();
  removeBrowser(p.n);
});

test('a second connection for the same browser replaces the first', async () => {
  const p = await pair();
  const first = browserConn(p.n)!;
  let online = 0;
  let offline = 0;
  const a = onBrowserOnline(n => n === p.n && online++);
  const b = onBrowserOffline(n => n === p.n && offline++);

  const second = await hello(p.token);
  assert.equal(second.reply.type, 'hello-ok');
  const old = await p.ext.next();
  assert.equal(old.type, 'error');
  await p.ext.closed;
  await until(() => first.closed);
  assert.equal(online, 1);
  assert.equal(offline, 0);
  assert.notEqual(browserConn(p.n), first);
  assert.ok(listBrowsers().find(x => x.n === p.n)?.online);
  a();
  b();
  second.ext.ws.close();
  await second.ext.closed;
  removeBrowser(p.n);
});

// Connect this browser again, in a browser that's paired already: the extension sends
// the token it holds with the new code. It used to get a new number while the old one
// stayed listed, offline for good, so the app said the browser wasn't connected.
test('pairing again from a paired browser keeps its number, and it is online', async () => {
  const p = await pair('Chrome - Sam Rivera');
  renameBrowser(p.n, 'Sam work');
  const before = listBrowsers().find(b => b.n === p.n)!;
  const count = listBrowsers().length;
  let offline = 0;
  const off = onBrowserOffline(n => n === p.n && offline++);
  await new Promise(r => setTimeout(r, 5)); // a later pairing time

  const { code } = pairCode('http://agency.example.test');
  const again = new Ext();
  await again.open();
  again.send({ type: 'pair', code, token: p.token, protocol: 1, version: '0.2.1', browser: 'chrome', label: 'Chrome - Sam Rivera' });
  const reply = await again.next();
  assert.equal(reply.type, 'paired');
  assert.equal(reply.browser, p.n, 'the same number');
  assert.equal(reply.name, 'Sam work', 'its name kept');
  assert.notEqual(reply.token, p.token, 'a new token');

  // The old connection is replaced, never left behind offline.
  const old = await p.ext.next();
  assert.equal(old.type, 'error');
  await p.ext.closed;
  assert.equal(listBrowsers().length, count, 'no second browser');
  const now = listBrowsers().find(b => b.n === p.n)!;
  assert.ok(now.online, 'online');
  assert.equal(now.version, '0.2.1');
  assert.ok(now.paired > before.paired, 'paired again: the app knows it just connected');
  assert.equal(offline, 0);

  // The old token is spent; the new one says hello.
  const stale = await hello(p.token);
  assert.equal(stale.reply.type, 'error');
  await stale.ext.closed;
  again.ws.close();
  await again.closed;
  const back = await hello(reply.token);
  assert.equal(back.reply.type, 'hello-ok');
  assert.equal(back.reply.browser, p.n);
  off();
  back.ext.ws.close();
  await back.ext.closed;
  removeBrowser(p.n);
});

test('pairing with a token the agency does not know: a new browser', async () => {
  const { code } = pairCode('http://agency.example.test');
  const ext = new Ext();
  await ext.open();
  ext.send({ type: 'pair', code, token: 'x'.repeat(43), protocol: 1, version: '0.2.0', browser: 'chrome', label: 'Chrome - Sam' });
  const reply = await ext.next();
  assert.equal(reply.type, 'paired');
  assert.ok(listBrowsers().find(b => b.n === reply.browser)?.online);
  ext.ws.close();
  await ext.closed;
  removeBrowser(reply.browser);
});

// Pairing again, the cases around it: nothing else may move.

async function pairAgain(token: string | undefined, opts: { browser?: number } = {}) {
  const { code } = pairCode(opts.browser != null ? { browser: opts.browser, local: true } : 'http://agency.example.test');
  const ext = new Ext();
  await ext.open();
  ext.send({ type: 'pair', code, protocol: 1, version: '0.2.1', browser: 'chrome', label: 'Chrome - Sam Rivera', ...(token ? { token } : {}) });
  const reply = await ext.next();
  assert.equal(reply.type, 'paired');
  return { ext, token: reply.token as string, n: reply.browser as number };
}
const row = (n: number) => listBrowsers().find(b => b.n === n);
const quiet = () => new Promise(r => setTimeout(r, 50));

test('two browsers: each pairs again into its own number, and the other is left alone', async () => {
  const work = await pair('Chrome - Sam work');
  const home = await pair('Edge - Sam home');
  const homeConn = browserConn(home.n);
  const count = listBrowsers().length;

  const work2 = await pairAgain(work.token);
  assert.equal(work2.n, work.n);
  assert.equal((await work.ext.next()).type, 'error'); // work's old connection replaced
  await quiet();
  assert.equal(home.ext.frames.length, 0, 'nothing sent to the other browser');
  assert.equal(browserConn(home.n), homeConn, "the other browser's connection kept");
  assert.ok(row(home.n)?.online);

  const home2 = await pairAgain(home.token);
  assert.equal(home2.n, home.n);
  assert.ok(row(work.n)?.online, 'the first is still online');
  assert.equal(listBrowsers().length, count, 'no new browsers');
  // Each new token is its own browser's.
  for (const x of [work2, home2]) x.ext.ws.close();
  await Promise.all([work2.ext.closed, home2.ext.closed]);
  const a = await hello(work2.token);
  const b = await hello(home2.token);
  assert.equal(a.reply.browser, work.n);
  assert.equal(b.reply.browser, home.n);
  for (const x of [a, b]) x.ext.ws.close();
  await Promise.all([a.ext.closed, b.ext.closed]);
  removeBrowser(work.n);
  removeBrowser(home.n);
});

test('paired again, then the connection drops: it comes back on the new token, same number', async () => {
  const p = await pair();
  const again = await pairAgain(p.token);
  let offline = 0;
  const off = onBrowserOffline(n => n === p.n && offline++);
  again.ext.ws.close(); // the laptop slept, the agency restarted, ...
  await again.ext.closed;
  await until(() => offline === 1);
  assert.equal(row(p.n)?.online, false);
  const back = await hello(again.token);
  assert.equal(back.reply.type, 'hello-ok');
  assert.equal(back.reply.browser, p.n);
  assert.ok(row(p.n)?.online);
  off();
  back.ext.ws.close();
  await back.ext.closed;
  removeBrowser(p.n);
});

test('pairing again while it is offline: same number, online', async () => {
  const p = await pair();
  p.ext.ws.close();
  await p.ext.closed;
  await until(() => row(p.n)?.online === false);
  const count = listBrowsers().length;
  const again = await pairAgain(p.token);
  assert.equal(again.n, p.n);
  assert.ok(row(p.n)?.online);
  assert.equal(listBrowsers().length, count);
  again.ext.ws.close();
  await again.ext.closed;
  removeBrowser(p.n);
});

test('pairing again and again: the same number every time; only the newest token works', async () => {
  const p = await pair();
  let token = p.token;
  const spent: string[] = [];
  for (let i = 0; i < 3; i++) {
    const again = await pairAgain(token);
    assert.equal(again.n, p.n);
    spent.push(token);
    token = again.token;
    again.ext.ws.close();
    await again.ext.closed;
  }
  for (const old of spent) {
    const h = await hello(old);
    assert.equal(h.reply.type, 'error');
    await h.ext.closed;
  }
  const h = await hello(token);
  assert.equal(h.reply.browser, p.n);
  h.ext.ws.close();
  await h.ext.closed;
  removeBrowser(p.n);
});

test('the new token is the one saved, so it still works after the agency restarts', async () => {
  const p = await pair();
  const again = await pairAgain(p.token);
  const saved = await getSecret<{ browsers: { n: number; tokenHash: string }[] }>('browser-link');
  const mine = saved?.browsers.find(b => b.n === p.n);
  assert.equal(mine?.tokenHash, createHash('sha256').update(again.token).digest('hex'));
  again.ext.ws.close();
  await again.ext.closed;
  removeBrowser(p.n);
});

test('extension removed and added back (it has no token): a new browser; the old one is left as it was', async () => {
  const p = await pair('Chrome - Sam Rivera');
  p.ext.ws.close();
  await p.ext.closed;
  await until(() => row(p.n)?.online === false);
  const fresh = await pairAgain(undefined);
  assert.notEqual(fresh.n, p.n);
  assert.ok(row(fresh.n)?.online);
  assert.equal(row(p.n)?.online, false, 'the old one is untouched, for the person to remove');
  const old = await hello(p.token); // its old token is untouched too
  assert.equal(old.reply.browser, p.n);
  for (const x of [fresh.ext, old.ext]) x.ws.close();
  await Promise.all([fresh.ext.closed, old.ext.closed]);
  removeBrowser(p.n);
  removeBrowser(fresh.n);
});

test('removed from EXTREMELY, then paired again with its old token: a browser of its own, nothing else taken', async () => {
  const other = await pair('Edge - Sam home');
  const p = await pair();
  removeBrowser(p.n);
  await p.ext.closed;
  const again = await pairAgain(p.token);
  assert.notEqual(again.n, other.n);
  assert.ok(row(again.n)?.online);
  assert.ok(row(other.n)?.online, 'the other browser is left alone');
  for (const x of [again.ext, other.ext]) x.ws.close();
  await Promise.all([again.ext.closed, other.ext.closed]);
  removeBrowser(again.n);
  removeBrowser(other.n);
});

test("an agents' profile's code goes to that profile, whatever token comes with it", async () => {
  await addManagedProfile({ n: 40, dir: 'test-40', name: 'Agents 40', kind: 'chrome' });
  const person = await pair('Chrome - Sam Rivera');
  // A token for the person's browser, sent with the profile's code: the profile pairs, the person's browser keeps its own.
  const prof = await pairAgain(person.token, { browser: 40 });
  assert.equal(prof.n, 40);
  await quiet();
  assert.equal(person.ext.frames.length, 0);
  assert.ok(row(person.n)?.online);
  // And the profile, paired again with its own token, stays 40.
  prof.ext.ws.close();
  await prof.ext.closed;
  const prof2 = await pairAgain(prof.token, { browser: 40 });
  assert.equal(prof2.n, 40);
  const p2 = await pairAgain(prof2.token); // even from a plain code
  assert.equal(p2.n, 40);
  for (const x of [person.ext, p2.ext]) x.ws.close();
  await Promise.all([person.ext.closed, p2.ext.closed]);
  removeBrowser(person.n);
  removeBrowser(40);
});

test('removeBrowser closes the live socket and the token stops working', async () => {
  const p = await pair();
  removeBrowser(p.n);
  const f = await p.ext.next();
  assert.equal(f.type, 'error');
  assert.match(f.error, /removed/);
  await p.ext.closed;
  assert.equal(listBrowsers().some(b => b.n === p.n), false);
  const again = await hello(p.token);
  assert.equal(again.reply.type, 'error');
  await again.ext.closed;
  assert.throws(() => removeBrowser(p.n), /isn't paired/);
});

test('browser numbers: the lowest free one', async () => {
  const one = await pair('one');
  const two = await pair('two');
  assert.equal(two.n, one.n + 1);
  removeBrowser(one.n);
  const three = await pair('three');
  assert.equal(three.n, one.n);
  for (const x of [two, three]) removeBrowser(x.n);
});

test("a web page's origin is refused", async () => {
  const e = new Ext({ origin: 'https://evil.example.test' });
  await assert.rejects(e.open());
  const ok = new Ext({ origin: 'chrome-extension://abcdefghijklmnop' });
  await ok.open();
  ok.ws.close();
});

test('a connection with no first frame is closed', async () => {
  _testing.setFirstFrameMs(50);
  try {
    const e = new Ext();
    await e.open();
    const f = await e.next();
    assert.equal(f.type, 'error');
    await e.closed;
  } finally {
    _testing.setFirstFrameMs(10_000);
  }
});

test('other paths are left to the caller', async () => {
  const ws = new WebSocket(url.replace('/api/browser-link', '/elsewhere'));
  await new Promise<void>(r => ws.addEventListener('error', () => r(), { once: true }));
});
