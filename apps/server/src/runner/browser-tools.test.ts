import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { before, test } from 'node:test';
import { __setBrowserConnForTest, __setFfmpegForTest, agentTabCount, cleanUpBrowsers, SIGNED_IN_TOOLS } from './browser.js';
import { keyCombo, MODIFIER, type CdpConn } from './cdp.js';
import { decodePng, encodeGif } from './gif.js';
import { rpc } from './mcp.js';
import { keepRecentImages } from './run.js';
import { resetDbForTests } from './db.js';
import { runEnded, WORKSPACES, type RunCtx } from './tools.js';
import type { Msg } from './providers.js';

// The browser tools past numbered clicks (screenshots, coordinates, keys, tabs,
// console, network, recording), against a fake of the DevTools browser the extension
// emulates: what the tools send it, and what the agent is told.

type Tab = { url: string; attached: boolean; title?: string };
type Call = { method: string; params: Record<string, any>; sessionId?: string };

// A small PNG (RGB), for the fake's PNG screenshots: what gif.ts reads back.
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number], filter = 0): Buffer {
  const rows: number[] = [];
  const at = (x: number, y: number, c: number) => (x < 0 || y < 0 ? 0 : pixel(x, y)[c]);
  for (let y = 0; y < height; y++) {
    rows.push(filter);
    for (let x = 0; x < width; x++)
      for (let c = 0; c < 3; c++) {
        const v = at(x, y, c), a = at(x - 1, y, c), b = at(x, y - 1, c), cc = at(x - 1, y - 1, c);
        const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
        const pred = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : cc) : 0;
        rows.push((v - pred) & 255);
      }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); // CRC unchecked by the reader
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))]);
}

