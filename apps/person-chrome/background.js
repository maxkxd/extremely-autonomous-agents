// EXTREMELY in Chrome.
//
// Phase A: the agency has filled a form in the agents' browser. This opens that
// same page in the person's own Chrome, with those fields, that site's storage,
// and that site's cookies, so they only pass the check and press Submit. Their
// own cookies for the site are put back when the tab closes.
//
// Phase B (not built): the same tab can take click / type / read commands from
// the agency, delivered to restore.js. Do not add the debugger permission for
// that. Attaching a debugger is what makes Cloudflare fail.

function browserKind() {
  return /Edg\//.test(navigator.userAgent) ? 'edge' : 'chrome';
}
function helloBody() {
  return JSON.stringify({ browser: browserKind() });
}

const LOOPBACK = /^(127\.0\.0\.1|localhost)$/;
// EXTREMELY's own port (the app's fixed one). Pairing to anything else is refused: a
// local page on another port could otherwise pair this browser to itself and hand it
// cookies to set, or collect a site's cookies after Submit.
const EXTREMELY_PORT = '5175';

function samePage(href, want) {
  try {
    const a = new URL(href);
    const b = new URL(want);
    return a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
  } catch (e) {
    console.error('[person-chrome] bad url', e.message);
    return false;
  }
}

async function pair() {
  const { pair: saved } = await chrome.storage.local.get('pair');
  if (!saved?.token || !saved.apiBase) return null;
  return saved;
}

async function api(path, opts = {}) {
  const saved = await pair();
  if (!saved) {
    console.error('[person-chrome] not connected');
    return { error: 'Connect Chrome or Edge from EXTREMELY, in Settings.' };
  }
  let res;
  try {
    res = await fetch(saved.apiBase + path, {
      method: opts.method || 'GET',
      headers: { authorization: 'Bearer ' + saved.token, 'content-type': 'application/json' },
      body: opts.body,
    });
  } catch (e) {
    console.error('[person-chrome] the agency did not answer', path, e.message);
    return { error: 'Could not reach EXTREMELY on this computer.' };
  }
  const data = await res.json().catch(e => {
    console.error('[person-chrome] the agency answered with something that was not JSON', path, e.message);
    return {};
  });
  if (!res.ok) {
    console.error('[person-chrome]', path, res.status, data.error || '');
    return { error: data.error || 'EXTREMELY refused that.' };
  }
  return data;
}

function cookieUrl(c) {
  const host = String(c.domain || '').replace(/^\./, '');
  const path = c.path && c.path.startsWith('/') ? c.path : '/' + (c.path || '');
  return `${c.secure ? 'https' : 'http'}://${host}${path}`;
}

function toSet(c) {
  const same = c.sameSite === 'None' || c.sameSite === 'no_restriction' ? 'no_restriction' : c.sameSite === 'Strict' || c.sameSite === 'strict' ? 'strict' : 'lax';
  const secure = same === 'no_restriction' ? true : !!c.secure;
  const spec = {
    url: cookieUrl({ ...c, secure }),
    name: c.name,
    value: c.value,
    path: c.path || '/',
    secure,
    httpOnly: !!c.httpOnly,
    sameSite: same,
  };
  if (!c.name.startsWith('__Host-') && c.domain) spec.domain = c.domain;
  const exp = c.expirationDate || c.expires;
  if (typeof exp === 'number' && exp > 0) spec.expirationDate = exp;
  return spec;
}

function toPerson(c) {
  const sameSite = c.sameSite === 'strict' ? 'Strict' : c.sameSite === 'no_restriction' ? 'None' : 'Lax';
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite,
    ...(c.expirationDate ? { expires: c.expirationDate } : {}),
  };
}

// Only the cookies of the site being opened (and its own subdomains or parent
// domain): a handoff never sets or reads another site's cookies, whatever it lists.
function siteCookies(job) {
  let host;
  try {
    const u = new URL(job.url);
    if (!/^https?:$/.test(u.protocol)) return [];
    host = u.hostname;
  } catch (e) {
    console.error('[person-chrome] handoff has no address', e.message);
    return [];
  }
  // The site's registered domain (aitoolfame.com for www.aitoolfame.com; a two-part
  // ending like co.uk or com.au keeps one more label): any of its subdomains is the site.
  const labels = host.split('.');
  const twoPart = labels.length >= 3 && labels.at(-1).length === 2 && labels.at(-2).length <= 3;
  const site = labels.slice(twoPart ? -3 : -2).join('.');
  const kept = (job.cookies || []).filter(c => {
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    if (!d.includes('.')) return false;
    return d === site || d.endsWith('.' + site);
  });
  const dropped = (job.cookies || []).length - kept.length;
  if (dropped) console.error('[person-chrome]', dropped, 'cookies for other sites were left out');
  return kept;
}

