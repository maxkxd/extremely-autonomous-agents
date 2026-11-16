// Runs on loopback pages, and acts only on the pairing page EXTREMELY opens:
// http://127.0.0.1:<port>/browser/connect#eaa1:...
// It hands the link to the worker and reports back to the page two ways, which the
// page's own script turns into words:
//   document.body.dataset.eaa = 'pairing' | 'paired' | 'error:<message>'
//   window.postMessage({eaa: 'paired', agency, browser} | {eaa: 'error', error})
// document.documentElement.dataset.eaaExtension says the extension is installed at all.
(() => {
  if (location.pathname !== '/browser/connect') return;
  if (!/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) return;
  document.documentElement.dataset.eaaExtension = chrome.runtime.getManifest().version;

  const link = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
  const body = () => document.body || document.documentElement;
  const tell = (res) => {
    if (res.ok) {
      body().dataset.eaa = 'paired';
      window.postMessage({ eaa: 'paired', agency: res.agency || '', browser: res.browser ?? null }, location.origin);
    } else {
      body().dataset.eaa = 'error:' + res.error;
      window.postMessage({ eaa: 'error', error: res.error }, location.origin);
    }
  };
  if (!link.startsWith('eaa1:')) {
    tell({ error: 'This page has no pairing link. Press Connect a browser in EXTREMELY again.' });
    return;
  }
  // The code works once: a reload mustn't try it again.
  history.replaceState(null, '', location.pathname);
  body().dataset.eaa = 'pairing';

  const ask = (confirmed) => {
    chrome.runtime.sendMessage({ type: 'pair', link, confirmed }, (res) => {
      if (chrome.runtime.lastError) {
        console.error('[eaa]', chrome.runtime.lastError.message);
        return tell({ error: chrome.runtime.lastError.message });
      }
      if (res?.confirm) {
        // An agency on another computer: only with the person's yes, since any website
        // could open this page with a link of its own.
        const yes = window.confirm(`Let the agents of "${res.confirm.agency}" (${res.confirm.host}) use this browser?`);
        return yes ? ask(true) : tell({ error: 'Not paired: you said no.' });
      }
      if (!res || res.error) {
        console.error('[eaa] pairing failed', res?.error);
        return tell({ error: res?.error || 'No answer from the extension.' });
      }
      tell(res);
    });
  };
  ask(false);
})();