class FakeBrowser implements CdpConn {
  closed = false;
  tabs = new Map<string, Tab>();
  calls: Call[] = [];
  // What the page says, by test.
  hasText = false;
  shotSeq = 0;
  private seq = 0;
  private listeners = new Map<string, Set<(p: any, s?: string) => void>>();
  on(method: string, fn: (p: any, s?: string) => void) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method)!.add(fn);
    return () => void this.listeners.get(method)?.delete(fn);
  }
  onClose() {}
  close() {
    this.closed = true;
  }
  emit(method: string, params: unknown, sessionId?: string) {
    for (const fn of this.listeners.get(method) ?? []) fn(params, sessionId);
  }
  of(method: string) {
    return this.calls.filter(c => c.method === method);
  }
  since(n: number) {
    return this.calls.slice(n);
  }
  async send<T = any>(method: string, params: Record<string, any> = {}, sessionId?: string): Promise<T> {
    if (this.closed) throw new Error('The browser closed.');
    this.calls.push({ method, params, sessionId });
    return this.answer(method, params, sessionId) as T;
  }
  private answer(method: string, p: Record<string, any>, sessionId?: string): unknown {
    if (!sessionId) {
      switch (method) {
        case 'Target.createTarget': {
          const id = `t:${++this.seq}`;
          this.tabs.set(id, { url: p.url, attached: false });
          return { targetId: id };
        }
        case 'Target.attachToTarget':
          this.tabs.get(p.targetId)!.attached = true;
          return { sessionId: p.targetId };
        case 'Target.detachFromTarget': {
          const t = this.tabs.get(p.sessionId);
          if (t) t.attached = false;
          this.emit('Target.detachedFromTarget', { sessionId: p.sessionId, targetId: p.sessionId });
          return {};
        }
        case 'Target.closeTarget':
          if (!this.tabs.delete(p.targetId)) throw new Error('Not an agent tab');
          this.emit('Target.targetDestroyed', { targetId: p.targetId });
          return { success: true };
        case 'Target.getTargets':
          return { targetInfos: [...this.tabs].map(([targetId, t]) => ({ targetId, type: 'page', url: t.url, title: t.title ?? '', attached: t.attached })) };
        case 'Target.getTargetInfo':
          return { targetInfo: { targetId: p.targetId, type: 'page', url: this.tabs.get(p.targetId)?.url ?? '', title: this.tabs.get(p.targetId)?.title ?? '' } };
        default:
          return {};
      }
    }
    const t = this.tabs.get(sessionId);
    if (!t?.attached) throw new Error('Debugger is not attached to the tab');
    switch (method) {
      case 'Page.navigate':
        t.url = p.url;
        t.title = `Page at ${p.url}`;
        return {};
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: `f-${sessionId}`, url: t.url }, childFrames: [] } };
      case 'Page.createIsolatedWorld':
        return { executionContextId: 7 };
      case 'Page.getNavigationHistory':
        return { currentIndex: 0, entries: [{ id: 1 }, { id: 2 }] };
      case 'Page.captureScreenshot':
        return { data: p.format === 'png' ? png(4, 3, (x, y) => [x * 60, y * 100, this.shotSeq++ % 2 ? 255 : 0]).toString('base64') : Buffer.from('jpeg-bytes').toString('base64') };
      case 'Network.getResponseBody':
        return { body: '{"ok":true}', base64Encoded: false };
      case 'Runtime.evaluate':
        return { result: { value: this.evaluate(String(p.expression), t) } };
      default:
        return {};
    }
  }
  private evaluate(expr: string, t: Tab) {
    // Where a drag goes (measured without scrolling).
    if (expr.includes('w: innerWidth, h: innerHeight') && expr.includes('getBoundingClientRect')) return { x: 600, y: 300, w: 1000, h: 800 };
    if (expr === 'void 0') return undefined;
    const call = expr.includes('window.__eaa') && expr.includes('})().') ? expr.slice(expr.lastIndexOf('})().') + 5) : expr;
    if (call.startsWith('view(')) return { title: 'A page', text: 'Some text', items: ['[1] button "Send"', '[2] text field "Email"'] };
    if (call.startsWith('search(')) return call.includes('"email"') ? { hits: ['[2] text field "Email"'], total: 1 } : { hits: [], total: 0 };
    if (call.startsWith('settle(') || call.startsWith('find(')) return true;
    if (expr === 'document.readyState') return 'complete';
    if (expr === 'location.href') return t.url;
    if (expr.includes('scrollX')) return { x: 0, y: 100, w: 1000, h: 800, cw: 1000, ch: 3000, dpr: 2 };
    if (expr.includes('width: r.width')) return { x: 40, y: 50, width: 200, height: 100 }; // an element's box
    if (expr.includes('elementFromPoint')) return { x: 140, y: 100 }; // a click's point
    if (expr.includes('innerWidth')) return { w: 1000, h: 800 };
    if (expr.includes('.toLowerCase().includes(')) return this.hasText;
    if (expr === 'document.title') return t.title ?? '';
    if (expr.includes('outerHTML')) return '';
    return null;
  }
}

const agent = (id: string, name: string) => ({ id, name, tiers: {} });
const ctx = (runId: string, a = agent('zz-tools-a', 'Tester')) => ({ agent: a, runId, level: 0, now: () => Date.now(), fleet: async () => [], wake: () => {} }) as unknown as RunCtx;
const tool = (name: string) => SIGNED_IN_TOOLS.find(t => t.id === `signed_in_browser.${name}`)!;
const call = (name: string, args: Record<string, unknown>, c: RunCtx) => Promise.resolve(tool(name).impl(args, c));
const mouse = (b: FakeBrowser, from: number) => b.since(from).filter(c => c.method === 'Input.dispatchMouseEvent').map(c => c.params);
const keys = (b: FakeBrowser, from: number) => b.since(from).filter(c => c.method === 'Input.dispatchKeyEvent').map(c => c.params);

const b = new FakeBrowser();
before(async () => {
  resetDbForTests();
  await __setBrowserConnForTest(1, b, 'Chrome - Tests');
});