function domainsOf(job) {
  const set = new Set();
  try {
    const host = new URL(job.url).hostname;
    set.add(host);
    set.add(host.replace(/^www\./, ''));
  } catch (e) {
    console.error('[person-chrome] handoff has no address', e.message);
  }
  for (const c of job.cookies || []) set.add(String(c.domain || '').replace(/^\./, ''));
  return [...set].filter(Boolean);
}

async function readJar(domains) {
  const seen = new Set();
  const all = [];
  for (const domain of domains) {
    let list = [];
    try {
      list = await chrome.cookies.getAll({ domain });
    } catch (e) {
      console.error('[person-chrome] could not read cookies for', domain, e.message);
      continue;
    }
    for (const c of list) {
      const key = `${c.domain}|${c.path}|${c.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(c);
    }
  }
  return all;
}

async function writeJar(cookies) {
  const failed = [];
  for (const c of cookies) {
    try {
      const set = await chrome.cookies.set(toSet(c));
      if (!set) failed.push(c.name);
    } catch (e) {
      failed.push(c.name);
      console.error('[person-chrome] cookie was not set', c.name, e.message);
    }
  }
  if (failed.length) console.error('[person-chrome]', failed.length, 'cookies were not set');
  return failed;
}

async function removeJar(cookies) {
  for (const c of cookies) {
    try {
      await chrome.cookies.remove({ url: cookieUrl(c), name: c.name });
    } catch (e) {
      console.error('[person-chrome] cookie was not removed', c.name, e.message);
    }
  }
}

function backupKey(id, tabId) {
  return `backup:${id}:${tabId}`;
}

// Their own cookies for the site, written down before the agent's are put in
// their place. Written before anything is removed, so a crash can put them back.
// Happens before the tab opens, so the first load is already the agent's page.
async function setAside(job, key) {
  const domains = domainsOf(job);
  const backup = await readJar(domains);
  await chrome.storage.local.set({ [key]: { backup, domains, at: Date.now() } });
  console.log('[person-chrome] set aside', backup.length, 'cookies for', job.site || job.url);
  await removeJar(backup);
  const failed = await writeJar(job.cookies || []);
  console.log('[person-chrome] put in', (job.cookies || []).length - failed.length, 'of the agent cookies');
  return failed;
}

async function restoreKey(key) {
  const got = await chrome.storage.local.get(key);
  const rec = got[key];
  if (!rec?.backup) return;
  const now = await readJar(rec.domains || []);
  await removeJar(now);
  const failed = await writeJar(rec.backup);
  await chrome.storage.local.remove(key);
  console.log('[person-chrome] put back', rec.backup.length - failed.length, 'cookies from', key);
}

async function restoreTab(id, tabId) {
  await restoreKey(backupKey(id, tabId));
}

async function restoreStrays() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith('backup:'));
  if (!keys.length) return;
  console.log('[person-chrome] browser started: putting back', keys.length, 'sets of cookies that were set aside');
  for (const key of keys) {
    try {
      await restoreKey(key);
    } catch (e) {
      console.error('[person-chrome] could not put cookies back', key, e.message);
    }
  }
}

function matchesFor(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch (e) {
    console.error('[person-chrome] no host to watch', e.message);
    return [];
  }
  const apex = host.replace(/^www\./, '');
  const list = [`*://${host}/*`];
  if (apex !== host) list.push(`*://${apex}/*`);
  if (!/^\d+(\.\d+){3}$/.test(apex) && apex.includes('.')) list.push(`*://*.${apex}/*`);
  return [...new Set(list)];
}

async function watchSite(url) {
  const matches = matchesFor(url);
  if (!matches.length) return;
  // A wildcard Chrome rejects must not drop the exact host. Register the set
  // that has worked so far, then try adding the next pattern.
  const accepted = [];
  for (const match of matches) {
    const next = [...accepted, match];
    await chrome.scripting.unregisterContentScripts({ ids: ['eaa-restore'] }).catch(e => {
      console.log('[person-chrome] no restore script to replace', e.message);
    });
    try {
      await chrome.scripting.registerContentScripts([
        { id: 'eaa-restore', matches: next, js: ['restore.js'], runAt: 'document_start', persistAcrossSessions: false },
      ]);
      accepted.push(match);
    } catch (e) {
      console.error('[person-chrome] not watching', match, e.message);
      if (accepted.length) {
        await chrome.scripting.registerContentScripts([
          { id: 'eaa-restore', matches: accepted, js: ['restore.js'], runAt: 'document_start', persistAcrossSessions: false },
        ]).catch(err => console.error('[person-chrome] could not put the watch back', err.message));
      }
    }
  }
  if (accepted.length) console.log('[person-chrome] watching', accepted.join(', '));
  else console.error('[person-chrome] could not watch the site; the page will still be filled once it loads');
}

async function rememberTab(tabId, id) {
  const { tabJob = {} } = await chrome.storage.session.get('tabJob');
  tabJob[tabId] = id;
  await chrome.storage.session.set({ tabJob });
}

async function forgetTab(tabId) {
  const { tabJob = {} } = await chrome.storage.session.get('tabJob');
  delete tabJob[tabId];
  await chrome.storage.session.set({ tabJob });
}

async function jobOfTab(tabId) {
  const { tabJob = {} } = await chrome.storage.session.get('tabJob');
  return tabJob[tabId] || null;
}

async function focusExisting(id) {
  const { tabJob = {} } = await chrome.storage.session.get('tabJob');
  for (const [tabId, jobId] of Object.entries(tabJob)) {
    if (jobId !== id) continue;
    try {
      const tab = await chrome.tabs.get(Number(tabId));
      await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      console.log('[person-chrome] already open', id);
      return true;
    } catch (e) {
      console.log('[person-chrome] remembered tab is gone', tabId, e.message);
      await forgetTab(Number(tabId));
    }
  }
  return false;
}

async function openHandoff(id) {
  if (await focusExisting(id)) return { ok: true, already: true };
  const data = await api('/api/person-chrome/ext/job?id=' + encodeURIComponent(id));
  if (data.error) return data;
  const job = data.handoff;
  if (!job?.url || !/^https?:\/\//i.test(job.url)) {
    console.error('[person-chrome] handoff had no web page', id);
    return { error: 'That page had nothing to open.' };
  }
  job.cookies = siteCookies(job);
  await chrome.storage.session.set({ ['job:' + job.id]: job });
  await watchSite(job.url);
  const pending = `backup:${job.id}:pending`;
  try {
    await setAside(job, pending);
  } catch (e) {
    console.error('[person-chrome] could not move the site into this Chrome:', e.message);
    try {
      await restoreKey(pending);
    } catch (err) {
      console.error('[person-chrome] cookies were not put back after a failed copy', err.message);
    }
    return { error: 'The saved sign-in could not be copied, so the page was not opened.' };
  }
  let tab;
  try {
    tab = await chrome.tabs.create({ url: job.url, active: true });
  } catch (e) {
    console.error('[person-chrome] could not open the tab', e.message);
    await restoreKey(pending);
    return { error: 'Could not open a tab in this Chrome.' };
  }
  const saved = await chrome.storage.local.get(pending);
  if (saved[pending]) {
    await chrome.storage.local.set({ [backupKey(job.id, tab.id)]: saved[pending] });
    await chrome.storage.local.remove(pending);
  } else {
    console.error('[person-chrome] the cookie backup was missing after the tab opened', job.id);
  }
  await rememberTab(tab.id, job.id);
  // A local page can finish loading before the tab is remembered, so the
  // complete event never fills it. Fill now as well.
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['restore.js'] });
  } catch (e) {
    console.error('[person-chrome] could not fill the page just opened', e.message);
  }
  console.log('[person-chrome] opened', job.id, 'fields', (job.fields || []).length, 'tab', tab.id);
  return { ok: true };
}

