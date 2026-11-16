// EXTREMELY in this browser: the connections to paired agencies, pairing, the
// badge, and the popup's and pairing page's messages. What the agency can do in the
// browser is all in relay.js. The contract is docs/browser-extension.md.

import { createRelay } from './relay.js';
import { PROTOCOL, decodeLink, browserKind, defaultLabel, isLoopbackHost } from './pairing.js';

const VERSION = chrome.runtime.getManifest().version;
const KIND = browserKind(navigator.userAgent);
const PING_MS = 20_000; // the server answers; the traffic also keeps this worker running
const FIRST_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
const PAIR_TIMEOUT_MS = 15_000;
const REVIVE_ALARM = 'eaa-revive';

// One per pairing, by its url: {ws, state: 'connecting'|'online'|'offline', backoff, retry, ping, error, stopped}
const conns = new Map();

const relay = createRelay(chrome, sendTo, {
  userAgent: navigator.userAgent,
  version: VERSION,
  onChange: () => void badge(),
});
relay.listen();

// ---------- Stored settings ----------

async function pairings() {
  const { pairings: list } = await chrome.storage.local.get('pairings');
  return Array.isArray(list) ? list : [];
}

async function savePairings(list) {
  await chrome.storage.local.set({ pairings: list });
}

async function label() {
  const { label: l } = await chrome.storage.local.get('label');
  return String(l || '').trim() || defaultLabel(KIND);
}

// ---------- Connections ----------

function connOf(url) {
  let c = conns.get(url);
  if (!c) {
    c = { ws: null, state: 'offline', backoff: FIRST_RETRY_MS, retry: null, ping: null, error: null, stopped: false, starting: false };
    conns.set(url, c);
  }
  return c;
}

function sendTo(url, frame) {
  const c = conns.get(url);
  if (!c?.ws || c.state !== 'online' || c.ws.readyState !== WebSocket.OPEN) {
    console.warn('[eaa] not connected to', url, '- dropped', frame.method || ('answer ' + frame.id));
    return;
  }
  c.ws.send(JSON.stringify(frame));
}

async function connect(url) {
  const c = connOf(url);
  if (c.stopped || c.starting || (c.ws && c.ws.readyState <= WebSocket.OPEN)) return;
  c.starting = true;
  clearTimeout(c.retry);
  try {
    const p = (await pairings()).find(x => x.url === url);
    if (!p) {
      conns.delete(url);
      return;
    }
    const hello = { type: 'hello', token: p.token, protocol: PROTOCOL, version: VERSION, browser: KIND, label: await label() };
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      console.error('[eaa] bad agency address', url, e?.message);
      c.error = 'Bad agency address. Pair again.';
      c.stopped = true;
      return;
    }
    c.ws = ws;
    c.state = 'connecting';
    ws.onopen = () => {
      if (c.ws === ws) ws.send(JSON.stringify(hello));
    };
    wire(url, c, ws);
  } catch (e) {
    console.error('[eaa] could not connect', url, e?.message);
  } finally {
    c.starting = false;
    void badge();
  }
}

// A connection's frames, errors and close: the same for one opened with hello and
// for the pairing connection, which carries on as the live one (adopt, below).
function wire(url, c, ws) {
  ws.onmessage = ev => {
    if (c.ws === ws) onFrame(url, c, ws, ev.data);
  };
  ws.onerror = () => {
    // The browser gives no detail here; onclose follows and retries.
    if (c.ws === ws) console.warn('[eaa] connection error', url);
  };
  ws.onclose = ev => {
    if (c.ws !== ws) return;
    clearInterval(c.ping);
    c.ws = null;
    c.state = 'offline';
    void badge();
    if (c.stopped) return;
    console.warn('[eaa] disconnected from', url, ev.code, ev.reason || '', '- retrying in', c.backoff, 'ms');
    c.retry = setTimeout(() => void connect(url), c.backoff);
    c.backoff = Math.min(c.backoff * 2, MAX_RETRY_MS);
  };
}

// Online on this connection: pings start, commands are answered.
function online(url, c, ws, msg) {
  c.state = 'online';
  c.backoff = FIRST_RETRY_MS;
  c.error = null;
  clearInterval(c.ping);
  c.ping = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
  }, PING_MS);
  void rememberNumber(url, msg);
  void badge();
}

