import './test-data-dir.js';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { WebSocket as WsClient } from 'ws';
import { forwardLinkUpgrade, LINK_PATH, startLinkFront } from './link-forward.js';
import { browserConn, handleBrowserLinkUpgrade, listBrowsers, pairCode, removeBrowser } from './runner/browser-link.js';

// The browser link through its forwarding hops (link-forward.ts): a cloud container's
// public front, and the person's own agency passing /hosted/api/browser-link on to the
// organization it hosts. Node's WebSocket plays the extension. Test persona: Sam
// Rivera's work Chrome.

const portOf = (s: Server) => (s.address() as AddressInfo).port;
const listen = (s: Server) => new Promise<Server>(r => s.listen(0, '127.0.0.1', () => r(s)));

let agency: Server; // the agency: the link itself
let front: Server; // the container's public front, to the agency
let host: Server; // the person's own agency, /hosted/... to the agency
let twoHops: Server; // a front to a hop to the agency
let middle: Server;

before(async () => {
  agency = createServer((_q, res) => res.writeHead(404).end());
  agency.on('upgrade', (req, socket, head) => {
    if (!handleBrowserLinkUpgrade(req, socket, head)) socket.destroy();
  });
  await listen(agency);
  front = await startLinkFront(0, portOf(agency), '127.0.0.1');
  host = createServer((_q, res) => res.writeHead(404).end());
  host.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname === `/hosted${LINK_PATH}`) return forwardLinkUpgrade(req, socket, head, portOf(agency));
    socket.destroy();
  });
  await listen(host);
  middle = createServer((_q, res) => res.writeHead(404).end());
  middle.on('upgrade', (req, socket, head) => forwardLinkUpgrade(req, socket, head, portOf(agency)));
  await listen(middle);
  twoHops = await startLinkFront(0, portOf(middle), '127.0.0.1');
});
after(() => {
  for (const s of [agency, front, host, middle, twoHops]) s.closeAllConnections?.(), s.close();
});

type Frame = Record<string, any>;

class Ext {
  ws: WebSocket;
  frames: Frame[] = [];
  private waiters: ((f: Frame) => void)[] = [];
  closed: Promise<number>;
  constructor(url: string, origin = 'chrome-extension://abcdefghijklmnop') {
    this.ws = new WebSocket(url, { headers: { origin } } as any);
    this.ws.addEventListener('message', ev => {
      const f = JSON.parse(String(ev.data));
      const w = this.waiters.shift();
      if (w) w(f);
      else this.frames.push(f);
    });
    this.closed = new Promise(r => this.ws.addEventListener('close', ev => r(ev.code)));
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

// Pairs through `url`, answers one command the agency sends, says hello again on a
// new connection, and is removed: the refusal and the close come back through the hop.
async function roundtrip(url: string) {
  const { code } = pairCode(url.replace(/^ws/, 'http').replace(LINK_PATH, ''));
  const ext = new Ext(url);
  await ext.open();
  ext.send({ type: 'pair', code, protocol: 1, version: '0.2.0', browser: 'chrome', label: 'Chrome - Sam Rivera' });
  const paired = await ext.next();
  assert.equal(paired.type, 'paired');
  const n = paired.browser as number;
  assert.ok(listBrowsers().find(b => b.n === n)?.online);

  // A command from the agency, answered by the extension.
  const answer = browserConn(n)!.send<{ product: string }>('Browser.getVersion');
  const cmd = await ext.next();
  assert.equal(cmd.method, 'Browser.getVersion');
  ext.send({ id: cmd.id, result: { product: 'Chrome/140', protocolVersion: '1.3' } });
  assert.equal((await answer).product, 'Chrome/140');
  ext.send({ type: 'ping' });
  assert.equal((await ext.next()).type, 'pong');

  // Back later with its token, as after a worker restart.
  ext.ws.close();
  await ext.closed;
  const again = new Ext(url);
  await again.open();
  again.send({ type: 'hello', token: paired.token, protocol: 1, version: '0.2.0', browser: 'chrome', label: 'x' });
  assert.equal((await again.next()).type, 'hello-ok');
  // Events reach the agency's listeners too.
  const seen = new Promise(r => browserConn(n)!.on('Target.targetCreated', p => r(p)));
  again.send({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 't:5' } } });
  assert.deepEqual(await seen, { targetInfo: { targetId: 't:5' } });

  removeBrowser(n);
  const refused = await again.next();
  assert.equal(refused.type, 'error');
  assert.match(refused.error, /removed/);
  assert.equal(await again.closed, 1008); // the agency's close code, passed on
}

test('cloud front: a browser pairs, gets a command and stays connected', async () => {
  await roundtrip(`ws://127.0.0.1:${portOf(front)}${LINK_PATH}`);
});

test('the person’s own agency: /hosted/api/browser-link reaches the hosted organization', async () => {
  await roundtrip(`ws://127.0.0.1:${portOf(host)}/hosted${LINK_PATH}`);
});

test('every hop: a front in front of another hop', async () => {
  await roundtrip(`ws://127.0.0.1:${portOf(twoHops)}${LINK_PATH}`);
});

test('the front opens nothing but the link', async () => {
  const base = `127.0.0.1:${portOf(front)}`;
  for (const path of ['/', '/api/browser', '/api/settings', '/browser/connect']) assert.equal((await fetch(`http://${base}${path}`)).status, 404, path);
  const other = new Ext(`ws://${base}/api/other`);
  await assert.rejects(other.open());
});

test('the link’s own checks still hold behind the hop', async () => {
  // A web page's origin: the agency refuses it, and the hop says the same.
  const status = await new Promise<number>(r => {
    const c = new WsClient(`ws://127.0.0.1:${portOf(front)}${LINK_PATH}`, { origin: 'https://evil.example.test' });
    c.on('unexpected-response', (_q, res) => r(res.statusCode ?? 0));
    c.on('error', () => r(-1));
  });
  assert.equal(status, 403);
  // A wrong code: refused by the link, not by the hop.
  const guess = new Ext(`ws://127.0.0.1:${portOf(front)}${LINK_PATH}`);
  await guess.open();
  guess.send({ type: 'pair', code: 'AAAA-BBBB', protocol: 1, version: '0.2.0', browser: 'chrome' });
  assert.equal((await guess.next()).type, 'error');
  await guess.closed;
});

test('the agency not up yet: the hop refuses, so the extension tries again later', async () => {
  const closed = createServer();
  await listen(closed);
  const dead = portOf(closed);
  await new Promise(r => closed.close(r));
  const lone = await startLinkFront(0, dead, '127.0.0.1');
  try {
    const ext = new Ext(`ws://127.0.0.1:${portOf(lone)}${LINK_PATH}`);
    await assert.rejects(ext.open());
  } finally {
    lone.close();
  }
});
