import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, toCdpCookie, toChromeCookie, fileUrl, PAUSED } from '../relay.js';
import { setup, tick } from './fake-chrome.js';

const A = 'ws://127.0.0.1:5175/api/browser-link';
const B = 'wss://agency.example.com/api/browser-link';
const group = { key: 'run-1', title: 'Researcher' };

test('createTarget opens an inactive tab in the last-focused window, in a collapsed titled group', async () => {
  const { f, call, events } = await setup(createRelay);
  const r = await call(A, 'Target.createTarget', { url: 'https://example.com/', newWindow: true, eaaGroup: group });
  assert.equal(r.result.targetId, 't:100');
  const tab = f.tabs.get(100);
  assert.equal(tab.active, false);
  assert.equal(tab.windowId, 1);
  const g = f.groups.get(tab.groupId);
  assert.equal(g.collapsed, true);
  assert.equal(g.title, 'Researcher');
  assert.equal(events(A, 'Target.targetCreated')[0].params.targetInfo.targetId, 't:100');

  // Same key: same group. Another key: another group.
  await call(A, 'Target.createTarget', { url: 'https://example.com/2', eaaGroup: group });
  assert.equal(f.tabs.get(101).groupId, tab.groupId);
  await call(A, 'Target.createTarget', { url: 'https://example.com/3', eaaGroup: { key: 'run-2', title: 'Writer', color: 'blue' } });
  assert.notEqual(f.tabs.get(102).groupId, tab.groupId);
  assert.equal(f.groups.get(f.tabs.get(102).groupId).color, 'blue');
});

test('with no normal window, the agent window is a new unfocused minimized one', async () => {
  const { f, call } = await setup(createRelay);
  f.windows.clear();
  f.setLastFocused(null);
  await call(A, 'Target.createTarget', { url: 'https://example.com/' });
  assert.deepEqual(f.calls.windowsCreate[0], { focused: false, state: 'minimized' });
});

test('attach and detach: attach twice is one attach with the same session; detach keeps the agent tab', async () => {
  const { f, call } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/' });
  const a1 = await call(A, 'Target.attachToTarget', { targetId: 't:100', flatten: true });
  const a2 = await call(A, 'Target.attachToTarget', { targetId: 't:100', flatten: true });
  assert.equal(a1.result.sessionId, 't:100');
  assert.equal(a2.result.sessionId, 't:100');
  assert.deepEqual(f.calls.attach, [[{ tabId: 100 }, '1.3']]);
  assert.ok(f.attached.has(100));

  await call(A, 'Target.detachFromTarget', { sessionId: 't:100' });
  assert.ok(!f.attached.has(100));
  assert.ok(f.tabs.has(100));
  const list = await call(A, 'Target.getTargets');
  assert.deepEqual(list.result.targetInfos.map(t => [t.targetId, t.attached]), [['t:100', false]]);
});

test('sessioned commands go to chrome.debugger, child sessions with their own sessionId', async () => {
  const { f, call, sent } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/' });
  await call(A, 'Target.attachToTarget', { targetId: 't:100', flatten: true });

  const nav = await call(A, 'Page.navigate', { url: 'https://example.com/a' }, 't:100');
  assert.deepEqual(nav.result, { ok: 'Page.navigate' });
  assert.deepEqual(f.calls.sendCommand.at(-1), [{ tabId: 100 }, 'Page.navigate', { url: 'https://example.com/a' }]);

  // An out-of-process iframe attaches: the event comes with the parent's session id.
  await f.chrome.debugger.onEvent.fire({ tabId: 100 }, 'Target.attachedToTarget', { sessionId: 'CHILD-1', targetInfo: { targetId: 'F1', type: 'iframe' } });
  const ev = sent.find(s => s.method === 'Target.attachedToTarget');
  assert.equal(ev.sessionId, 't:100');
  assert.equal(ev.agency, A);

  await call(A, 'Runtime.evaluate', { expression: '1' }, 'CHILD-1');
  assert.deepEqual(f.calls.sendCommand.at(-1), [{ tabId: 100, sessionId: 'CHILD-1' }, 'Runtime.evaluate', { expression: '1' }]);

  // Chrome's error comes back as the answer's error.
  const bad = await call(A, 'Fail.please', {}, 't:100');
  assert.equal(bad.error.message, 'Chrome said no');

  // What chrome.debugger can't do, or would reach past this tab, is refused.
  for (const m of ['Browser.getVersion', 'Target.createTarget', 'Target.createBrowserContext', 'Target.attachToTarget', 'Target.getTargets']) {
    const r = await call(A, m, {}, 't:100');
    assert.match(r.error.message, /Not supported in the extension/, m);
  }
  assert.match((await call(A, 'Target.getTargetInfo', { targetId: 'SOMEONE-ELSE' }, 't:100')).error.message, /Not supported/);
  assert.deepEqual((await call(A, 'Target.getTargetInfo', {}, 't:100')).result, { ok: 'Target.getTargetInfo' });
  const unknown = await call(A, 'Page.reload', {}, 'NOPE');
  assert.match(unknown.error.message, /No such session/);
});

