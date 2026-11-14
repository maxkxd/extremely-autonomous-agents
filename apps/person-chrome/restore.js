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
      resolve(res?.job || null);
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

function banner(job, filled) {
  if (document.getElementById('eaa-person-chrome')) return;
  const bar = document.createElement('div');
  bar.id = 'eaa-person-chrome';
  bar.setAttribute('role', 'status');
  const files = (job.files || []).filter(f => f.fileName).map(f => f.fileName);
  const text = document.createElement('div');
  text.textContent = filled
    ? 'EXTREMELY filled this form. Pass the check, then press the site’s submit button. Your own login for this site comes back when you close this tab.'
    : 'EXTREMELY opened this page, but no filled fields were copied. Pass the check if you can, or use the agents’ browser tab.';
  if (files.length) text.textContent += ' Choose the file again: ' + files.join(', ') + '.';
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Hide';
  close.addEventListener('click', () => bar.remove());
  bar.append(text, close);
  bar.style.cssText = 'position:fixed;bottom:12px;left:12px;right:12px;z-index:2147483647;display:flex;gap:12px;align-items:center;background:#1c1b22;color:#fff;padding:12px 14px;border-radius:10px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)';
  close.style.cssText = 'margin-left:auto;background:transparent;color:#fff;border:1px solid #fff;border-radius:8px;padding:4px 8px;cursor:pointer';
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
  applyStorage(job.storage);
  // The bar shows even if filling failed. A page that redraws itself (most sites
  // built with React and the like) can drop it: it's put back while the page settles.
  let filled = 0;
  const run = () => {
    try {
      filled = Math.max(filled, fill(job));
    } catch (e) {
      console.error('[person-chrome] fill failed', e.message);
    }
    if (document.body && !document.getElementById('eaa-person-chrome')) banner(job, filled > 0);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run);
  else run();
  if (!first) return;
  for (const ms of [300, 1000, 2500, 5000, 8000, 12000]) setTimeout(run, ms);
  document.addEventListener(
    'submit',
    () => {
      console.log('[person-chrome] form submitted', job.id);
      chrome.runtime.sendMessage({ type: 'submitted', id: job.id });
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      const button = event.target?.closest?.('button, input[type="submit"]');
      if (!button || button.id === 'eaa-person-chrome' || button.closest('#eaa-person-chrome')) return;
      const type = (button.getAttribute('type') || (button.tagName === 'BUTTON' ? 'submit' : '')).toLowerCase();
      if (type === 'button' || type === 'reset') return;
      const label = (button.innerText || button.value || '').replace(/\s+/g, ' ').trim();
      if (type !== 'submit' && !/submit|create|sign ?up|register|continue/i.test(label)) return;
      console.log('[person-chrome] submit control clicked', job.id);
      chrome.runtime.sendMessage({ type: 'submitted', id: job.id });
    },
    true,
  );
})().catch(e => console.error('[person-chrome] restore failed', e.message));
