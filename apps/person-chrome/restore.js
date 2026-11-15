// Fills the page the agency already filled, then watches for Submit.
// Injected only on a site the person just asked to finish (and again when that
// tab finishes loading). It does nothing when this tab is not that page.
//
// Phase B will take click / type / read messages here. It must not attach the
// debugger: that is what makes a check like Cloudflare fail.

function samePage(href, want) {
  try {
    const a = new URL(href);
    const b = new URL(want);
    return a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '');
  } catch (e) {
    return false;
  }
}

function jobForHere() {
  // The page script cannot read the extension's session storage ("Access to
  // storage is not allowed from this context"). The background looks it up.
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'job-here', url: location.href }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(res?.job ? { ...res.job, elsewhere: !!res.elsewhere } : null);
    });
  });
}

function setNative(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  const last = el.value;
  if (desc?.set) desc.set.call(el, value);
  else el.value = value;
  if (el._valueTracker) el._valueTracker.setValue(last);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function findField(field, used) {
  const candidates = [];
  if (field.id) {
    const byId = document.getElementById(field.id);
    if (byId) candidates.push(byId);
  }
  if (field.name) candidates.push(...document.getElementsByName(field.name));
  if (field.placeholder) {
    candidates.push(...document.querySelectorAll('input, textarea'));
  }
  for (const el of candidates) {
    // Form fields only: getElementsByName also finds <meta name="description">, which
    // nearly every site has, and filling it threw and stopped the rest of the form.
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) continue;
    if (used.has(el)) continue;
    if (field.type === 'radio' && el.value !== field.value) continue;
    if (field.placeholder && !field.id && !field.name && el.placeholder !== field.placeholder) continue;
    if (field.placeholder && (field.id || field.name) && el.placeholder && el.placeholder !== field.placeholder && el.id !== field.id && el.name !== field.name) continue;
    return el;
  }
  if (field.label) {
    const want = field.label.trim().toLowerCase();
    for (const label of document.querySelectorAll('label')) {
      if ((label.innerText || '').trim().toLowerCase() !== want) continue;
      const el = label.control || label.querySelector('input, textarea, select');
      if (el && !used.has(el)) return el;
    }
  }
  return null;
}

function fill(job) {
  const used = new Set();
  const missed = [];
  let n = 0;
  for (const field of job.fields || []) {
    const el = findField(field, used);
    if (!el) {
      missed.push(field.name || field.id || field.label || field.type);
      continue;
    }
    used.add(el);
    // One field that won't take a value doesn't stop the rest.
    try {
      if (field.type === 'checkbox' || field.type === 'radio') {
        if (field.checked && !el.checked) el.click();
        else if (!field.checked && el.checked && field.type === 'checkbox') el.click();
      } else if (el.value !== field.value) {
        setNative(el, field.value);
      }
      n++;
    } catch (e) {
      missed.push(field.name || field.id || field.label || field.type);
      console.error('[person-chrome] could not fill', field.name || field.id || field.label, e.message);
    }
  }
  console.log('[person-chrome] filled', n, 'fields');
  if (missed.length) console.error('[person-chrome] fields not on the page:', missed.join(', '));
  return n;
}

function applyStorage(storage) {
  const put = (area, data) => {
    for (const [key, value] of Object.entries(data || {})) {
      try {
        area.setItem(key, value);
      } catch (e) {
        console.error('[person-chrome] could not restore', key, e.message);
      }
    }
  };
  try {
    put(localStorage, storage?.local);
    put(sessionStorage, storage?.session);
  } catch (e) {
    console.error('[person-chrome] storage was not writable', e.message);
  }
}