test('events: the tab itself as t:<id>, a child with its own sessionId, other tabs not at all', async () => {
  const { f, call, sent } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/' });
  await call(A, 'Target.attachToTarget', { targetId: 't:100' });
  await f.chrome.debugger.onEvent.fire({ tabId: 100 }, 'Page.loadEventFired', { timestamp: 1 });
  await f.chrome.debugger.onEvent.fire({ tabId: 100, sessionId: 'CHILD-9' }, 'Runtime.consoleAPICalled', { type: 'log' });
  const person = f.personTab();
  await f.chrome.debugger.onEvent.fire({ tabId: person }, 'Page.loadEventFired', { timestamp: 2 });
  const evs = sent.filter(s => s.id == null && s.method !== 'Target.targetCreated');
  assert.deepEqual(evs.map(e => [e.method, e.sessionId]), [['Page.loadEventFired', 't:100'], ['Runtime.consoleAPICalled', 'CHILD-9']]);
});

test('debugger detached by the person: detachedFromTarget with the reason', async () => {
  const { f, call, events } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/' });
  await call(A, 'Target.attachToTarget', { targetId: 't:100' });
  f.attached.delete(100);
  await f.chrome.debugger.onDetach.fire({ tabId: 100 }, 'canceled_by_user');
  assert.deepEqual(events(A, 'Target.detachedFromTarget')[0].params, { sessionId: 't:100', targetId: 't:100', reason: 'canceled_by_user' });
  // And it attaches again afterwards.
  const again = await call(A, 'Target.attachToTarget', { targetId: 't:100' });
  assert.equal(again.result.sessionId, 't:100');
});

test('getTargets lists only this agency\'s agent tabs, with openerId', async () => {
  const { f, call } = await setup(createRelay);
  f.personTab();
  await call(A, 'Target.createTarget', { url: 'https://example.com/', eaaGroup: group });
  await call(B, 'Target.createTarget', { url: 'https://other.example.com/' });
  const opener = f.tabs.get(101);
  assert.ok(opener);
  const popup = await f.chrome.tabs.create({ url: 'https://example.com/popup', windowId: 1 });
  await f.chrome.tabs.onCreated.fire({ ...popup, openerTabId: 101 });

  const a = await call(A, 'Target.getTargets');
  assert.deepEqual(a.result.targetInfos.map(t => t.targetId), ['t:101', 't:103']);
  assert.equal(a.result.targetInfos[1].openerId, 't:101');
  assert.equal(a.result.targetInfos[0].type, 'page');
  const b = await call(B, 'Target.getTargets');
  assert.deepEqual(b.result.targetInfos.map(t => t.targetId), ['t:102']);

  const one = await call(A, 'Target.getTargetInfo', { targetId: 't:103' });
  assert.equal(one.result.targetInfo.openerId, 't:101');
});

test('the person\'s tabs, and another agency\'s, are refused for everything', async () => {
  const { f, call } = await setup(createRelay);
  const person = f.personTab();
  await call(B, 'Target.createTarget', { url: 'https://other.example.com/' });
  const theirs = 't:' + (person + 1);
  for (const id of ['t:' + person, theirs]) {
    for (const [m, p, s] of [
      ['Target.attachToTarget', { targetId: id }],
      ['Target.closeTarget', { targetId: id }],
      ['Target.activateTarget', { targetId: id }],
      ['Target.getTargetInfo', { targetId: id }],
      ['EAA.releaseTab', { targetId: id }],
      ['EAA.groupTab', { targetId: id, key: 'x' }],
      ['Browser.getWindowForTarget', { targetId: id }],
      ['Runtime.evaluate', { expression: 'document.cookie' }, id],
    ]) {
      const r = await call(A, m, p, s);
      assert.match(r.error?.message || '', /Not an agent tab/, `${m} ${id}`);
    }
  }
  assert.ok(f.tabs.has(person));
  assert.equal(f.calls.attach.length, 0);
  assert.equal(f.calls.sendCommand.length, 0);
  // Not the person's window either.
  const w = await call(A, 'Browser.setWindowBounds', { windowId: 1, bounds: { width: 500 } });
  assert.match(w.error.message, /Not an agent window/);
});