const opening = new Map();
function openOnce(id) {
  if (opening.has(id)) return opening.get(id);
  const p = openHandoff(id).finally(() => opening.delete(id));
  opening.set(id, p);
  return p;
}

// Finished, pressed in the bar on the page or in the app: the sign-in this tab holds
// goes to EXTREMELY, and the person's own login for the site is put back. True once
// EXTREMELY has it.
const finishing = new Set();
async function finish(id, tabId) {
  if (finishing.has(id)) return false;
  finishing.add(id);
  try {
    const { finished = {} } = await chrome.storage.session.get('finished');
    if (finished[id]) return true;
    const got = await chrome.storage.session.get('job:' + id);
    const job = got['job:' + id];
    if (!job) {
      console.error('[person-chrome] Finished for a page that is gone', id);
      await restoreTab(id, tabId);
      return false;
    }
    const cookies = (await readJar(domainsOf(job))).map(toPerson);
    console.log('[person-chrome] finished', id, 'cookies', cookies.length);
    const res = await api('/api/person-chrome/ext/done', { method: 'POST', body: JSON.stringify({ id, cookies }) });
    if (res.error) {
      console.error('[person-chrome] EXTREMELY did not take the result:', res.error);
      await restoreTab(id, tabId);
      return false;
    }
    finished[id] = Date.now();
    await chrome.storage.session.set({ finished });
    await chrome.storage.session.remove('job:' + id);
    await restoreTab(id, tabId);
    await forgetTab(tabId);
    console.log('[person-chrome] sent to EXTREMELY', id);
    return true;
  } catch (e) {
    console.error('[person-chrome] finishing failed', id, e.message);
    try {
      await restoreTab(id, tabId);
    } catch (err) {
      console.error('[person-chrome] cookies were not put back after a failed finish', err.message);
    }
    return false;
  } finally {
    finishing.delete(id);
  }
}

