// A classic script (popup.html): top-level await threw, and it said "Checking the connection…" forever.
(async () => {
const state = document.getElementById('state');
const { pair: saved } = await chrome.storage.local.get('pair');
if (!saved?.token) {
  state.textContent = 'Not connected. In EXTREMELY, open Settings, then Connectors, then Signed-in browser, then Connect Chrome or Connect Edge.';
} else {
  const res = await chrome.runtime.sendMessage({ type: 'hello' });
  if (chrome.runtime.lastError) {
    console.error('[person-chrome]', chrome.runtime.lastError.message);
    state.textContent = chrome.runtime.lastError.message;
  } else if (res?.error) {
    console.error('[person-chrome]', res.error);
    state.textContent = res.error;
  } else {
    state.textContent = 'Connected. When an agent asks, the filled-in page opens here. Pass the check and press Submit.';
  }
}
})().catch(e => console.error('[person-chrome] popup failed', e.message));