test('popups of agent tabs become agent tabs in the opener\'s group, reported once', async () => {
  const { f, call, events } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/', eaaGroup: group });
  const popup = await f.chrome.tabs.create({ url: 'https://accounts.example.com/', windowId: 1 });
  await f.chrome.tabs.onCreated.fire({ ...popup, openerTabId: 100 });
  await f.chrome.webNavigation.onCreatedNavigationTarget.fire({ sourceTabId: 100, tabId: popup.id, url: 'https://accounts.example.com/' });
  const created = events(A, 'Target.targetCreated');
  assert.equal(created.length, 2);
  assert.equal(created[1].params.targetInfo.targetId, 't:' + popup.id);
  assert.equal(created[1].params.targetInfo.openerId, 't:100');
  assert.equal(f.tabs.get(popup.id).groupId, f.tabs.get(100).groupId);

  // A tab the person opens from their own tab is not adopted.
  const person = f.personTab();
  const theirs = await f.chrome.tabs.create({ url: 'https://example.org/', windowId: 1 });
  await f.chrome.tabs.onCreated.fire({ ...theirs, openerTabId: person });
  assert.equal(events(A, 'Target.targetCreated').length, 2);
});

test('closeTarget closes quietly; a tab the person closes also says so', async () => {
  const { f, call, events } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/1' });
  await call(A, 'Target.createTarget', { url: 'https://example.com/2' });
  const r = await call(A, 'Target.closeTarget', { targetId: 't:100' });
  assert.deepEqual(r.result, { success: true });
  await tick();
  assert.deepEqual(events(A, 'Target.targetDestroyed').map(e => e.params.targetId), ['t:100']);
  assert.equal(events(A, 'EAA.tabClosedByPerson').length, 0);

  f.tabs.delete(101);
  await f.chrome.tabs.onRemoved.fire(101, { windowId: 1, isWindowClosing: false });
  assert.deepEqual(events(A, 'Target.targetDestroyed').map(e => e.params.targetId), ['t:100', 't:101']);
  assert.deepEqual(events(A, 'EAA.tabClosedByPerson').map(e => e.params.targetId), ['t:101']);
  const list = await call(A, 'Target.getTargets');
  assert.equal(list.result.targetInfos.length, 0);
});

test('url and title changes of agent tabs become targetInfoChanged', async () => {
  const { f, call, events } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/' });
  await f.chrome.tabs.onUpdated.fire(100, { title: 'Hello' }, { ...f.tabs.get(100), url: 'https://example.com/', title: 'Hello' });
  await f.chrome.tabs.onUpdated.fire(100, { status: 'complete' }, f.tabs.get(100)); // nothing a target shows
  const changed = events(A, 'Target.targetInfoChanged');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].params.targetInfo.title, 'Hello');
});

test('cookies: chrome shape to DevTools shape and back', () => {
  const chromeCookie = { name: 'sid', value: 'abc', domain: '.example.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', session: false, expirationDate: 1900000000, storeId: '0' };
  const cdp = toCdpCookie(chromeCookie);
  assert.deepEqual(cdp, { name: 'sid', value: 'abc', domain: '.example.com', path: '/', expires: 1900000000, size: 6, httpOnly: true, secure: true, session: false, priority: 'Medium', sameParty: false, sourceScheme: 'Secure', sourcePort: 443, sameSite: 'None' });
  assert.deepEqual(toChromeCookie(cdp), { url: 'https://example.com/', name: 'sid', value: 'abc', secure: true, httpOnly: true, domain: '.example.com', path: '/', sameSite: 'no_restriction', expirationDate: 1900000000 });

  // Host-only and a session cookie: no domain given to chrome, no expiry.
  const hostOnly = toCdpCookie({ name: 'a', value: '1', domain: 'app.example.com', hostOnly: true, path: '/x', secure: false, httpOnly: false, sameSite: 'unspecified', session: true });
  assert.equal(hostOnly.expires, -1);
  assert.equal(hostOnly.sameSite, undefined);
  assert.deepEqual(toChromeCookie(hostOnly), { url: 'http://app.example.com/x', name: 'a', value: '1', secure: false, httpOnly: false, path: '/x' });

  // SameSite=None is always Secure; a url is used as given.
  assert.equal(toChromeCookie({ name: 'n', value: 'v', url: 'https://example.com/', sameSite: 'None' }).secure, true);
  assert.throws(() => toChromeCookie({ name: 'n', value: 'v' }), /needs a url or a domain/);
});