async function abandon(tabId) {
  const id = await jobOfTab(tabId);
  if (!id) return;
  const { finished = {} } = await chrome.storage.session.get('finished');
  if (finished[id]) {
    await forgetTab(tabId);
    return;
  }
  console.log('[person-chrome] tab closed before Finished', id);
  const res = await api('/api/person-chrome/ext/abandon', { method: 'POST', body: JSON.stringify({ id }) });
  if (res.error) console.error('[person-chrome] abandon was not recorded:', res.error);
  try {
    await restoreTab(id, tabId);
  } catch (e) {
    console.error('[person-chrome] cookies were not put back when the tab closed', e.message);
  }
  await forgetTab(tabId);
}

chrome.runtime.onStartup.addListener(() => {
  restoreStrays().catch(e => console.error('[person-chrome] startup restore failed', e.message));
});

chrome.tabs.onRemoved.addListener(tabId => {
  abandon(tabId).catch(e => console.error('[person-chrome] tab close failed', e.message));
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;
  if (tab.url && !/^https?:/i.test(tab.url)) return;
  jobOfTab(tabId)
    .then(id => {
      if (!id) return;
      return chrome.scripting.executeScript({ target: { tabId }, files: ['restore.js'] }).catch(e => {
        console.error('[person-chrome] could not fill the page', e.message);
      });
    })
    .catch(e => console.error('[person-chrome] tab update failed', e.message));
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => {
    p.then(v => sendResponse(v)).catch(e => {
      console.error('[person-chrome]', e.message);
      sendResponse({ error: e.message || 'Something went wrong.' });
    });
    return true;
  };
  if (msg?.type === 'pair') {
    return reply((async () => {
      let url;
      try {
        url = new URL(String(msg.apiBase || ''));
      } catch (e) {
        console.error('[person-chrome] bad connect address', e.message);
        return { error: 'That address is not EXTREMELY.' };
      }
      if (!LOOPBACK.test(url.hostname) || url.port !== EXTREMELY_PORT) {
        console.error('[person-chrome] refused to connect to', url.hostname);
        return { error: 'Only EXTREMELY on this computer.' };
      }
      if (!/^[a-f0-9]{64}$/.test(msg.token || '')) {
        console.error('[person-chrome] connect page had no pairing token');
        return { error: 'That page had no pairing token. Open Connect Chrome or Connect Edge from Settings.' };
      }
      await chrome.storage.local.set({ pair: { apiBase: url.origin, token: msg.token, at: Date.now() } });
      console.log('[person-chrome] paired with', url.origin);
      const hello = await api('/api/person-chrome/ext/hello', { method: 'POST', body: helloBody() });
      return hello.error ? hello : { ok: true };
    })());
  }
  if (msg?.type === 'open-handoff') {
    return reply(openOnce(String(msg.id || '')));
  }
  // Finished in the bar on the page, or asked about by the page every few seconds in
  // case Finished was pressed in the app instead.
  if (msg?.type === 'finish-now' || msg?.type === 'wanted') {
    const tabId = sender.tab?.id;
    if (tabId == null) {
      console.error('[person-chrome]', msg.type, 'with no tab');
      sendResponse({ error: 'No tab.' });
      return false;
    }
    const id = String(msg.id || '');
    return reply((async () => {
      if (msg.type === 'wanted') {
        const w = await api('/api/person-chrome/ext/wanted?id=' + encodeURIComponent(id));
        if (w.error || !w.finish) return { finished: false, gone: !!w.gone };
        console.log('[person-chrome] Finished was pressed in the app', id);
      }
      const ok = await finish(id, tabId);
      return ok ? { finished: true } : { error: 'EXTREMELY did not take it. Try Finished again.' };
    })());
  }
  if (msg?.type === 'job-here') {
    return reply((async () => {
      const all = await chrome.storage.session.get(null);
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith('job:') || !value?.url) continue;
        if (samePage(String(msg.url || ''), value.url)) return { job: value };
      }
      // The tab moved on from the page (the site's next step): still this job, so
      // Finished stays on it, but nothing is filled in here.
      const id = sender.tab?.id != null ? await jobOfTab(sender.tab.id) : null;
      if (id && all['job:' + id]) return { job: all['job:' + id], elsewhere: true };
      return { job: null };
    })());
  }
  if (msg?.type === 'hello') {
    return reply(api('/api/person-chrome/ext/hello', { method: 'POST', body: helloBody() }));
  }
  return false;
});