test('click at a point: a right double click with ctrl+shift held, each press counting up', async () => {
  const c = ctx('r-click');
  await call('open', { url: 'https://example.com/' }, c);
  const from = b.calls.length;
  await call('click', { x: 100, y: 200, button: 'right', count: 2, modifiers: 'ctrl+shift' }, c);
  const mods = MODIFIER.ctrl | MODIFIER.shift;
  assert.deepEqual(mouse(b, from), [
    { type: 'mouseMoved', x: 100, y: 200, modifiers: mods },
    { type: 'mousePressed', x: 100, y: 200, button: 'right', clickCount: 1, buttons: 2, modifiers: mods },
    { type: 'mouseReleased', x: 100, y: 200, button: 'right', clickCount: 1, modifiers: mods },
    { type: 'mousePressed', x: 100, y: 200, button: 'right', clickCount: 2, buttons: 2, modifiers: mods },
    { type: 'mouseReleased', x: 100, y: 200, button: 'right', clickCount: 2, modifiers: mods },
  ]);
  // A numbered click is as it was: one left click where the element is.
  const at = b.calls.length;
  await call('click', { ref: 1 }, c);
  assert.deepEqual(mouse(b, at).map(m => [m.type, m.x, m.y, m.button, m.clickCount]), [['mouseMoved', 140, 100, undefined, undefined], ['mousePressed', 140, 100, 'left', 1], ['mouseReleased', 140, 100, 'left', 1]]);
  await assert.rejects(call('click', {}, c), /Give ref \(a number from the page\) or x and y/);
  await assert.rejects(call('click', { x: 1, y: 1, count: 4 }, c), /count: 1, 2/);
  await assert.rejects(call('click', { x: 1, y: 1, modifiers: 'hyper' }, c), /"hyper" isn't one/);
  await runEnded('r-click');
});

test('key combinations: names to key, code, key code, text and modifier bits', () => {
  const a = keyCombo('ctrl+a');
  assert.equal(a.modifiers, MODIFIER.ctrl);
  assert.deepEqual(a.key, { key: 'a', code: 'KeyA', vk: 65 }, 'a shortcut types nothing');
  assert.deepEqual(a.commands, ['selectAll']);
  const tab = keyCombo('shift+Tab');
  assert.equal(tab.modifiers, MODIFIER.shift);
  assert.equal(tab.key!.key, 'Tab');
  assert.equal(tab.key!.vk, 9);
  const enter = keyCombo('cmd+Enter');
  assert.equal(enter.modifiers, MODIFIER.meta);
  assert.equal(enter.key!.text, '\r');
  assert.deepEqual(keyCombo('Esc').key, { key: 'Escape', code: 'Escape', vk: 27, text: undefined });
  assert.deepEqual(keyCombo('shift+a').key, { key: 'A', code: 'KeyA', vk: 65, text: 'A' });
  assert.deepEqual(keyCombo('shift+1').key, { key: '!', code: 'Digit1', vk: 49, text: '!' });
  assert.equal(keyCombo('ctrl++').key!.code, 'Equal');
  assert.equal(keyCombo('F5').key!.vk, 116);
  assert.equal(keyCombo('ctrl+shift+v').commands, undefined, 'paste is never sent as a command too');
  assert.throws(() => keyCombo('ctrl+banana'), /"banana" isn't a key I know/);
  assert.throws(() => keyCombo('a+b'), /"a" in "a\+b" isn't a modifier/);
});

test('press: modifiers down, the key, modifiers up - repeated; the old fixed keys still work', async () => {
  const c = ctx('r-press');
  await call('open', { url: 'https://example.com/' }, c);
  let from = b.calls.length;
  await call('press', { key: 'ctrl+a' }, c);
  assert.deepEqual(
    keys(b, from).map(k => [k.type, k.key, k.modifiers, k.text, k.commands]),
    [
      ['rawKeyDown', 'Control', MODIFIER.ctrl, undefined, undefined],
      ['rawKeyDown', 'a', MODIFIER.ctrl, undefined, ['selectAll']],
      ['keyUp', 'a', MODIFIER.ctrl, undefined, undefined],
      ['keyUp', 'Control', 0, undefined, undefined],
    ],
  );
  from = b.calls.length;
  await call('press', { key: 'ArrowDown', repeat: 3 }, c);
  assert.deepEqual(keys(b, from).map(k => `${k.type} ${k.key} ${k.windowsVirtualKeyCode}`), ['rawKeyDown ArrowDown 40', 'keyUp ArrowDown 40', 'rawKeyDown ArrowDown 40', 'keyUp ArrowDown 40', 'rawKeyDown ArrowDown 40', 'keyUp ArrowDown 40']);
  from = b.calls.length;
  await call('press', { key: 'Space' }, c);
  assert.deepEqual(keys(b, from).map(k => [k.type, k.key, k.code, k.text]), [['keyDown', ' ', 'Space', ' '], ['keyUp', ' ', 'Space', undefined]]);
  await assert.rejects(call('press', { key: 'Enter', repeat: 51 }, c), /repeat: a whole number from 1 to 50/);
  await runEnded('r-press');
});

test('hover and drag: the mouse moves there; a drag presses, moves in steps holding the button, and lets go', async () => {
  const c = ctx('r-drag');
  await call('open', { url: 'https://example.com/board' }, c);
  let from = b.calls.length;
  await call('hover', { ref: 1 }, c);
  assert.deepEqual(mouse(b, from), [{ type: 'mouseMoved', x: 140, y: 100 }]);
  from = b.calls.length;
  await call('drag', { from_x: 10, from_y: 20, to_x: 130, to_y: 20 }, c);
  const m = mouse(b, from);
  assert.deepEqual(m[0], { type: 'mouseMoved', x: 10, y: 20 });
  assert.deepEqual(m[1], { type: 'mousePressed', x: 10, y: 20, button: 'left', buttons: 1, clickCount: 1 });
  const moves = m.slice(2, -1);
  assert.equal(moves.length, 12);
  assert.ok(moves.every(x => x.type === 'mouseMoved' && x.buttons === 1));
  assert.deepEqual(moves.map(x => x.x), [20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130]);
  assert.deepEqual(m.at(-1), { type: 'mouseReleased', x: 130, y: 20, button: 'left', buttons: 0, clickCount: 1 });
  // From a number to a number: where it goes is measured without scrolling.
  from = b.calls.length;
  await call('drag', { from_ref: 1, to_ref: 2 }, c);
  const r = mouse(b, from);
  assert.deepEqual([r[1].x, r[1].y, r.at(-1)!.x, r.at(-1)!.y], [140, 100, 600, 300]);
  await runEnded('r-drag');
});

test('resize: a device-metrics override on the tab (never the window), and reset clears it', async () => {
  const c = ctx('r-size');
  await call('open', { url: 'https://example.com/' }, c);
  const out = await call('resize', { preset: 'mobile' }, c);
  assert.match(out, /390x844 \(as a phone/);
  assert.deepEqual(b.of('Emulation.setDeviceMetricsOverride').at(-1)!.params, { width: 390, height: 844, deviceScaleFactor: 0, mobile: true });
  assert.equal(b.of('Browser.setWindowBounds').length, 0, "the window is the person's");
  await call('resize', { width: 1200, height: 700 }, c);
  assert.deepEqual(b.of('Emulation.setDeviceMetricsOverride').at(-1)!.params, { width: 1200, height: 700, deviceScaleFactor: 0, mobile: false });
  await call('resize', { reset: true }, c);
  assert.equal(b.of('Emulation.clearDeviceMetricsOverride').length, 1);
  await assert.rejects(call('resize', { width: 50, height: 50 }, c), /200 to 4000/);
  await runEnded('r-size');
});

test('tabs: open, list, switch, close; a tab kept open outlives the run, the sweep and is the agent\'s next run\'s', async () => {
  const c = ctx('r-tabs');
  await call('open', { url: 'https://example.com/one' }, c);
  const opened = await call('tabs', { action: 'open', url: 'https://example.com/two' }, c);
  assert.match(opened, /Opened in tab 2; you're on it now/);
  assert.equal(b.of('Target.createTarget').at(-1)!.params.eaaGroup.key, 'r-tabs', "in the run's own tab group");
  let list = await call('tabs', {}, c);
  assert.match(list, /1\. .*example\.com\/one\n2\. .*example\.com\/two {3}<- you are here/);
  await call('tabs', { action: 'switch', tab: 1 }, c);
  assert.match(await call('tabs', {}, c), /1\. .*one {3}<- you are here/);
  // A third tab, closed again.
  await call('tabs', { action: 'open', url: 'https://example.com/three' }, c);
  const three = [...b.tabs].find(([, t]) => t.url.endsWith('/three'))![0];
  assert.match(await call('tabs', { action: 'close', tab: 3 }, c), /Closed tab 3\. You're on tab 2 now/);
  assert.equal(b.tabs.has(three), false);
  // Tab 2 stays open past the run.
  await call('tabs', { action: 'switch', tab: 2 }, c);
  const two = [...b.tabs].find(([, t]) => t.url.endsWith('/two'))![0];
  await assert.rejects(call('keep_open', {}, c), /Say why it stays open/);
  assert.match(await call('keep_open', { reason: 'An export is still running' }, c), /stays open after your run ends/);
  assert.equal(agentTabCount(1), 2);
  await runEnded('r-tabs');
  assert.deepEqual([...b.tabs.keys()], [two], 'the other tab closed with the run');
  assert.equal(b.tabs.get(two)!.attached, false, 'off the debugger once its run is over');
  assert.equal(agentTabCount(1), 1, 'counted as an agent tab');
  await cleanUpBrowsers();
  assert.ok(b.tabs.has(two), 'not a stray for the sweep');
  // Another agent doesn't see it; this agent's next run does, and takes it back.
  assert.doesNotMatch(await call('tabs', {}, ctx('r-other', agent('zz-tools-b', 'Other'))), /export/);
  const next = ctx('r-tabs-2');
  list = await call('tabs', {}, next);
  assert.match(list, /1\. .*\/two {3}\(kept open from an earlier run until .*: An export is still running\)/);
  // Off the debugger it went to this computer's network: not taken back while it's there.
  b.tabs.get(two)!.url = 'http://192.168.1.1/admin';
  await assert.rejects(call('tabs', { action: 'switch', tab: 1 }, next), /isn't on the public web now/);
  assert.equal(b.tabs.get(two)!.attached, false);
  b.tabs.get(two)!.url = 'https://example.com/two';
  await call('tabs', { action: 'switch', tab: 1 }, next);
  assert.equal(b.tabs.get(two)!.attached, true);
  await runEnded('r-tabs-2');
  assert.ok(b.tabs.has(two), 'still kept: closing is the agent\'s, or a day');
  await call('tabs', { action: 'close', tab: 1 }, ctx('r-tabs-3'));
  assert.equal(b.tabs.has(two), false);
  assert.equal(agentTabCount(1), 0);
  await runEnded('r-tabs-3');
  await runEnded('r-other');
});

test('console and network: enabled only when asked, read back, and off again', async () => {
  const c = ctx('r-watch');
  await call('open', { url: 'https://example.com/app' }, c);
  await call('look', {}, c);
  await call('click', { ref: 1 }, c);
  assert.equal(b.of('Runtime.enable').length, 0, 'pages can notice Runtime.enable: never without asking');
  assert.equal(b.of('Network.enable').length, 0);
  const tab = [...b.tabs].find(([, t]) => t.url.endsWith('/app'))![0];
  assert.match(await call('console', { action: 'read' }, c), /isn't being watched: console start first/);
  await call('console', { action: 'start' }, c);
  assert.equal(b.of('Runtime.enable').at(-1)!.sessionId, tab);
  b.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ type: 'string', value: 'Payment failed' }, { type: 'number', value: 402 }], timestamp: 1, stackTrace: { callFrames: [{ url: 'https://example.com/app.js', lineNumber: 9 }] } }, tab);
  b.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'hello' }] }, tab);
  b.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: 'another tab' }] }, 't:elsewhere');
  b.emit('Runtime.exceptionThrown', { timestamp: 2, exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is undefined\n    at y' } } }, tab);
  const read = await call('console', { action: 'read' }, c);
  assert.match(read, /\[error\] Payment failed 402 {2}\(https:\/\/example\.com\/app\.js:10\)/);
  assert.match(read, /\[error\] Uncaught TypeError: x is undefined$/m);
  assert.doesNotMatch(read, /another tab/);
  assert.equal(await call('console', { action: 'read', pattern: 'hel+o' }, c), '[log] hello');
  await call('console', { action: 'stop' }, c);
  assert.equal(b.of('Runtime.disable').length, 1);

  await call('network', { action: 'start' }, c);
  assert.equal(b.of('Network.enable').at(-1)!.sessionId, tab);
  b.emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'POST', url: 'https://api.example.com/pay' }, type: 'Fetch' }, tab);
  b.emit('Network.responseReceived', { requestId: 'r1', type: 'Fetch', response: { status: 402, mimeType: 'application/json' } }, tab);
  b.emit('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 2048 }, tab);
  b.emit('Network.requestWillBeSent', { requestId: 'r2', request: { method: 'GET', url: 'https://cdn.example.com/logo.png' }, type: 'Image' }, tab);
  b.emit('Network.loadingFailed', { requestId: 'r2', errorText: 'net::ERR_FAILED' }, tab);
  const reqs = await call('network', { action: 'read' }, c);
  assert.match(reqs, /^r1 {2}POST 402 Fetch 2 KB {2}https:\/\/api\.example\.com\/pay$/m);
  assert.match(reqs, /^r2 {2}GET FAILED net::ERR_FAILED Image {2}https:\/\/cdn\.example\.com\/logo\.png$/m);
  assert.doesNotMatch(await call('network', { action: 'read', url_contains: 'api.' }, c), /logo/);
  assert.equal(await call('network', { action: 'body', request_id: 'r1' }, c), '{"ok":true}');
  assert.deepEqual(b.of('Network.getResponseBody').at(-1)!.params, { requestId: 'r1' });
  await call('network', { action: 'stop' }, c);
  assert.equal(b.of('Network.disable').length, 1);
  await runEnded('r-watch');
});

