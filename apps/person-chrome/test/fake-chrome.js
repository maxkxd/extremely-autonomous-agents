// A small in-memory chrome.* for the relay tests: tabs, windows, tab groups, the
// debugger, cookies, downloads and storage, with events the test can fire.

function event() {
  const fns = [];
  return {
    addListener: f => fns.push(f),
    fire: (...a) => Promise.all(fns.map(f => f(...a))),
  };
}

function store() {
  let data = {};
  const clone = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  return {
    async get(k) {
      if (k == null) return clone(data);
      const keys = typeof k === 'string' ? [k] : Array.isArray(k) ? k : Object.keys(k);
      return Object.fromEntries(keys.filter(x => x in data).map(x => [x, clone(data[x])]));
    },
    async set(o) {
      Object.assign(data, clone(o));
    },
    dump: () => clone(data),
  };
}

export function fakeChrome() {
  let nextTab = 100;
  let nextGroup = 1;
  let nextWin = 10;
  const tabs = new Map();
  const windows = new Map([[1, { id: 1, type: 'normal', incognito: false, state: 'normal', focused: true, left: 0, top: 0, width: 1200, height: 800 }]]);
  const groups = new Map();
  const attached = new Set();
  const calls = { attach: [], detach: [], sendCommand: [], windowsCreate: [], windowsUpdate: [], cookiesSet: [] };
  const cookies = [];
  const downloads = [];
  let lastFocused = 1;

  const chrome = {
    runtime: { id: 'ext-id', getManifest: () => ({ version: '0.2.0' }) },
    storage: { local: store(), session: store() },
    windows: {
      async getLastFocused() {
        const w = windows.get(lastFocused);
        if (!w) throw new Error('No last-focused window');
        return { ...w };
      },
      async getAll() {
        return [...windows.values()].map(w => ({ ...w }));
      },
      async get(id) {
        const w = windows.get(id);
        if (!w) throw new Error('No window with id: ' + id);
        return { ...w };
      },
      async create(props) {
        calls.windowsCreate.push(props);
        const w = { id: nextWin++, type: 'normal', incognito: false, state: props.state || 'normal', focused: !!props.focused, left: 0, top: 0, width: 800, height: 600 };
        windows.set(w.id, w);
        return { ...w };
      },
      async update(id, props) {
        calls.windowsUpdate.push([id, props]);
        Object.assign(windows.get(id), props);
        return { ...windows.get(id) };
      },
      onRemoved: event(),
    },
    tabs: {
      async create(props) {
        const t = { id: nextTab++, windowId: props.windowId ?? lastFocused, url: '', pendingUrl: props.url, title: '', active: !!props.active, groupId: -1, openerTabId: props.openerTabId };
        tabs.set(t.id, t);
        return { ...t };
      },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error('No tab with id: ' + id);
        return { ...t };
      },
      async query(q) {
        return [...tabs.values()].filter(t => q.windowId == null || t.windowId === q.windowId).map(t => ({ ...t }));
      },
      async remove(id) {
        if (!tabs.has(id)) throw new Error('No tab with id: ' + id);
        tabs.delete(id);
        attached.delete(id);
        setTimeout(() => chrome.tabs.onRemoved.fire(id, { windowId: 1, isWindowClosing: false }), 0);
      },
      async update(id, props) {
        Object.assign(tabs.get(id), props);
        return { ...tabs.get(id) };
      },
      async group({ groupId, tabIds, createProperties }) {
        let g = groupId != null ? groups.get(groupId) : null;
        if (groupId != null && !g) throw new Error('No group with id: ' + groupId);
        if (!g) {
          g = { id: nextGroup++, windowId: createProperties?.windowId ?? 1, collapsed: false, title: '', color: 'grey' };
          groups.set(g.id, g);
        }
        for (const id of tabIds) {
          const t = tabs.get(id);
          if (!t) throw new Error('No tab with id: ' + id);
          if (windows.get(t.windowId)?.type !== 'normal') throw new Error('Tabs can only be moved to and from normal windows.');
          t.groupId = g.id;
          t.windowId = g.windowId;
        }
        return g.id;
      },
      async ungroup(id) {
        tabs.get(id).groupId = -1;
      },
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onReplaced: event(),
    },
    tabGroups: {
      async get(id) {
        const g = groups.get(id);
        if (!g) throw new Error('No group with id: ' + id);
        return { ...g };
      },
      async update(id, props) {
        Object.assign(groups.get(id), props);
        return { ...groups.get(id) };
      },
      onRemoved: event(),
    },
    debugger: {
      async attach(target, version) {
        calls.attach.push([target, version]);
        if (attached.has(target.tabId)) throw new Error('Another debugger is already attached to the tab with id: ' + target.tabId);
        attached.add(target.tabId);
      },
      async detach(target) {
        calls.detach.push(target);
        if (!attached.delete(target.tabId)) throw new Error('Debugger is not attached to the tab with id: ' + target.tabId);
      },
      async sendCommand(target, method, params) {
        calls.sendCommand.push([target, method, params]);
        if (!attached.has(target.tabId)) throw new Error('Debugger is not attached to the tab with id: ' + target.tabId);
        if (method === 'Fail.please') throw new Error('Chrome said no');
        return { ok: method };
      },
      async getTargets() {
        return [...tabs.values()].map(t => ({ tabId: t.id, attached: attached.has(t.id), extensionId: attached.has(t.id) ? 'ext-id' : undefined, type: 'page' }));
      },
      onEvent: event(),
      onDetach: event(),
    },
    cookies: {
      async getAll() {
        return cookies.map(c => ({ ...c }));
      },
      async set(spec) {
        calls.cookiesSet.push(spec);
        if (spec.name === 'bad') throw new Error('Failed to parse or set cookie named "bad".');
        return { ...spec };
      },
    },
    downloads: {
      async search(q) {
        return downloads.filter(d => (q.id == null || d.id === q.id) && (!q.startedAfter || d.startTime > q.startedAfter)).map(d => ({ ...d }));
      },
      onCreated: event(),
    },
    webNavigation: { onCreatedNavigationTarget: event() },
  };

  return {
    chrome,
    tabs,
    windows,
    groups,
    attached,
    calls,
    cookies,
    downloads,
    setLastFocused: id => (lastFocused = id),
    // A tab the person opened themselves.
    personTab(url = 'https://mail.example.com/') {
      const t = { id: nextTab++, windowId: 1, url, title: 'Inbox', active: true, groupId: -1 };
      tabs.set(t.id, t);
      return t.id;
    },
  };
}

// A relay wired to the fake, with every frame it sends recorded per agency.
export async function setup(createRelay, opts = {}) {
  const f = fakeChrome();
  const sent = [];
  const relay = createRelay(f.chrome, (agency, frame) => sent.push({ agency, ...frame }), { userAgent: 'Mozilla/5.0 Chrome/131.0.0.0 Safari/537.36', version: '0.2.0', ...opts });
  relay.listen();
  await relay.ready;
  let nextId = 1;
  // Sends one command and returns its one answer (failing the test if there isn't exactly one).
  const call = async (agency, method, params = {}, sessionId) => {
    const id = nextId++;
    await relay.handle(agency, { id, method, params, ...(sessionId ? { sessionId } : {}) });
    const answers = sent.filter(s => s.id === id);
    if (answers.length !== 1) throw new Error(`${method}: ${answers.length} answers`);
    return answers[0];
  };
  const events = (agency, method) => sent.filter(s => s.agency === agency && s.method === method && s.id == null);
  return { f, relay, sent, call, events };
}

export const tick = () => new Promise(r => setTimeout(r, 5));
