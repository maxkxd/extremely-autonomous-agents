// Pairing links and the few facts about this browser that go in `hello`.
// No chrome.* here, so it runs the same in the worker and in Node tests.

export const PROTOCOL = 1;

const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])$/;

export function isLoopbackHost(host) {
  return LOOPBACK.test(String(host || ''));
}

// "eaa1:<base64url({u, c, n})>", as the agency's Connectors > Browser hands it out.
// Accepts it with a leading "#" or whatever else was pasted around it (a page's address).
export function decodeLink(raw) {
  const text = String(raw ?? '').trim();
  const at = text.indexOf('eaa1:');
  if (at < 0) throw new Error('That is not an EXTREMELY pairing link. It starts with eaa1:');
  const body = text.slice(at + 5).trim().replace(/[^A-Za-z0-9_-].*$/s, '');
  let data;
  try {
    data = JSON.parse(utf8(fromBase64Url(body)));
  } catch (e) {
    throw new Error('That pairing link is cut short or changed. Copy it again.');
  }
  if (!data || typeof data !== 'object') throw new Error('That pairing link has nothing in it.');
  let url;
  try {
    url = new URL(String(data.u || ''));
  } catch (e) {
    throw new Error('That pairing link has no agency address.');
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('That pairing link has an address that is not a WebSocket one.');
  // A token sent over plain ws to another computer can be read on the way. Only this
  // computer may use ws; anything else must be wss.
  if (url.protocol === 'ws:' && !isLoopbackHost(url.hostname)) throw new Error('That agency is on another computer without a secure (wss) address. Pairing refused.');
  const code = String(data.c || '').trim();
  if (!code || code.length > 64) throw new Error('That pairing link has no code.');
  const name = String(data.n || '').trim().slice(0, 120) || url.host;
  return { url: url.href, code, name };
}

// The other half, for tests and tools.
export function encodeLink({ u, c, n }) {
  const bytes = new TextEncoder().encode(JSON.stringify({ u, c, n }));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'eaa1:' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
}

function utf8(bin) {
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function browserKind(userAgent) {
  return /Edg\//.test(String(userAgent || '')) ? 'edge' : 'chrome';
}

export function defaultLabel(kind) {
  return kind === 'edge' ? 'Edge' : 'Chrome';
}
