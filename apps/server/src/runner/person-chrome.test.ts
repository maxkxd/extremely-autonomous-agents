import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromeLine, cookiesForSite, prepareSnapshot, type PersonCookie, type RawSnapshot } from './person-chrome.js';

const filled: RawSnapshot = {
  title: 'Create an account',
  fields: [
    { tag: 'INPUT', type: 'hidden', name: 'csrf', id: '', value: 'old-token', checked: false },
    { tag: 'INPUT', type: 'hidden', name: 'cf-turnstile-response', id: '', value: 'turnstile-token', checked: false },
    { tag: 'INPUT', type: 'text', name: 'name', id: 'name', value: 'Sam Example', checked: false, label: 'Name' },
    { tag: 'INPUT', type: 'email', name: 'email', id: 'email', value: 'person@example.test', checked: false, label: 'Email' },
    { tag: 'INPUT', type: 'password', name: 'password', id: 'password', value: 'a-real-password', checked: false, label: 'Password' },
    { tag: 'INPUT', type: 'text', name: 'empty', id: 'empty', value: '   ', checked: false },
    { tag: 'INPUT', type: 'checkbox', name: 'terms', id: 'terms', value: 'yes', checked: true, label: 'I agree' },
    { tag: 'INPUT', type: 'checkbox', name: 'news', id: 'news', value: 'yes', checked: false },
    { tag: 'INPUT', type: 'submit', name: '', id: '', value: 'Create an account', checked: false },
    { tag: 'INPUT', type: 'file', name: 'logo', id: 'logo', fileName: 'mark.png' },
  ],
  storage: {
    local: { draft: '{"step":1}', 'cf-turnstile-response': 'nope', big: 'x'.repeat(9000) },
    session: { wizard: 'account' },
  },
  cookies: [
    { name: 'sid', value: 'agent-session', domain: '.aitoolfame.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 1_900_000_000 },
    { name: 'elsewhere', value: 'no', domain: '.other.test', path: '/', secure: true, httpOnly: false, sameSite: 'Lax', expires: 1_900_000_000 },
    { name: 'part', value: 'no', domain: '.aitoolfame.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax', expires: 1_900_000_000, partitionKey: 'x' },
    { name: 'loose', value: 'no', domain: '.aitoolfame.com', path: '/', secure: false, httpOnly: false, sameSite: 'None' },
  ],
};

test('a handoff keeps what the person needs to press Submit, and drops the check itself', () => {
  const out = prepareSnapshot(filled, 'aitoolfame.com');
  assert.deepEqual(out.fields.map(f => f.name), ['name', 'email', 'password', 'terms']);
  assert.equal(out.fields.find(f => f.name === 'password')?.value, 'a-real-password');
  assert.equal(out.fields.find(f => f.name === 'terms')?.checked, true);
  assert.deepEqual(out.files, [{ name: 'logo', fileName: 'mark.png' }]);
  assert.deepEqual(out.storage.local, { draft: '{"step":1}' });
  assert.deepEqual(out.storage.session, { wizard: 'account' });
  assert.deepEqual(out.cookies.map(c => c.name), ['sid']);
  assert.equal(out.droppedCookies, 3);
  assert.equal(out.droppedStorage, 2);
  assert.equal(JSON.stringify(out).includes('turnstile-token'), false);
  assert.equal(JSON.stringify(out).includes('old-token'), false);
});

test("cookies copied back are only the site the person just finished", () => {
  const cookies: PersonCookie[] = [
    { name: 'sid', value: '1', domain: '.aitoolfame.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' },
    { name: 'www', value: '1', domain: 'www.aitoolfame.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' },
    { name: 'other', value: '1', domain: '.google.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' },
  ];
  assert.deepEqual(cookiesForSite(cookies, 'aitoolfame.com').map(c => c.name), ['sid', 'www']);
});

test('the Chrome line is the one the request button matches', () => {
  const line = chromeLine('ab'.repeat(16));
  const re = /^\s*(?:[A-Za-z][\w ]{0,20}:\s*)?Open in your (?:Chrome|browser):\s*(https?:\/\/[^\s<>"']+)/i;
  const m = re.exec(line);
  assert.ok(m);
  assert.match(m[1], /\/person-chrome\/go\?id=abab/);
});

// The cloud: the agency copies its kept page, the app hands it to this computer's
// server, the person's browser finishes it here, and the app sends it back.
test('a page from an agency in the cloud is held for the browser here, and finished back through the app', async () => {
  const { createServer } = await import('node:http');
  const pc = await import('./person-chrome.js');
  const opened: string[] = [];
  pc.setPersonBrowserOpener((_k, url) => void opened.push(url));
  let agencyGot: unknown = null;
  pc.onPersonChromeDone(async (h, cookies) => void (agencyGot = { h, cookies }));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!(await pc.handlePersonChromeHttp(req, res, url))) res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const app = (path: string, body?: object, header = true) =>
    fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(header ? { 'x-eaa-app': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  try {
    const token = await pc.ensurePersonChromeToken();
    const ext = (path: string, body?: object) =>
      fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
    const id = 'c'.repeat(32);
    const handoff = { v: 1, id, created: 1, requestId: 182, profile: 1, site: 'twimlai.com', url: 'https://twimlai.com/contact/', title: 'Contact', what: 'Pass the check', fields: [{ tag: 'INPUT', type: 'email', name: 'email', id: 'email', value: 'a@b.c', checked: false, placeholder: '', autocomplete: '', label: 'Email' }], files: [], storage: { local: {}, session: {} }, cookies: [{ name: 'sid', value: 'agent', domain: '.twimlai.com', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }, { name: 'x', value: 'no', domain: 'bank.test', path: '/', secure: true, httpOnly: true, sameSite: 'Lax' }] };

    assert.equal((await app('/api/person-chrome/app/stage', { handoff }, false)).status, 403, 'needs the app header');
    assert.equal((await app('/api/person-chrome/app/stage', { handoff: { ...handoff, url: 'https://evil.test/' } })).status, 400, 'address must match its site');
    assert.equal((await app('/api/person-chrome/app/stage', { handoff })).status, 200);
    assert.deepEqual(opened, [pc.chromeGoUrl(id)], 'opens the go page in the browser here');

    const job = (await (await ext(`/api/person-chrome/ext/job?id=${id}`)).json()) as { handoff: { remote?: boolean; cookies: { domain: string }[] } };
    assert.equal(job.handoff.remote, true);
    assert.deepEqual(job.handoff.cookies.map(c => c.domain), ['.twimlai.com'], "another site's cookie never reaches the browser");

    assert.equal((await ext('/api/person-chrome/ext/done', { id, cookies: [{ name: 'cf_clearance', value: 'ok', domain: '.twimlai.com', path: '/', secure: true, httpOnly: true, sameSite: 'None' }] })).status, 200);
    assert.equal(agencyGot, null, 'not finished on this computer: its agency is elsewhere');
    const fin = (await (await app('/api/person-chrome/app/finished')).json()) as { finished: { id: string; cookies: { name: string }[] }[] };
    assert.deepEqual(fin.finished.map(f => [f.id, f.cookies.map(c => c.name)]), [[id, ['cf_clearance']]]);
    await app('/api/person-chrome/app/finished/ack', { id });
    assert.deepEqual(((await (await app('/api/person-chrome/app/finished')).json()) as { finished: unknown[] }).finished, []);

    // The agency's half: a fresh copy replaces the last for the request, and what comes back finishes it there.
    const fields = { requestId: 183, profile: 1, site: 'changelog.com', url: 'https://changelog.com/join', title: 'Join', what: 'x', fields: [], files: [], storage: { local: {}, session: {} }, cookies: [] };
    const first = await pc.queueFreshHandoff(fields);
    const second = await pc.queueFreshHandoff(fields);
    await assert.rejects(pc.finishFromApp(first.id, []), /no longer waiting/);
    await pc.finishFromApp(second.id, [{ name: 'sid', value: 'v', domain: '.changelog.com', path: '/' }, { name: 'x', value: 'no', domain: 'other.test', path: '/' }]);
    const got = agencyGot as unknown as { h: { requestId: number }; cookies: { name: string }[] };
    assert.equal(got.h.requestId, 183);
    assert.deepEqual(got.cookies.map(c => c.name), ['sid']);
  } finally {
    server.close();
  }
});
