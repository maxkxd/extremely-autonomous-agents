// Runs on loopback pages only. Connects this Chrome or Edge, or opens a filled-in page.
// Only EXTREMELY's own two pages, on its own port: any other local page (a dev server,
// another app) could otherwise pair this browser to itself.
const EXTREMELY_PORT = '5175';
const OURS = ['/person-chrome/connect', '/person-chrome/go'];
const meta = OURS.includes(location.pathname) && location.port === EXTREMELY_PORT ? document.querySelector('meta#eaa-chrome') : null;
const here = /Edg\//.test(navigator.userAgent) ? 'Edge' : 'Chrome';
if (meta && (location.hostname === '127.0.0.1' || location.hostname === 'localhost')) {
  const status = document.getElementById('status');
  const install = document.getElementById('install');
  const say = (text) => {
    if (status) status.textContent = text;
  };
  const kind = meta.dataset.kind;
  const done = (err) => {
    if (chrome.runtime.lastError) {
      console.error('[person-chrome]', chrome.runtime.lastError.message);
      say(chrome.runtime.lastError.message);
      return;
    }
    if (err) {
      console.error('[person-chrome]', err);
      say(err);
      return;
    }
    if (install) install.hidden = true;
  };
  if (kind === 'connect') {
    chrome.runtime.sendMessage({ type: 'pair', apiBase: location.origin, token: meta.dataset.token || '' }, (res) => {
      done(res?.error);
      if (!res?.error && !chrome.runtime.lastError) say('This ' + here + ' is connected. You can close this window.');
    });
  } else if (kind === 'go') {
    chrome.runtime.sendMessage({ type: 'open-handoff', id: meta.dataset.id || '' }, (res) => {
      done(res?.error);
      if (!res?.error && !chrome.runtime.lastError) {
        say(res.already ? 'That page is already open in this ' + here + '.' : 'The filled-in page is open in this ' + here + '. Pass the check and press Submit. You can close this window.');
      }
    });
  } else {
    console.error('[person-chrome] this page has no role');
    say('This page is not a connect or finish page.');
  }
}
