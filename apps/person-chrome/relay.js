// The relay: to a paired agency, this browser looks like a DevTools browser, but one
// that only has the agents' own tabs in it. The contract is docs/browser-extension.md.
//
// Everything with a sessionId goes to chrome.debugger. The few browser-level methods
// the server needs (Target.*, Browser.*, EAA.*) are answered here from the tabs,
// tabGroups, windows and downloads APIs.
//
// It takes the chrome API object as a parameter so Node tests can hand it a fake one.
// `send(agencyUrl, frame)` puts one frame on that agency's connection.
//
// The one hard rule: a tab is an agent tab only if an agency opened it (createTarget)
// or an agent tab opened it (a popup). Any other tab is the person's, and nothing here
// attaches to it, reads it, lists it or closes it. Each agency sees only its own tabs.

import { PROTOCOL } from './pairing.js';

export const PAUSED = 'The person paused agents in this browser.';
export const NOT_AGENT = 'Not an agent tab';
const MAX_DOWNLOAD = 50 * 1024 * 1024;
const HINT_MS = 30_000; // how long a "download will begin" from a tab is matched to a new download
const KEEP_DOWNLOADS = 500;
const GROUP_COLORS = new Set(['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']);
// The record of agent tabs that outlives a browser restart (chrome.storage.local).
const RECORD_KEY = 'eaaAgentTabs';
const RECORD_MS = 1_000; // written this long after the last change
const RECORD_MAX = 300; // tabs per agency
const WAITING_KEY = 'waiting'; // the "Waiting on you" group: kept pages, the person's

// Inside a tab's session, the Target domain could reach other targets (the person's tabs
// included). Only these act on the tab itself or its own frames.
const SESSION_TARGET_OK = new Set(['Target.setAutoAttach', 'Target.detachFromTarget', 'Target.getTargetInfo']);

// Also refused inside a session: these read, set or clear the cookies of the whole
// profile - every site the person is signed in to - not the tab's. The agency never
// needs them, and a pairing (one with an agency on another computer included) must
// not be able to take every sign-in the person has in one call.
const SESSION_PROFILE_WIDE = new Set([
  'Network.getAllCookies',
  'Network.clearBrowserCookies',
  'Storage.getCookies',
  'Storage.setCookies',
  'Storage.clearCookies',
]);

// Where an agent tab may be sent (createTarget, Page.navigate): web pages and a blank
// one. Not file:// (with "Allow access to file URLs" on, that would read the person's
// disk), chrome:// or another extension's pages. The agency only ever asks for these.
export function navigable(url) {
  const u = String(url ?? '');
  if (u === '' || u === 'about:blank') return true;
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
}