function onFrame(url, c, ws, data) {
  let msg;
  try {
    msg = JSON.parse(data);
  } catch (e) {
    console.error('[eaa] a frame that is not JSON from', url, e?.message);
    return;
  }
  if (msg.type === 'pong') return;
  if (msg.type === 'hello-ok') {
    online(url, c, ws, msg);
    return;
  }
  if (msg.type === 'error') {
    // The agency turned this browser away (removed, or this version is too old).
    // Trying again every 30 s won't change that: wait for the person.
    console.error('[eaa]', url, 'refused:', msg.error);
    c.error = String(msg.error || 'The agency refused this browser.');
    c.stopped = true;
    void badge();
    return;
  }
  if (msg.id != null && typeof msg.method === 'string') {
    if (c.state !== 'online') {
      ws.send(JSON.stringify({ id: msg.id, error: { message: 'Not ready: no hello-ok yet.' } }));
      return;
    }
    void relay.handle(url, msg);
    return;
  }
  console.warn('[eaa] unknown frame from', url, String(data).slice(0, 200));
}

// The agency may renumber or rename this browser (Connectors > Browser); the popup
// shows what it says.
async function rememberNumber(url, msg) {
  const list = await pairings();
  const p = list.find(x => x.url === url);
  if (!p) return;
  const browser = msg.browser ?? p.browser;
  const name = msg.name || p.name;
  if (browser === p.browser && name === p.name) return;
  Object.assign(p, { browser, name });
  await savePairings(list);
}

function disconnect(url, stop) {
  const c = conns.get(url);
  if (!c) return;
  clearTimeout(c.retry);
  clearInterval(c.ping);
  if (stop) c.stopped = true;
  const ws = c.ws;
  if (ws) {
    // With stop: forget it now, so its onclose doesn't schedule a retry.
    if (stop) c.ws = null;
    try {
      ws.close(1000, stop ? 'removed' : 'reconnect');
    } catch (e) {
      console.warn('[eaa] close', url, e?.message);
    }
  }
  if (stop) c.state = 'offline';
}

// Every pairing that isn't connected and wasn't refused: connect. Runs when the worker
// starts and every 30 s from an alarm, because a stopped worker loses its sockets
// and timers but the alarm wakes it.
async function reviveAll() {
  for (const p of await pairings()) void connect(p.url);
}

// ---------- Pairing ----------

// A pairing is {url, token, browser, name, agency}: browser and name are this browser's
// number and name in that agency, agency is the agency's own name from the link.
function pair(link) {
  const { url, code, name: agency } = decodeLink(link);
  return new Promise((resolve, reject) => {
    let ws;
    let done = false;
    let gotToken = false; // the agency may close right after "paired", while it's being saved
    // keep: the socket goes on as this agency's live connection (adopted), not closed.
    const finish = (err, value, keep = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (!keep) {
        try {
          ws?.close(1000, 'paired');
        } catch {
          // already closed
        }
      }
      if (err) {
        console.error('[eaa] pairing with', url, 'failed:', err);
        reject(new Error(err));
      } else resolve(value);
    };
    const timer = setTimeout(() => finish('The agency did not answer. Is EXTREMELY running?'), PAIR_TIMEOUT_MS);
    label().then(lbl => {
      try {
        ws = new WebSocket(url);
      } catch (e) {
        return finish('Bad agency address in that link.');
      }
      ws.onopen = () => ws.send(JSON.stringify({ type: 'pair', code, protocol: PROTOCOL, version: VERSION, browser: KIND, label: lbl }));
      ws.onmessage = async ev => {
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return finish('The agency answered with something that is not JSON.');
        }
        if (msg.type === 'error') return finish(String(msg.error || 'The agency refused that code.'));
        if (msg.type !== 'paired' || !msg.token) return;
        gotToken = true;
        // The agency may send commands as soon as it has said "paired": held until this
        // connection is adopted below, then answered in order.
        const early = [];
        ws.onmessage = e => void early.push(e.data);
        try {
          const list = (await pairings()).filter(p => p.url !== url);
          list.push({ url, token: msg.token, browser: msg.browser ?? null, name: msg.name || '', agency });
          await savePairings(list);
        } catch (e) {
          return finish('Could not save the pairing: ' + (e?.message || e));
        }
        // A fresh start for this agency: the old connection (an earlier pairing) goes.
        disconnect(url, true);
        conns.delete(url);
        // The agency already counts this connection as the browser's live one (it goes
        // online on "paired"). Closing it and saying hello on a new one made the browser
        // go online, offline and online again in a second, and whatever the agency
        // started on the first (finding kept pages) failed. So it carries on here.
        const ok = { ok: true, agency, name: msg.name || '', browser: msg.browser ?? null };
        if (ws.readyState === WebSocket.OPEN) {
          const c = connOf(url);
          c.ws = ws;
          wire(url, c, ws);
          online(url, c, ws, msg);
          finish(null, ok, true);
          for (const data of early) onFrame(url, c, ws, data);
        } else {
          finish(null, ok);
          void connect(url);
        }
      };
      ws.onerror = () => {}; // onclose follows
      ws.onclose = () => {
        if (!gotToken) finish('The connection closed before pairing finished. Is EXTREMELY running?');
      };
    }, e => finish('Could not read settings: ' + (e?.message || e)));
  });
}

