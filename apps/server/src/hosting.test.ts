import './test-data-dir.js';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { forward } from './hosting.js';

// The organization hosted on this computer is reached through the app's own agency
// (hosting.ts): the app must never say it "isn't answering" just because it was
// starting, or a connection was reused - and never send a change twice.

const servers: Server[] = [];
after(() => servers.forEach(s => s.close()));
const listen = (s: Server, port = 0) => new Promise<number>(r => s.listen(port, '127.0.0.1', () => r((s.address() as AddressInfo).port)));
const freePort = async () => {
  const s = createServer();
  const port = await listen(s);
  await new Promise(r => s.close(r));
  return port;
};

// The app's side: passes /hosted requests on to the organization's agency.
async function front(o: Parameters<typeof forward>[3]) {
  const s = createServer((req, res) => void forward(req, res, req.url ?? '/', o));
  servers.push(s);
  return `http://127.0.0.1:${await listen(s)}`;
}

test('a request made while the agency is starting waits for it, instead of failing', async () => {
  const port = await freePort();
  let up = false;
  const url = await front({ port, isUp: () => up, hosted: () => true, startWaitMs: 5_000 });
  const pending = fetch(`${url}/api/runner/approvals`);
  // It comes up a moment later.
  await new Promise(r => setTimeout(r, 300));
  const agency = createServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"approvals":[]}'));
  servers.push(agency);
  await listen(agency, port);
  up = true;
  const res = await pending;
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { approvals: [] });
});

test('one refused (it was starting again) is sent once it answers - a change too, since nothing reached it', async () => {
  const port = await freePort();
  const url = await front({ port, isUp: () => true, hosted: () => true, retryMs: 300 });
  const got: string[] = [];
  setTimeout(() => {
    const agency = createServer((req, res) => {
      let b = '';
      req.on('data', c => (b += c)).on('end', () => (got.push(`${req.method} ${b}`), res.writeHead(200).end('{"ok":true}')));
    });
    servers.push(agency);
    void listen(agency, port);
  }, 400);
  const res = await fetch(`${url}/api/runner/approvals/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":"apv_1","decision":"approved"}' });
  assert.equal(res.status, 200);
  assert.deepEqual(got, ['POST {"id":"apv_1","decision":"approved"}']);
});

test('a change that may have reached it is never sent again; a read is', async () => {
  let hits = 0;
  const agency = createServer((req, res) => {
    hits++;
    // Drops the first connection of each kind mid-request, as a closing connection would.
    if (hits === 1 || (req.method === 'GET' && hits === 3)) return req.socket.destroy();
    res.writeHead(200).end('{"ok":true}');
  });
  servers.push(agency);
  const port = await listen(agency);
  const url = await front({ port, isUp: () => true, hosted: () => true, retryMs: 50 });
  const post = await fetch(`${url}/api/runner/approvals/decide`, { method: 'POST', body: '{}' });
  assert.equal(post.status, 502);
  assert.equal(hits, 1);
  hits = 2;
  const get = await fetch(`${url}/api/runner/approvals`);
  assert.equal(get.status, 200);
  assert.equal(hits, 4);
});
