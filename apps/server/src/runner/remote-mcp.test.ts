import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { beforeEach, test } from 'node:test';
import { resetDbForTests } from './db.js';
import { answerRemoteMcp, handleRemoteMcp, isRemoteMcpUrl, remoteMcpUrl, takeRemoteMcp } from './remote-mcp.js';

// A teammate's AI assistant for an organization hosted elsewhere: its messages
// wait on their own computer until their app carries them to the host.

beforeEach(() => resetDbForTests());

// Serves the remote addresses on a free port; posts go to the same paths.
async function serve() {
  const server = createServer(async (req, res) => {
    if (!(await handleRemoteMcp(req, res, new URL(req.url ?? '/', 'http://x').pathname))) res.writeHead(404).end();
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const post = (url: string, body: unknown) =>
    fetch(`http://127.0.0.1:${port}${new URL(url).pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { post, close: () => server.close() };
}

test('each organization keeps one address, and only those are taken for remote ones', () => {
  const a = remoteMcpUrl('org-a');
  assert.equal(remoteMcpUrl('org-a'), a);
  assert.notEqual(remoteMcpUrl('org-b'), a);
  assert.ok(isRemoteMcpUrl(a));
  assert.ok(!isRemoteMcpUrl(a.replace(/.$/, '0')));
});

test("a message waits for the app, which carries it and brings the host's answer back", async () => {
  const s = await serve();
  try {
    const sent = s.post(remoteMcpUrl('org-a'), { jsonrpc: '2.0', id: 7, method: 'tools/list' });
    const [call] = await takeRemoteMcp(2000);
    assert.equal(call.orgId, 'org-a');
    assert.deepEqual(call.msg, { jsonrpc: '2.0', id: 7, method: 'tools/list' });
    answerRemoteMcp(call.id, { jsonrpc: '2.0', id: 7, result: { tools: [] } });
    assert.deepEqual(await (await sent).json(), { jsonrpc: '2.0', id: 7, result: { tools: [] } });
  } finally {
    s.close();
  }
});

test("a message the app couldn't send comes back as an error that says why", async () => {
  const s = await serve();
  try {
    const sent = s.post(remoteMcpUrl('org-a'), { jsonrpc: '2.0', id: 1, method: 'ping' });
    const [call] = await takeRemoteMcp(2000);
    answerRemoteMcp(call.id, null, "Northside Bikes's host is offline.");
    const reply = await (await sent).json();
    assert.equal(reply.id, 1);
    assert.match(reply.error.message, /offline/);
  } finally {
    s.close();
  }
});

test('notifications are taken without waiting for anyone', async () => {
  const s = await serve();
  try {
    const res = await s.post(remoteMcpUrl('org-a'), { jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(res.status, 202);
    assert.deepEqual(await takeRemoteMcp(0), []);
  } finally {
    s.close();
  }
});