async function removePairing(url) {
  disconnect(url, true);
  conns.delete(url);
  await savePairings((await pairings()).filter(p => p.url !== url));
  await relay.forgetAgency(url);
  void badge();
}

// ---------- Badge ----------

async function badge() {
  try {
    const list = await pairings();
    const online = list.some(p => conns.get(p.url)?.state === 'online');
    const tabs = relay.agentTabCount();
    let text = '';
    let color = '#6b7280';
    let title = 'EXTREMELY Autonomous Agents';
    if (relay.isPaused()) {
      text = 'II';
      color = '#d97706';
      title += ': paused';
    } else if (!list.length) {
      title += ': not paired';
    } else if (online) {
      text = tabs ? String(tabs) : ' ';
      color = '#16a34a';
      title += tabs ? `: connected, ${tabs} agent tab${tabs === 1 ? '' : 's'}` : ': connected';
    } else {
      text = ' ';
      title += ': offline';
    }
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setTitle({ title });
  } catch (e) {
    console.error('[eaa] badge', e?.message);
  }
}

// ---------- Popup and pairing page ----------

async function status() {
  const list = await pairings();
  return {
    kind: KIND,
    label: await label(),
    paused: relay.isPaused(),
    pairings: list.map(p => {
      const c = conns.get(p.url);
      return { url: p.url, agency: p.agency || new URL(p.url).host, name: p.name, browser: p.browser, state: c?.state || 'offline', error: c?.error || null, agentTabs: relay.agentTabCount(p.url) };
    }),
  };
}

async function onMessage(msg, sender) {
  await relay.ready;
  switch (msg?.type) {
    case 'pair': {
      // From the pairing page: an agency on this computer pairs straight away. Any other
      // address asks first, because any website can open the pairing page with a link
      // of its own in it.
      if (sender.tab && !msg.confirmed) {
        const { url, name } = decodeLink(msg.link);
        const host = new URL(url).hostname;
        if (!isLoopbackHost(host)) return { confirm: { agency: name, host } };
      }
      return await pair(msg.link);
    }
    case 'status': return status();
    case 'remove': await removePairing(msg.url); return status();
    case 'retry': {
      const c = connOf(msg.url);
      c.stopped = false;
      c.error = null;
      c.backoff = FIRST_RETRY_MS;
      await connect(msg.url);
      return status();
    }
    case 'pause': await relay.setPaused(!!msg.paused); return status();
    case 'label': {
      await chrome.storage.local.set({ label: String(msg.label || '').trim().slice(0, 60) });
      // The agency learns the name from hello: say it again.
      for (const p of await pairings()) disconnect(p.url, false);
      return status();
    }
    default: throw new Error('Unknown message: ' + msg?.type);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  // A content script only ever pairs; the rest is the popup's.
  if (sender.tab) {
    const ok = msg?.type === 'pair' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/browser\/connect(\?|#|$)/.test(sender.url || '');
    if (!ok) {
      reply({ error: 'Not allowed from a page.' });
      return false;
    }
  }
  onMessage(msg, sender).then(reply, e => {
    console.error('[eaa]', msg?.type, e?.message);
    reply({ error: e?.message || String(e) });
  });
  return true; // answers later
});

chrome.alarms.onAlarm.addListener(a => {
  if (a.name === REVIVE_ALARM) void reviveAll();
});
chrome.alarms.create(REVIVE_ALARM, { periodInMinutes: 0.5 });

relay.ready.then(() => reviveAll()).catch(e => console.error('[eaa] start failed', e?.message));
void badge();
