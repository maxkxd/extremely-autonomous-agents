// The toolbar popup: the paired agencies, pairing by pasted link, pause, and this
// browser's name. All state lives in the worker; this only asks it.
// A classic script: popup.html loads it without type=module.
(() => {
  const $ = id => document.getElementById(id);

  function ask(msg) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(msg, res => {
        if (chrome.runtime.lastError) {
          console.error('[eaa]', chrome.runtime.lastError.message);
          return resolve({ error: chrome.runtime.lastError.message });
        }
        resolve(res || { error: 'No answer from the extension.' });
      });
    });
  }

  function el(tag, props = {}, ...kids) {
    const e = document.createElement(tag);
    Object.assign(e, props);
    e.append(...kids);
    return e;
  }

  function render(s) {
    if (s.error) {
      $('pairMsg').hidden = false;
      $('pairMsg').className = 'bad';
      $('pairMsg').textContent = s.error;
      return;
    }
    $('pause').checked = !!s.paused;
    $('paused').hidden = !s.paused;
    if (document.activeElement !== $('label')) $('label').value = s.label || '';
    $('none').hidden = s.pairings.length > 0;
    $('list').replaceChildren(...s.pairings.map(p => {
      const what = p.error
        ? el('span', { className: 'bad', textContent: p.error })
        : el('span', { className: 'dim', textContent: p.state === 'online' ? `${p.agentTabs} agent tab${p.agentTabs === 1 ? '' : 's'}` : p.state === 'connecting' ? 'connecting…' : 'offline' });
      const name = (p.browser ? `Browser ${p.browser} in ` : '') + p.agency;
      const actions = el('span');
      if (p.error) actions.append(el('button', { className: 'link', textContent: 'Retry', onclick: () => ask({ type: 'retry', url: p.url }).then(render) }), ' ');
      actions.append(el('button', {
        className: 'link',
        textContent: 'Remove',
        title: p.url,
        onclick: () => ask({ type: 'remove', url: p.url }).then(render),
      }));
      return el('li', {}, el('span', { className: 'dot' + (p.state === 'online' ? ' online' : '') }), el('span', {}, el('div', { textContent: name, title: p.url }), what), actions);
    }));
  }

  async function refresh() {
    render(await ask({ type: 'status' }));
  }

  $('pair').addEventListener('submit', async ev => {
    ev.preventDefault();
    const link = $('link').value.trim();
    if (!link) return;
    $('pairMsg').hidden = false;
    $('pairMsg').className = 'dim';
    $('pairMsg').textContent = 'Pairing…';
    const res = await ask({ type: 'pair', link });
    $('pairMsg').className = res.error ? 'bad' : 'dim';
    $('pairMsg').textContent = res.error || `Paired with ${res.agency}.`;
    if (!res.error) $('link').value = '';
    void refresh();
  });

  $('pause').addEventListener('change', async () => render(await ask({ type: 'pause', paused: $('pause').checked })));

  $('label').addEventListener('change', async () => render(await ask({ type: 'label', label: $('label').value })));

  void refresh();
  // Connections come and go while the popup is open.
  setInterval(() => void refresh(), 2000);
})();