// The bar along the bottom of the page: what to do, and Finished. Finished (here, or on
// the request in the app) sends the sign-in this tab holds to EXTREMELY, puts the
// person's own login back, and tells the agent to carry on.
// On the page's global, and `var`: this file can be injected twice into one page.
var isSent = () => globalThis.__eaaSent === true;
function say(bar, text) {
  const t = bar.querySelector('[data-eaa-text]');
  if (t) t.textContent = text;
}
function markSent(bar) {
  globalThis.__eaaSent = true;
  say(bar, 'Sent to EXTREMELY. The agent carries on from here. You can close this tab.');
  bar.querySelector('[data-eaa-finish]')?.remove();
}
function banner(job, filled) {
  if (document.getElementById('eaa-person-chrome')) return;
  const bar = document.createElement('div');
  bar.id = 'eaa-person-chrome';
  bar.setAttribute('role', 'status');
  const files = (job.files || []).filter(f => f.fileName).map(f => f.fileName);
  const text = document.createElement('div');
  text.setAttribute('data-eaa-text', '');
  text.textContent = isSent()
    ? 'Sent to EXTREMELY. The agent carries on from here. You can close this tab.'
    : (filled ? 'EXTREMELY filled this in. ' : '') + 'Do what’s needed on this page, then press Finished and the agent carries on.';
  if (!isSent() && files.length) text.textContent += ' Choose the file again: ' + files.join(', ') + '.';
  const finishBtn = document.createElement('button');
  finishBtn.type = 'button';
  finishBtn.textContent = 'Finished';
  finishBtn.setAttribute('data-eaa-finish', '');
  finishBtn.addEventListener('click', () => {
    finishBtn.disabled = true;
    finishBtn.textContent = 'Sending…';
    chrome.runtime.sendMessage({ type: 'finish-now', id: job.id }, (res) => {
      if (chrome.runtime.lastError || res?.error) {
        console.error('[person-chrome] Finished failed', chrome.runtime.lastError?.message || res.error);
        finishBtn.disabled = false;
        finishBtn.textContent = 'Finished';
        say(bar, res?.error || 'EXTREMELY did not answer. Is the app open? Try Finished again.');
        return;
      }
      markSent(bar);
    });
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Hide';
  close.addEventListener('click', () => bar.remove());
  if (isSent()) bar.append(text, close);
  else bar.append(text, finishBtn, close);
  bar.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;display:flex;gap:12px;align-items:center;background:#1c1b22;color:#fff;padding:12px 14px;border-radius:10px;font:14px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)';
  text.style.cssText = 'flex:1;min-width:0';
  finishBtn.style.cssText = 'background:#fff;color:#141414;border:0;border-radius:8px;padding:9px 22px;font:600 15px system-ui,sans-serif;cursor:pointer;white-space:nowrap';
  close.style.cssText = 'background:transparent;color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:8px;padding:6px 10px;cursor:pointer';
  (document.body || document.documentElement).append(bar);
}

(async () => {
  let job;
  try {
    job = await jobForHere();
  } catch (e) {
    console.error('[person-chrome] could not read the handoff', e.message);
    return;
  }
  if (!job) return;
  // A later injection (the tab finished loading) still fills. Listeners stay once,
  // or a slow page would get two of them and finish twice.
  const first = globalThis.__eaaPersonChrome !== job.id;
  globalThis.__eaaPersonChrome = job.id;
  console.log('[person-chrome] restoring', job.id, 'fields', (job.fields || []).length);
  if (!job.elsewhere) applyStorage(job.storage);
  // The bar shows even if filling failed. A page that redraws itself (most sites
  // built with React and the like) can drop it: it's put back while the page settles.
  let filled = 0;
  const run = () => {
    try {
      if (!job.elsewhere) filled = Math.max(filled, fill(job));
    } catch (e) {
      console.error('[person-chrome] fill failed', e.message);
    }
    if (document.body && !document.getElementById('eaa-person-chrome')) banner(job, filled > 0);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  if (!first) return;
  for (const ms of [300, 1000, 2500, 5000, 8000, 12000]) setTimeout(run, ms);
  // Finished pressed in the app instead: asked every few seconds while the tab is open.
  const timer = setInterval(() => {
    if (isSent()) return clearInterval(timer);
    chrome.runtime.sendMessage({ type: 'wanted', id: job.id }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.gone) return clearInterval(timer);
      if (res?.finished) {
        clearInterval(timer);
        const bar = document.getElementById('eaa-person-chrome');
        if (bar) markSent(bar);
        else globalThis.__eaaSent = true;
      }
    });
  }, 3000);
})().catch(e => console.error('[person-chrome] restore failed', e.message));