export function tabIdOf(id) {
  const m = /^t:(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : null;
}

export const targetIdOf = tabId => 't:' + tabId;

export function fileUrl(path) {
  const p = String(path).replace(/\\/g, '/');
  const withRoot = p.startsWith('/') ? p : '/' + p; // C:/x -> /C:/x
  return 'file://' + withRoot.split('/').map(s => (/^[A-Za-z]:$/.test(s) ? s : encodeURIComponent(s))).join('/');
}

export function toBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function fail(message) {
  const e = new Error(message);
  e.refused = true; // ours, on purpose: logged quietly
  return e;
}

export function createRelay(chromeApi, send, opts = {}) {
  const c = chromeApi;
  const doFetch = opts.fetch || ((...a) => fetch(...a));
  const onChange = opts.onChange || (() => {});

  // Kept in chrome.storage.session: survives the worker being stopped, not the browser
  // restarting (after which there are no agent tabs, as the contract says).
  // Keys are tab ids as strings (storage turns them into strings anyway).
  const state = {
    tabs: {}, // tabId -> {agency, groupKey, opener, url, title}
    groups: {}, // agency + "\n" + key -> groupId
    collapsed: {}, // agency + "\n" + key -> whether this extension last left that group collapsed
    attached: {}, // tabId -> true, while chrome.debugger is attached
    children: {}, // Chrome's child sessionId (an iframe) -> its tab's id
    downloads: {}, // download id -> {agency, tabId}
    windows: [], // windows this extension opened (the only ones it resizes)
    groupInfo: {}, // agency + "\n" + key -> {title, color}, as the browser has the group
  };
  // The agent tabs recorded before this browser session (a restart: Chrome may restore
  // them, with new ids): agency -> [{url, title, color, waiting}]. Swept by sweepRestored.
  let previous = {};
  let paused = false;
  const closing = new Set(); // tabs closed for a Target.closeTarget, so that close isn't the person's
  const hints = []; // {url, tabId, at}: Page.downloadWillBegin seen in an agent tab
  const unmatched = []; // {id, url, at}: downloads not yet tied to a tab
  // windowId -> the last few tabs made active there, newest last (memory only): which
  // tab to give the front back to when an agent's popup takes it.
  const recent = new Map();

  const ready = (async () => {
    try {
      const [{ eaaRelay, eaaSession, eaaPrevious }, { paused: p, [RECORD_KEY]: rec }] = await Promise.all([
        c.storage.session.get(['eaaRelay', 'eaaSession', 'eaaPrevious']),
        c.storage.local.get(['paused', RECORD_KEY]),
      ]);
      if (eaaRelay) Object.assign(state, eaaRelay);
      state.groupInfo ||= {};
      paused = !!p;
      if (eaaSession) previous = eaaPrevious || {};
      else {
        // A new browser session (a restart, or the extension reloaded): what was recorded
        // is what Chrome may bring back. Held for this session until swept; the record
        // itself starts again from this session's agent tabs.
        previous = rec?.v === 1 && rec.agencies && typeof rec.agencies === 'object' ? rec.agencies : {};
        await c.storage.session.set({ eaaSession: true, eaaPrevious: previous });
        await c.storage.local.set({ [RECORD_KEY]: recordOf() });
      }
    } catch (e) {
      console.error('[eaa] could not read the relay state, starting empty', e?.message);
    }
    // The tab in front in each window now, for a worker that has seen no activation yet.
    try {
      for (const t of await c.tabs.query({ active: true })) if (!recent.has(t.windowId)) recent.set(t.windowId, [t.id]);
    } catch (e) {
      console.warn('[eaa] could not read the active tabs', e?.message);
    }
    // The debugger's real state wins over what was saved: it may have been detached
    // while the worker was stopped.
    try {
      const targets = await c.debugger.getTargets();
      const ours = new Set(targets.filter(t => t.attached && t.tabId != null && t.extensionId === c.runtime.id).map(t => String(t.tabId)));
      state.attached = {};
      for (const id of Object.keys(state.tabs)) if (ours.has(id)) state.attached[id] = true;
    } catch (e) {
      console.error('[eaa] could not list debugger targets', e?.message);
    }
    onChange();
  })();

  let saving = Promise.resolve();
  function save() {
    saving = saving
      .then(() => c.storage.session.set({ eaaRelay: state }))
      .catch(e => console.error('[eaa] could not save the relay state', e?.message));
    scheduleRecord();
    return saving;
  }

  // ---------- The record that outlives a restart ----------

  // Each agency's agent tabs that sit in one of its groups: the page and the group's
  // title and color. After a restart that's all there is to know them by.
  function recordOf() {
    const agencies = {};
    for (const rec of Object.values(state.tabs)) {
      if (rec.groupKey == null || !rec.url) continue;
      const g = state.groupInfo[rec.agency + '\n' + rec.groupKey];
      if (!g || !g.title) continue;
      const list = (agencies[rec.agency] ||= []);
      if (list.length < RECORD_MAX) list.push({ url: String(rec.url).slice(0, 2000), title: g.title, color: g.color || '', waiting: rec.groupKey === WAITING_KEY });
    }
    return { v: 1, agencies };
  }

  let recordTimer = null;
  let recording = Promise.resolve();
  function scheduleRecord() {
    clearTimeout(recordTimer);
    recordTimer = setTimeout(() => void writeRecord(), RECORD_MS);
    recordTimer?.unref?.(); // Node (tests): not what keeps it running
  }
  function writeRecord() {
    clearTimeout(recordTimer);
    recordTimer = null;
    recording = recording
      .then(() => c.storage.local.set({ [RECORD_KEY]: recordOf() }))
      .catch(e => console.error('[eaa] could not save the agent tabs record', e?.message));
    return recording;
  }

  // After a restart: tabs Chrome brought back that were an agency's agent tabs - in a
  // group with a recorded group's title and color, at a recorded agent tab's address.
  // An agent's are closed (the server has let them go: nothing knows them now). A kept
  // page ("Waiting on you") is the person's: it stays, out of the group, as a normal tab.
  // Nothing else is touched: not a tab of the person's, not one an agency has now.
  // agency: just that one's, on its first connection (and its record is done with);
  // none: every agency's, when the browser starts (kept for those first connections,
  // since Chrome may still be restoring tabs).
  async function sweepRestored(agency) {
    await ready;
    const wanted = (agency != null ? [agency] : Object.keys(previous)).filter(a => Array.isArray(previous[a]) && previous[a].length);
    let closed = 0;
    let ungrouped = 0;
    if (wanted.length) {
      const all = await c.tabs.query({}).catch(() => []);
      const groupOf = new Map();
      for (const tab of all) {
        if (tab.groupId == null || tab.groupId === -1 || state.tabs[tab.id]) continue;
        if (!groupOf.has(tab.groupId)) groupOf.set(tab.groupId, await c.tabGroups.get(tab.groupId).catch(() => null));
        const g = groupOf.get(tab.groupId);
        if (!g) continue;
        const url = tab.url || tab.pendingUrl || '';
        let hit = null;
        for (const a of wanted) {
          hit = previous[a].find(r => r.url === url && r.title === (g.title || '') && (r.color || '') === (g.color || ''));
          if (hit) break;
        }
        if (!hit) continue;
        try {
          if (hit.waiting) {
            await c.tabs.ungroup(tab.id);
            ungrouped++;
          } else {
            await c.tabs.remove(tab.id);
            closed++;
          }
        } catch (e) {
          console.warn('[eaa] could not tidy a restored agent tab', tab.id, e?.message);
        }
      }
      if (closed || ungrouped) console.log('[eaa] after a restart: closed', closed, 'agent tabs; left', ungrouped, 'kept pages as normal tabs');
    }
    if (agency != null && previous[agency]) {
      delete previous[agency];
      await c.storage.session.set({ eaaPrevious: previous }).catch(e => console.warn('[eaa] could not save the restore list', e?.message));
    }
    return { closed, ungrouped };
  }

  function emit(agency, method, params, sessionId) {
    const frame = sessionId ? { method, params, sessionId } : { method, params };
    try {
      send(agency, frame);
    } catch (e) {
      console.error('[eaa] could not send', method, e?.message);
    }
  }

  // The tab id behind a target id, if it's this agency's agent tab. Else refused.
  function own(agency, targetId) {
    const tabId = tabIdOf(targetId);
    const rec = tabId == null ? null : state.tabs[tabId];
    if (!rec || rec.agency !== agency) throw fail(`${NOT_AGENT}: ${targetId}`);
    return tabId;
  }

  function info(tabId, tab) {
    const rec = state.tabs[tabId] || {};
    const out = {
      targetId: targetIdOf(tabId),
      type: 'page',
      url: tab?.url || tab?.pendingUrl || rec.url || '',
      title: tab?.title || rec.title || '',
      attached: !!state.attached[tabId],
      canAccessOpener: false,
    };
    const opener = rec.opener ?? tab?.openerTabId;
    if (opener != null && state.tabs[opener]?.agency === rec.agency) out.openerId = targetIdOf(opener);
    return out;
  }

  // ---------- Commands ----------

  // Exactly one answer per command, whatever happens.
  async function handle(agency, msg) {
    const { id, method, params, sessionId } = msg || {};
    let frame;
    try {
      await ready;
      if (typeof method !== 'string') throw fail('A command needs a method.');
      const p = params && typeof params === 'object' ? params : {};
      const result = sessionId ? await sessioned(agency, method, p, sessionId) : await browserLevel(agency, method, p);
      frame = { id, result: result ?? {} };
    } catch (e) {
      const message = e?.message || String(e);
      if (e?.refused) console.warn('[eaa]', method, message);
      else console.error('[eaa]', method, message);
      frame = { id, error: { message } };
    }
    try {
      send(agency, frame);
    } catch (e) {
      console.error('[eaa] could not answer', method, e?.message);
    }
  }

  async function sessioned(agency, method, params, sessionId) {
    if (method.startsWith('Browser.') || method === 'Target.createTarget' || method === 'Target.createBrowserContext') {
      throw fail(`Not supported in the extension: ${method} inside a session`);
    }
    if (method.startsWith('Target.') && (!SESSION_TARGET_OK.has(method) || (method === 'Target.getTargetInfo' && params.targetId))) {
      throw fail(`Not supported in the extension: ${method} inside a session`);
    }
    if (SESSION_PROFILE_WIDE.has(method)) throw fail(`Not supported in the extension: ${method} (it reaches every site's cookies)`);
    if (method === 'Page.navigate' && !navigable(params.url)) throw fail(`Not allowed in the extension: ${String(params.url).slice(0, 100)} isn't a web address`);
    if (paused) throw fail(PAUSED);
    const top = tabIdOf(sessionId);
    let target;
    if (top != null) {
      own(agency, sessionId);
      target = { tabId: top };
    } else {
      const tabId = state.children[sessionId];
      if (tabId == null) throw fail(`No such session: ${sessionId}`);
      own(agency, targetIdOf(tabId));
      target = { tabId, sessionId };
    }
    return await c.debugger.sendCommand(target, method, params);
  }

  async function browserLevel(agency, method, p) {
    switch (method) {
      case 'Target.createTarget': return createTarget(agency, p);
      case 'Target.attachToTarget': return attach(agency, p);
      case 'Target.detachFromTarget': return detach(agency, p);
      case 'Target.closeTarget': return closeTarget(agency, p);
      case 'Target.activateTarget': return activate(agency, p);
      case 'Target.getTargets': return { targetInfos: await listTargets(agency) };
      case 'Target.getTargetInfo': return targetInfo(agency, p);
      case 'Target.setDiscoverTargets': return {}; // events are always sent
      case 'Browser.getWindowForTarget': return windowForTarget(agency, p);
      case 'Browser.setWindowBounds': return setWindowBounds(agency, p);
      case 'Browser.getVersion': return version();
      case 'EAA.groupTab': return groupTab(agency, p);
      case 'EAA.tabGroup': return tabGroup(agency, p);
      case 'EAA.releaseTab': return releaseTab(agency, p);
      case 'EAA.downloads': return listDownloads(agency, p);
      case 'EAA.downloadFile': return downloadFile(agency, p);
      default: throw fail(`Not supported in the extension: ${method}`);
    }
  }

  // The person's last-focused normal window, so collapsed groups sit at the end of the
  // strip they already have. Never an incognito one. Failing that, a window of our own,
  // opened behind everything.
  async function agentWindow() {
    try {
      const w = await c.windows.getLastFocused({ windowTypes: ['normal'] });
      if (w && w.type === 'normal' && !w.incognito) return w.id;
    } catch {
      // no window was ever focused: fall through
    }
    const all = await c.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
    const some = all.find(w => w.type === 'normal' && !w.incognito);
    if (some) return some.id;
    let w;
    try {
      w = await c.windows.create({ focused: false, state: 'minimized' });
    } catch (e) {
      console.warn('[eaa] could not open a minimized window, opening a normal one', e?.message);
      w = await c.windows.create({ focused: false });
    }
    state.windows.push(w.id);
    void save();
    return w.id;
  }

  // The window to open a tab in: its group's, when the group still exists (so the tab
  // isn't moved across windows), else the agent window.
  async function windowFor(agency, group) {
    const groupId = group ? state.groups[agency + '\n' + group.key] : null;
    if (groupId != null) {
      try {
        const g = await c.tabGroups.get(groupId);
        if (g?.windowId != null) return g.windowId;
      } catch {
        delete state.groups[agency + '\n' + group.key];
      }
    }
    return agentWindow();
  }

  async function createTarget(agency, p) {
    if (paused) throw fail(PAUSED);
    if (!navigable(p.url)) throw fail(`Not allowed in the extension: ${String(p.url).slice(0, 100)} isn't a web address`);
    const group = p.eaaGroup && p.eaaGroup.key != null ? p.eaaGroup : null;
    const windowId = await windowFor(agency, group);
    // newWindow / background / bounds are DevTools' way to keep a page out of sight. Here
    // a tab in a collapsed group does that, so they're ignored.
    const tab = await c.tabs.create({ url: p.url || 'about:blank', active: false, windowId });
    state.tabs[tab.id] = { agency, groupKey: null, opener: null, url: tab.pendingUrl || tab.url || p.url || '', title: tab.title || '' };
    void save();
    if (group) {
      // A tab outside its group still works; the agent shouldn't fail over that.
      await intoGroup(agency, tab.id, group, true).catch(e => console.error('[eaa] could not group the new tab', e?.message));
    }
    emit(agency, 'Target.targetCreated', { targetInfo: info(tab.id, tab) });
    onChange();
    return { targetId: targetIdOf(tab.id) };
  }

  async function intoGroup(agency, tabId, { key, title, color, collapsed }, collapsedByDefault) {
    const gk = agency + '\n' + key;
    let groupId = state.groups[gk];
    if (groupId != null) {
      try {
        await c.tabs.group({ groupId, tabIds: [tabId] });
      } catch {
        groupId = null; // the group closed with its last tab
      }
    }
    if (groupId == null) {
      const tab = await c.tabs.get(tabId);
      groupId = await c.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
      state.groups[gk] = groupId;
    }
    const props = { collapsed: collapsed ?? collapsedByDefault };
    if (title != null) props.title = String(title).slice(0, 80);
    if (GROUP_COLORS.has(color)) props.color = color;
    const g = await c.tabGroups.update(groupId, props);
    state.collapsed[gk] = !!props.collapsed;
    // Chrome picks a color when none is given: the one it has is what a restart brings back.
    state.groupInfo[gk] = { title: g?.title ?? props.title ?? '', color: g?.color ?? props.color ?? '' };
    if (state.tabs[tabId]) state.tabs[tabId].groupKey = String(key);
    void save();
    return groupId;
  }

  async function attach(agency, p) {
    if (paused) throw fail(PAUSED);
    const tabId = own(agency, p.targetId);
    const sessionId = targetIdOf(tabId);
    if (state.attached[tabId]) return { sessionId };
    try {
      await c.debugger.attach({ tabId }, '1.3');
    } catch (e) {
      // Already attached by us (state lost somehow) is fine; anyone else is not.
      const targets = await c.debugger.getTargets().catch(() => []);
      const t = targets.find(t => t.tabId === tabId);
      if (!(t?.attached && t.extensionId === c.runtime.id)) throw new Error(`Could not attach to ${sessionId}: ${e?.message || e}`);
    }
    state.attached[tabId] = true;
    void save();
    return { sessionId };
  }

  function dropChildren(tabId) {
    for (const [s, t] of Object.entries(state.children)) if (String(t) === String(tabId)) delete state.children[s];
  }

  // Detach without telling the agency (it asked, or is told some other way).
  async function quietDetach(tabId) {
    if (!state.attached[tabId]) return false;
    delete state.attached[tabId]; // first, so onDetach knows this one was ours
    dropChildren(tabId);
    void save();
    try {
      await c.debugger.detach({ tabId: Number(tabId) });
    } catch (e) {
      console.warn('[eaa] detach', tabId, e?.message);
    }
    return true;
  }

  async function detach(agency, p) {
    const sessionId = p.sessionId ?? p.targetId;
    if (tabIdOf(sessionId) == null && state.children[sessionId] != null) {
      // An iframe's session: its tab's session detaches it.
      const tabId = state.children[sessionId];
      own(agency, targetIdOf(tabId));
      await c.debugger.sendCommand({ tabId }, 'Target.detachFromTarget', { sessionId });
      return {};
    }
    const tabId = own(agency, sessionId);
    await quietDetach(tabId);
    return {};
  }

  async function closeTarget(agency, p) {
    const tabId = own(agency, p.targetId);
    closing.add(tabId);
    try {
      await c.tabs.remove(tabId);
    } catch (e) {
      closing.delete(tabId);
      throw new Error(`Could not close ${p.targetId}: ${e?.message || e}`);
    }
    return { success: true };
  }

  async function activate(agency, p) {
    const tabId = own(agency, p.targetId);
    const tab = await c.tabs.get(tabId);
    const win = await c.windows.get(tab.windowId);
    await c.windows.update(tab.windowId, win.state === 'minimized' ? { state: 'normal', focused: true } : { focused: true });
    await c.tabs.update(tabId, { active: true });
    if (tab.groupId != null && tab.groupId !== -1) {
      await c.tabGroups.update(tab.groupId, { collapsed: false });
      for (const [k, id] of Object.entries(state.groups)) if (id === tab.groupId) state.collapsed[k] = false;
      void save();
    }
    return {};
  }

  async function listTargets(agency) {
    const out = [];
    for (const [id, rec] of Object.entries(state.tabs)) {
      if (rec.agency !== agency) continue;
      const tab = await c.tabs.get(Number(id)).catch(() => null);
      if (!tab) {
        forgetTab(id); // gone while nobody was listening
        continue;
      }
      out.push(info(Number(id), tab));
    }
    return out;
  }

  async function targetInfo(agency, p) {
    if (!p.targetId) return { targetInfo: { targetId: 'browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
    const tabId = own(agency, p.targetId);
    const tab = await c.tabs.get(tabId);
    return { targetInfo: info(tabId, tab) };
  }

  function bounds(w) {
    return { left: w.left, top: w.top, width: w.width, height: w.height, windowState: w.state === 'locked-fullscreen' ? 'fullscreen' : w.state };
  }

  async function windowForTarget(agency, p) {
    if (!p.targetId) throw fail('Browser.getWindowForTarget needs a targetId here.');
    const tabId = own(agency, p.targetId);
    const tab = await c.tabs.get(tabId);
    const w = await c.windows.get(tab.windowId);
    return { windowId: w.id, bounds: bounds(w) };
  }

  // Minimize / restore: any window holding this agency's tabs (the server uses that to
  // bring a page to the front). A new size: only a window this extension opened itself,
  // never the person's own window.
  async function setWindowBounds(agency, p) {
    const windowId = Number(p.windowId);
    const b = p.bounds || {};
    const ours = state.windows.includes(windowId);
    if (!ours) {
      const tabs = await c.tabs.query({ windowId });
      if (!tabs.some(t => state.tabs[t.id]?.agency === agency)) throw fail('Not an agent window');
    }
    const upd = {};
    if (b.windowState) upd.state = b.windowState;
    if (ours && (!b.windowState || b.windowState === 'normal')) {
      for (const k of ['left', 'top', 'width', 'height']) if (typeof b[k] === 'number') upd[k] = Math.round(b[k]);
    }
    if (Object.keys(upd).length) await c.windows.update(windowId, upd);
    return {};
  }

  function version() {
    const ua = String(opts.userAgent || '');
    const m = /(?:Chrome|Chromium)\/([\d.]+)/.exec(ua);
    return { protocolVersion: '1.3', product: m ? 'Chrome/' + m[1] : 'Chrome', revision: '', userAgent: ua, jsVersion: '', extensionVersion: opts.version || '', extensionProtocol: PROTOCOL };
  }

  async function groupTab(agency, p) {
    const tabId = own(agency, p.targetId);
    if (p.key == null) throw fail('EAA.groupTab needs a key.');
    await intoGroup(agency, tabId, { key: p.key, title: p.title, color: p.color, collapsed: p.collapsed }, true);
    return {};
  }

  // Which group an agent tab is in, as the browser has it: {groupId: -1} when none
  // (a browser without tab groups, or one that couldn't make it). Read-only; lets the
  // agency (and the end-to-end test) see the group a run's tabs actually landed in.
  async function tabGroup(agency, p) {
    const tabId = own(agency, p.targetId);
    const tab = await c.tabs.get(tabId);
    const groupId = tab.groupId ?? -1;
    const active = !!tab.active;
    if (groupId === -1 || !c.tabGroups) return { groupId: -1, active };
    const g = await c.tabGroups.get(groupId).catch(() => null);
    if (!g) return { groupId: -1, active };
    return { groupId, title: g.title ?? '', collapsed: !!g.collapsed, color: g.color, windowId: g.windowId, active };
  }

  // The person keeps it: not an agent tab any more, out of its group, debugger off.
  async function releaseTab(agency, p) {
    const tabId = own(agency, p.targetId);
    await quietDetach(tabId);
    await c.tabs.ungroup(tabId).catch(e => console.warn('[eaa] ungroup', tabId, e?.message));
    forgetTab(tabId);
    return {};
  }

  async function listDownloads(agency, p) {
    const query = {};
    if (p.since != null) {
      const t = typeof p.since === 'number' ? p.since : Date.parse(p.since);
      if (!Number.isNaN(t)) query.startedAfter = new Date(t).toISOString();
    }
    const items = await c.downloads.search(query);
    return {
      items: items
        .filter(i => state.downloads[i.id]?.agency === agency)
        .map(i => ({
          id: i.id,
          url: i.finalUrl || i.url,
          filename: i.filename,
          state: i.state,
          bytes: i.bytesReceived,
          totalBytes: i.totalBytes,
          mime: i.mime,
          startTime: i.startTime,
          ...(i.error ? { error: i.error } : {}),
          tabTargetId: targetIdOf(state.downloads[i.id].tabId),
        })),
    };
  }

  async function downloadFile(agency, p) {
    const owner = state.downloads[p.id];
    if (!owner || owner.agency !== agency) throw fail('Not a download from an agent tab');
    const [item] = await c.downloads.search({ id: Number(p.id) });
    if (!item) throw fail('That download is gone from the browser.');
    if (item.state !== 'complete') throw fail(`That download isn't finished (${item.state}).`);
    if (item.exists === false) throw fail('That downloaded file was moved or deleted.');
    const size = item.fileSize > 0 ? item.fileSize : item.totalBytes;
    if (size > MAX_DOWNLOAD) throw fail('That download is over 50 MB.');
    let res;
    try {
      res = await doFetch(fileUrl(item.filename));
    } catch (e) {
      throw fail(`The extension can't read downloaded files in this browser (${e?.message || e}). Turn on "Allow access to file URLs" for EXTREMELY on the extensions page.`);
    }
    if (!res.ok) throw fail(`The extension can't read that downloaded file (${res.status}).`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_DOWNLOAD) throw fail('That download is over 50 MB.');
    return {
      base64: toBase64(bytes),
      mime: item.mime || res.headers?.get?.('content-type') || 'application/octet-stream',
      filename: String(item.filename).split(/[\\/]/).pop(),
    };
  }

  // ---------- Browser events ----------

  function forgetTab(tabId) {
    delete state.tabs[tabId];
    delete state.attached[tabId];
    dropChildren(tabId);
    closing.delete(Number(tabId));
    void save();
    onChange();
  }

  async function onDebuggerEvent(source, method, params) {
    await ready;
    const tabId = source?.tabId;
    const rec = tabId == null ? null : state.tabs[tabId];
    if (!rec) return; // not ours to forward (shouldn't be attached at all)
    const sessionId = source.sessionId || targetIdOf(tabId);
    if (method === 'Target.attachedToTarget' && params?.sessionId) {
      state.children[params.sessionId] = tabId;
      void save();
    } else if (method === 'Target.detachedFromTarget' && params?.sessionId) {
      delete state.children[params.sessionId];
      void save();
    } else if (method === 'Page.downloadWillBegin' && params?.url) {
      downloadHint(tabId, params.url);
    }
    emit(rec.agency, method, params, sessionId);
  }

  async function onDebuggerDetach(source, reason) {
    await ready;
    const tabId = source?.tabId;
    if (tabId == null) return;
    if (source.sessionId) {
      delete state.children[source.sessionId];
      void save();
      return;
    }
    if (!state.attached[tabId]) return; // we detached it ourselves
    delete state.attached[tabId];
    dropChildren(tabId);
    void save();
    const rec = state.tabs[tabId];
    if (rec) emit(rec.agency, 'Target.detachedFromTarget', { sessionId: targetIdOf(tabId), targetId: targetIdOf(tabId), reason });
  }

  // A tab or window an agent tab opened is an agent tab too, in its opener's group.
  // Both onCreated and onCreatedNavigationTarget can report the same one; once is enough.
  async function adopt(tabId, openerId, tab) {
    await ready;
    if (tabId == null || state.tabs[tabId]) return;
    const op = state.tabs[openerId];
    if (!op) return;
    // Only from a tab an agent is driving (debugger on). A tab kept for the person, or one
    // an agent left open, is off the debugger and in the person's hands: what they open
    // from it is theirs, and must never be listed to the agency or closed as its stray.
    if (!state.attached[openerId]) return;
    state.tabs[tabId] = { agency: op.agency, groupKey: op.groupKey, opener: Number(openerId), url: tab?.pendingUrl || tab?.url || '', title: tab?.title || '' };
    void save();
    const now = (await c.tabs.get(tabId).catch(() => null)) || tab;
    // A link with target=_blank (or a click that opens a tab) opens it in front, in the
    // person's window: the person's tab would be swapped for the agent's. The front goes
    // back to the tab the person had there.
    if (now?.active) await giveBackFront(now.windowId, tabId);
    if (op.groupKey != null) {
      const groupId = state.groups[op.agency + '\n' + op.groupKey];
      // A popup window (window.open with features) can't hold a group: it stays as it is.
      if (groupId != null) {
        await c.tabs.group({ groupId, tabIds: [tabId] }).catch(e => console.warn('[eaa] could not group a popup', e?.message));
        // Chrome expands a collapsed group when a tab in it comes to the front (and
        // Chrome may have put the new tab in its opener's group itself, before this ran).
        // Collapsed again as this extension left it, now the front is back with the person.
        if (state.collapsed[op.agency + '\n' + op.groupKey]) await c.tabGroups.update(groupId, { collapsed: true }).catch(e => console.warn('[eaa] could not collapse the group', e?.message));
      }
    }
    emit(op.agency, 'Target.targetCreated', { targetInfo: info(tabId, now) });
    onChange();
  }

  // The tab that was in front in that window before the new one, if it's the person's
  // and still open there: in front again. If it was an agent tab, the person was looking
  // at it (a page shown to them, or a group they opened) and the new tab is theirs to
  // see: left as it is. None known (a worker that just started): left as it is too.
  async function giveBackFront(windowId, except) {
    const ids = recent.get(windowId) || [];
    for (let i = ids.length - 1; i >= 0; i--) {
      const id = ids[i];
      if (id === except) continue;
      if (state.tabs[id]) return;
      const t = await c.tabs.get(id).catch(() => null);
      if (!t || t.windowId !== windowId) continue; // closed or moved since: the one before it
      await c.tabs.update(id, { active: true }).catch(e => console.warn('[eaa] could not give the front back', e?.message));
      return;
    }
  }

  async function onTabActivated({ tabId, windowId } = {}) {
    if (tabId == null) return;
    const ids = (recent.get(windowId) || []).filter(id => id !== tabId);
    ids.push(tabId);
    recent.set(windowId, ids.slice(-8));
  }

  async function onTabCreated(tab) {
    if (tab?.openerTabId != null) await adopt(tab.id, tab.openerTabId, tab);
  }

  async function onCreatedNavigationTarget(d) {
    if (d?.sourceTabId != null) await adopt(d.tabId, d.sourceTabId);
  }

  async function onTabUpdated(tabId, change, tab) {
    await ready;
    const rec = state.tabs[tabId];
    if (!rec || (change?.url === undefined && change?.title === undefined)) return;
    rec.url = tab?.url ?? rec.url;
    rec.title = tab?.title ?? rec.title;
    void save();
    emit(rec.agency, 'Target.targetInfoChanged', { targetInfo: info(tabId, tab) });
  }

  async function onTabRemoved(tabId) {
    await ready;
    const rec = state.tabs[tabId];
    if (!rec) return;
    const byAgency = closing.has(tabId);
    forgetTab(tabId);
    emit(rec.agency, 'Target.targetDestroyed', { targetId: targetIdOf(tabId) });
    if (!byAgency) emit(rec.agency, 'EAA.tabClosedByPerson', { targetId: targetIdOf(tabId) });
  }

  // Chrome swapped a tab for a prerendered one: to the agency, the old one is gone
  // and a new one opened.
  async function onTabReplaced(addedId, removedId) {
    await ready;
    const rec = state.tabs[removedId];
    if (!rec) return;
    forgetTab(removedId);
    state.tabs[addedId] = { ...rec };
    void save();
    emit(rec.agency, 'Target.targetDestroyed', { targetId: targetIdOf(removedId) });
    const tab = await c.tabs.get(addedId).catch(() => null);
    emit(rec.agency, 'Target.targetCreated', { targetInfo: info(addedId, tab) });
    onChange();
  }

  async function onGroupRemoved(group) {
    await ready;
    for (const [k, id] of Object.entries(state.groups)) if (id === group?.id) delete state.groups[k], delete state.collapsed[k], delete state.groupInfo[k];
    void save();
  }

  async function onWindowRemoved(windowId) {
    recent.delete(windowId);
    await ready;
    state.windows = state.windows.filter(w => w !== windowId);
    void save();
  }

  // chrome.downloads doesn't say which tab a download came from. Two signs tie one to
  // an agent tab: the tab's own Page.downloadWillBegin for that url, or a referrer that
  // is exactly an agent tab's page. Anything else is the person's and stays unlisted.
  function prune(list) {
    const cutoff = Date.now() - HINT_MS;
    while (list.length && list[0].at < cutoff) list.shift();
  }

  function ownDownload(id, tabId) {
    const rec = state.tabs[tabId];
    if (!rec) return;
    state.downloads[id] = { agency: rec.agency, tabId: Number(tabId) };
    const ids = Object.keys(state.downloads);
    if (ids.length > KEEP_DOWNLOADS) for (const old of ids.slice(0, ids.length - KEEP_DOWNLOADS)) delete state.downloads[old];
    void save();
  }

  function downloadHint(tabId, url) {
    prune(hints);
    prune(unmatched);
    const i = unmatched.findIndex(d => d.url === url);
    if (i >= 0) {
      ownDownload(unmatched[i].id, tabId);
      unmatched.splice(i, 1);
      return;
    }
    hints.push({ url, tabId, at: Date.now() });
  }

  async function onDownloadCreated(item) {
    await ready;
    prune(hints);
    prune(unmatched);
    const hint = hints.find(h => h.url === item.url || h.url === item.finalUrl);
    if (hint) return ownDownload(item.id, hint.tabId);
    if (item.referrer) {
      const hit = Object.entries(state.tabs).find(([, rec]) => rec.url && rec.url === item.referrer);
      if (hit) return ownDownload(item.id, hit[0]);
    }
    unmatched.push({ id: item.id, url: item.url, at: Date.now() });
  }

  // ---------- Controls ----------

  // Pausing also takes the debugger off every agent tab, so a run mid-step stops
  // driving the browser now rather than at its next new tab.
  async function setPaused(value) {
    await ready;
    paused = !!value;
    await c.storage.local.set({ paused });
    if (paused) {
      for (const id of Object.keys(state.attached)) {
        const rec = state.tabs[id];
        await quietDetach(id);
        if (rec) emit(rec.agency, 'Target.detachedFromTarget', { sessionId: targetIdOf(id), targetId: targetIdOf(id), reason: 'paused' });
      }
    }
    onChange();
  }

  // A pairing was removed: its tabs stay open as the person's, without the debugger.
  async function forgetAgency(agency) {
    await ready;
    for (const [id, rec] of Object.entries(state.tabs)) {
      if (rec.agency !== agency) continue;
      await quietDetach(id);
      delete state.tabs[id];
    }
    for (const k of Object.keys(state.groups)) if (k.startsWith(agency + '\n')) delete state.groups[k], delete state.collapsed[k], delete state.groupInfo[k];
    delete previous[agency];
    await c.storage.session.set({ eaaPrevious: previous }).catch(() => {});
    for (const [id, d] of Object.entries(state.downloads)) if (d.agency === agency) delete state.downloads[id];
    await save();
    await writeRecord();
    onChange();
  }

  function agentTabCount(agency) {
    return Object.values(state.tabs).filter(r => agency == null || r.agency === agency).length;
  }

  // Listeners go on synchronously, at the worker's top level, so an event that wakes
  // the worker is delivered.
  function listen() {
    const on = (event, fn) => event.addListener((...a) => fn(...a).catch(e => console.error('[eaa] listener failed', e?.message)));
    on(c.debugger.onEvent, onDebuggerEvent);
    on(c.debugger.onDetach, onDebuggerDetach);
    on(c.tabs.onCreated, onTabCreated);
    if (c.tabs.onActivated) on(c.tabs.onActivated, onTabActivated);
    on(c.tabs.onUpdated, onTabUpdated);
    on(c.tabs.onRemoved, onTabRemoved);
    on(c.tabs.onReplaced, onTabReplaced);
    on(c.tabGroups.onRemoved, onGroupRemoved);
    on(c.windows.onRemoved, onWindowRemoved);
    on(c.webNavigation.onCreatedNavigationTarget, onCreatedNavigationTarget);
    on(c.downloads.onCreated, onDownloadCreated);
    // The browser started: it may have brought back agent tabs from last time.
    if (c.runtime.onStartup) on(c.runtime.onStartup, () => sweepRestored());
  }

  return {
    ready,
    handle,
    listen,
    setPaused,
    isPaused: () => paused,
    forgetAgency,
    agentTabCount,
    sweepRestored,
    saved: () => saving,
    // The record written now, not after its pause (tests).
    flushRecord: writeRecord,
  };
}