test('screenshot: a JPEG image for the model, its clip in document pixels, saved in the workspace', async () => {
  const c = ctx('r-shot');
  await call('open', { url: 'https://example.com/' }, c);
  const shot = await tool('screenshot').media!({}, c);
  assert.equal(shot.images.length, 1);
  assert.equal(shot.images[0].mimeType, 'image/jpeg');
  assert.equal(Buffer.from(shot.images[0].data, 'base64').toString(), 'jpeg-bytes');
  const p = b.of('Page.captureScreenshot').at(-1)!.params;
  // Scrolled 100 down, a 2x screen: one picture pixel per CSS pixel.
  assert.deepEqual(p, { format: 'jpeg', quality: 80, clip: { x: 0, y: 100, width: 1000, height: 800, scale: 0.5 }, captureBeyondViewport: false, fromSurface: true });
  assert.match(shot.text, /1000x800, one picture pixel per page pixel/);
  const saved = /Saved in your workspace as (\S+)\.$/.exec(shot.text)![1];
  assert.ok(existsSync(join(WORKSPACES, 'zz-tools-a', saved)));
  // One element: its box, padded, at up to 2x.
  const el = await tool('screenshot').media!({ ref: 1 }, c);
  assert.deepEqual(b.of('Page.captureScreenshot').at(-1)!.params.clip, { x: 32, y: 142, width: 216, height: 116, scale: 1 });
  assert.match(el.text, /\[1\], showing the screen from \(32, 42\) to \(248, 158\), at 2x/);
  // Zoom: a region, bigger, and how to get back to click coordinates.
  const z = await tool('zoom').media!({ region: [100, 100, 300, 200] }, c);
  assert.deepEqual(b.of('Page.captureScreenshot').at(-1)!.params.clip, { x: 100, y: 200, width: 200, height: 100, scale: 2 });
  assert.match(z.text, /x = 100 \+ px \/ 4, y = 100 \+ py \/ 4/);
  await assert.rejects(tool('zoom').media!({ region: [2000, 2000, 2100, 2100] }, c), /off the screen or too small/);
  // The whole page: beyond the screen, from the top.
  await tool('screenshot').media!({ full_page: true }, c);
  const full = b.of('Page.captureScreenshot').at(-1)!.params;
  assert.equal(full.captureBeyondViewport, true);
  assert.deepEqual(full.clip, { x: 0, y: 0, width: 1000, height: 3000, scale: 0.5 });
  // Text only (an approved call, a model without pictures): the path.
  assert.match(await call('screenshot', {}, c), /Saved in your workspace as browser\/screenshots\/.+\.jpg\.$/);
  await runEnded('r-shot');
});