test('Storage.getCookies and setCookies go through chrome.cookies', async () => {
  const { f, call } = await setup(createRelay);
  f.cookies.push({ name: 'sid', value: 'abc', domain: '.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: true });
  const got = await call(A, 'Storage.getCookies', {});
  assert.equal(got.result.cookies[0].sameSite, 'Lax');
  assert.equal(got.result.cookies[0].expires, -1);

  const ok = await call(A, 'Storage.setCookies', { cookies: [{ name: 'x', value: '1', domain: '.example.com', path: '/' }] });
  assert.deepEqual(ok.result, {});
  assert.equal(f.calls.cookiesSet[0].domain, '.example.com');
  const bad = await call(A, 'Storage.setCookies', { cookies: [{ name: 'bad', value: '1', domain: 'example.com' }, { name: 'y', value: '2', domain: 'example.com' }] });
  assert.match(bad.error.message, /Could not set 1 of 2 cookies: bad@example.com/);
});

test('paused: no new tabs or attaches, attached tabs are let go, the agency hears', async () => {
  const { f, relay, call, events } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/' });
  await call(A, 'Target.attachToTarget', { targetId: 't:100' });
  await relay.setPaused(true);
  assert.ok(!f.attached.has(100));
  assert.equal(events(A, 'Target.detachedFromTarget')[0].params.reason, 'paused');
  assert.equal((await call(A, 'Target.createTarget', { url: 'https://example.com/' })).error.message, PAUSED);
  assert.equal((await call(A, 'Target.attachToTarget', { targetId: 't:100' })).error.message, PAUSED);
  assert.equal((await call(A, 'Page.navigate', { url: 'https://example.com/' }, 't:100')).error.message, PAUSED);
  // Cleaning up still works.
  assert.deepEqual((await call(A, 'Target.closeTarget', { targetId: 't:100' })).result, { success: true });
  assert.deepEqual(await f.chrome.storage.local.get('paused'), { paused: true });

  await relay.setPaused(false);
  assert.ok((await call(A, 'Target.createTarget', { url: 'https://example.com/' })).result.targetId);
});

test('the agent tabs survive a worker restart (chrome.storage.session)', async () => {
  const { f, relay, call } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/', eaaGroup: group });
  await call(A, 'Target.attachToTarget', { targetId: 't:100' });
  await relay.saved();
  const sent = [];
  const again = createRelay(f.chrome, (agency, frame) => sent.push(frame), {});
  await again.ready;
  await again.handle(A, { id: 1, method: 'Target.getTargets', params: {} });
  assert.deepEqual(sent[0].result.targetInfos.map(t => [t.targetId, t.attached]), [['t:100', true]]);
  await again.handle(B, { id: 2, method: 'Target.getTargets', params: {} });
  assert.deepEqual(sent[1].result.targetInfos, []);
});

test('groupTab moves a tab to an expanded group; releaseTab hands it to the person', async () => {
  const { f, call } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/', eaaGroup: group });
  await call(A, 'Target.attachToTarget', { targetId: 't:100' });
  await call(A, 'EAA.groupTab', { targetId: 't:100', key: 'waiting', title: 'Waiting on you', color: 'orange', collapsed: false });
  const g = f.groups.get(f.tabs.get(100).groupId);
  assert.equal(g.title, 'Waiting on you');
  assert.equal(g.collapsed, false);

  await call(A, 'Target.activateTarget', { targetId: 't:100' });
  assert.equal(f.tabs.get(100).active, true);

  assert.deepEqual((await call(A, 'EAA.releaseTab', { targetId: 't:100' })).result, {});
  assert.ok(!f.attached.has(100));
  assert.equal(f.tabs.get(100).groupId, -1);
  assert.ok(f.tabs.has(100));
  assert.equal((await call(A, 'Target.getTargets')).result.targetInfos.length, 0);
  assert.match((await call(A, 'Target.attachToTarget', { targetId: 't:100' })).error.message, /Not an agent tab/);
});

test('window bounds: state on a window with agent tabs, size only on our own window', async () => {
  const { f, call } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/' });
  const w = await call(A, 'Browser.getWindowForTarget', { targetId: 't:100' });
  assert.equal(w.result.windowId, 1);
  assert.equal(w.result.bounds.windowState, 'normal');
  await call(A, 'Browser.setWindowBounds', { windowId: 1, bounds: { width: 500, height: 400 } });
  assert.equal(f.windows.get(1).width, 1200); // the person's window keeps its size
  await call(A, 'Browser.setWindowBounds', { windowId: 1, bounds: { windowState: 'minimized' } });
  assert.equal(f.windows.get(1).state, 'minimized');
});

test('downloads: only those tied to an agent tab are listed and read', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.7 hello');
  const fetched = [];
  const fetch = async url => {
    fetched.push(url);
    return { ok: true, status: 200, arrayBuffer: async () => bytes.buffer, headers: { get: () => null } };
  };
  const { f, call } = await setup(createRelay, { fetch });
  await call(A, 'Target.createTarget', { url: 'https://example.com/' });
  await call(A, 'Target.attachToTarget', { targetId: 't:100' });
  await f.chrome.debugger.onEvent.fire({ tabId: 100 }, 'Page.downloadWillBegin', { url: 'https://example.com/report.pdf', guid: 'g' });
  const mine = { id: 7, url: 'https://example.com/report.pdf', filename: 'C:\\Downloads\\report.pdf', state: 'complete', bytesReceived: 14, totalBytes: 14, fileSize: 14, mime: 'application/pdf', startTime: '2026-11-16T10:00:00.000Z', exists: true };
  const person = { id: 8, url: 'https://bank.example.org/statement.pdf', referrer: 'https://bank.example.org/', filename: 'C:\\Downloads\\statement.pdf', state: 'complete', startTime: '2026-11-16T10:00:01.000Z' };
  f.downloads.push(mine, person);
  await f.chrome.downloads.onCreated.fire(mine);
  await f.chrome.downloads.onCreated.fire(person);

  const list = await call(A, 'EAA.downloads', { since: Date.parse('2026-11-16T09:00:00Z') });
  assert.deepEqual(list.result.items.map(i => [i.id, i.tabTargetId]), [[7, 't:100']]);
  const file = await call(A, 'EAA.downloadFile', { id: 7 });
  assert.equal(Buffer.from(file.result.base64, 'base64').toString(), '%PDF-1.7 hello');
  assert.equal(file.result.filename, 'report.pdf');
  assert.equal(file.result.mime, 'application/pdf');
  assert.equal(fetched[0], 'file:///C:/Downloads/report.pdf');
  assert.match((await call(A, 'EAA.downloadFile', { id: 8 })).error.message, /Not a download from an agent tab/);
  assert.match((await call(B, 'EAA.downloadFile', { id: 7 })).error.message, /Not a download from an agent tab/);
});

test('everything else without a session is refused, each with exactly one answer', async () => {
  const { call } = await setup(createRelay);
  for (const m of ['Target.createBrowserContext', 'Target.setAutoAttach', 'Browser.close', 'Page.navigate']) {
    const r = await call(A, m);
    assert.equal(r.error.message, `Not supported in the extension: ${m}`);
  }
  const v = await call(A, 'Browser.getVersion');
  assert.equal(v.result.protocolVersion, '1.3');
  assert.equal(v.result.product, 'Chrome/131.0.0.0');
  assert.equal(v.result.extensionVersion, '0.2.0');
  assert.deepEqual((await call(A, 'Target.setDiscoverTargets', { discover: true })).result, {});
});

test('a chrome API that throws still gets one answer', async () => {
  const { f, call } = await setup(createRelay);
  f.chrome.tabs.create = async () => {
    throw new Error('Tabs cannot be edited right now');
  };
  const r = await call(A, 'Target.createTarget', { url: 'https://example.com/' });
  assert.equal(r.error.message, 'Tabs cannot be edited right now');
});

test('forgetAgency lets its tabs go and keeps the other agency\'s', async () => {
  const { f, relay, call } = await setup(createRelay);
  await call(A, 'Target.createTarget', { url: 'https://example.com/' });
  await call(A, 'Target.attachToTarget', { targetId: 't:100' });
  await call(B, 'Target.createTarget', { url: 'https://other.example.com/' });
  await relay.forgetAgency(A);
  assert.ok(!f.attached.has(100));
  assert.ok(f.tabs.has(100));
  assert.equal(relay.agentTabCount(A), 0);
  assert.equal(relay.agentTabCount(B), 1);
});

test('fileUrl makes file URLs for Windows and other paths', () => {
  assert.equal(fileUrl('C:\\Users\\test\\Downloads\\a b.pdf'), 'file:///C:/Users/test/Downloads/a%20b.pdf');
  assert.equal(fileUrl('/home/test/Downloads/x#1.zip'), 'file:///home/test/Downloads/x%231.zip');
});