test('find: the matching numbered controls; wait for_text: says plainly when it never showed', async () => {
  const c = ctx('r-find');
  await call('open', { url: 'https://example.com/' }, c);
  assert.equal(await call('find', { query: 'email' }, c), '1 match "email":\n[2] text field "Email"');
  assert.match(await call('find', { query: 'zebra' }, c), /Nothing you can click or type in matches "zebra"/);
  b.hasText = false;
  const started = Date.now();
  const out = await call('wait', { for_text: 'Order confirmed', seconds: 0.6 }, c);
  assert.ok(Date.now() - started >= 550);
  assert.match(out, /^Waited 0\.6 s: "Order confirmed" hasn't shown on the page/);
  b.hasText = true;
  assert.match(await call('wait', { for_text: 'Order confirmed' }, c), /^"Order confirmed" is on the page now/);
  await assert.rejects(call('wait', {}, c), /Give seconds .* or for_text/);
  await assert.rejects(call('wait', { seconds: 31 }, c), /seconds: from 0 to 30/);
  await runEnded('r-find');
});

test('record without ffmpeg: screenshots to an animated GIF in the workspace', async () => {
  __setFfmpegForTest(false);
  const c = ctx('r-rec');
  await call('open', { url: 'https://example.com/' }, c);
  assert.match(await call('record', { action: 'start' }, c), /Recording this tab \(an animated GIF\)/);
  await assert.rejects(call('record', { action: 'start' }, c), /already recording/);
  await new Promise(r => setTimeout(r, 900));
  const out = await call('record', { action: 'stop' }, c);
  const m = /as an animated GIF: saved in your workspace as (\S+\.gif)\./.exec(out);
  assert.ok(m, out);
  const gif = readFileSync(join(WORKSPACES, 'zz-tools-a', m[1]));
  assert.equal(gif.subarray(0, 6).toString('latin1'), 'GIF89a');
  assert.equal(gif.readUInt16LE(6), 4);
  assert.equal(gif.readUInt16LE(8), 3);
  assert.equal(b.of('Page.captureScreenshot').at(-1)!.params.format, 'png');
  await assert.rejects(call('record', { action: 'stop' }, c), /aren't recording/);
  await runEnded('r-rec');
});

test('run_js: an expression, or a function body run again as one; the result as JSON', async () => {
  const c = ctx('r-js');
  await call('open', { url: 'https://example.com/' }, c);
  assert.equal(await call('run_js', { code: 'document.title' }, c), 'Page at https://example.com/');
  assert.match(await call('run_js', { code: 'void 0' }, c), /gave back nothing/);
  assert.equal(b.of('Runtime.evaluate').at(-1)!.params.contextId, 7, "in the page view's own world");
  await runEnded('r-js');
});

// --- The pieces underneath ---------------------------------------------------------

// GIF's LZW, read back: the indices a frame was written with.
function gifFrames(gif: Buffer): number[][] {
  let pos = 13 + 768;
  const frames: number[][] = [];
  while (gif[pos] !== 0x3b) {
    if (gif[pos] === 0x21) {
      pos += 2;
      while (gif[pos]) pos += gif[pos] + 1;
      pos++;
      continue;
    }
    const w = gif.readUInt16LE(pos + 5), h = gif.readUInt16LE(pos + 7);
    pos += 10;
    const min = gif[pos++];
    const data: number[] = [];
    while (gif[pos]) {
      data.push(...gif.subarray(pos + 1, pos + 1 + gif[pos]));
      pos += gif[pos] + 1;
    }
    pos++;
    let bit = 0;
    const read = (n: number) => {
      let v = 0;
      for (let i = 0; i < n; i++, bit++) v |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
      return v;
    };
    const clear = 1 << min;
    let size = min + 1;
    let dict: number[][] = [];
    const reset = () => {
      dict = Array.from({ length: clear + 2 }, (_, i) => [i]);
      size = min + 1;
    };
    reset();
    const out: number[] = [];
    let prev: number[] | null = null;
    for (;;) {
      const code = read(size);
      if (code === clear) {
        reset();
        prev = null;
        continue;
      }
      if (code === clear + 1) break;
      const entry: number[] = code < dict.length ? dict[code] : [...prev!, prev![0]];
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length === 1 << size && size < 12) size++;
    }
    assert.equal(out.length, w * h);
    frames.push(out);
  }
  return frames;
}

test('gif.ts: PNG rows read back through every filter, and GIF frames that decode to the same colours', () => {
  const px = (x: number, y: number): [number, number, number] => [(x * 37 + y * 11) & 255, (x * 5 + y * 71) & 255, (x * y * 3) & 255];
  for (const filter of [0, 1, 2, 3, 4]) {
    const p = decodePng(png(9, 7, px, filter));
    assert.equal(p.width, 9);
    assert.equal(p.channels, 3);
    assert.deepEqual([...p.data.subarray((3 * 9 + 4) * 3, (3 * 9 + 4) * 3 + 3)], px(4, 3), `filter ${filter}`);
  }
  // Big and varied enough that the LZW table fills and starts again.
  const big = decodePng(png(200, 120, (x, y) => [(x * 13) & 255, (y * 29) & 255, ((x ^ y) * 7) & 255]));
  const small = decodePng(png(200, 120, () => [255, 0, 0]));
  const gif = encodeGif([{ pixels: big, delayMs: 100 }, { pixels: small, delayMs: 500 }]);
  const [f1, f2] = gifFrames(gif);
  const idx = (r: number, g: number, bl: number) => Math.round((r * 5) / 255) * 42 + Math.round((g * 6) / 255) * 6 + Math.round((bl * 5) / 255);
  assert.equal(f1[57 * 200 + 33], idx((33 * 13) & 255, (57 * 29) & 255, ((33 ^ 57) * 7) & 255));
  assert.ok(f2.every(i => i === idx(255, 0, 0)));
});

test('pictures reach the model: MCP image content, and only the last few are sent again', async () => {
  const out = (await rpc({ tools: [], call: async () => ({ content: 'Screenshot', error: false, images: [{ data: 'AAAA', mimeType: 'image/jpeg' }] }) }, { id: 1, method: 'tools/call', params: { name: 'x' } })) as { result: { content: unknown[] } };
  assert.deepEqual(out.result.content, [{ type: 'text', text: 'Screenshot' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }]);
  const img = { data: 'AAAA', mimeType: 'image/jpeg' };
  const msgs: Msg[] = [1, 2, 3, 4, 5].map(i => ({ role: 'tool', results: [{ id: `c${i}`, name: 'signed_in_browser__screenshot', content: `shot ${i}`, images: [img] }] }));
  keepRecentImages(msgs, 3);
  assert.deepEqual(msgs.map(m => (m.role === 'tool' ? m.results[0].images?.length ?? 0 : -1)), [0, 0, 1, 1, 1]);
});
