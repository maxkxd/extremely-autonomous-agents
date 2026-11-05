import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { filledUrl, listMcpTools } from './mcp-client.js';
import { Integration, type McpIntegration } from './schema.js';

// A streamable-HTTP MCP server at /mcp that answers its old /sse address with
// 405, the way Asana's and DeepWiki's do.
let server: Server;
let base: string;
// /flaky/mcp answers only while this is true: a service that goes down and comes back.
let up = true;
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c)).on('end', () => {
      // /v-old/mcp: a strict server on an older protocol version, refusing requests that name another.
      if (req.url === '/v-old/mcp') {
        const m = JSON.parse(body);
        if (m.method !== 'initialize' && req.headers['mcp-protocol-version'] !== '2025-03-26') return res.writeHead(400).end('Unsupported protocol version');
        if (m.id === undefined) return res.writeHead(202).end();
        const result = m.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} } } : { tools: [{ name: 'old', inputSchema: { type: 'object' } }] };
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      }
      // /split/mcp: answers as an event stream, its message over two "data:" lines.
      if (req.url === '/split/mcp') {
        const m = JSON.parse(body);
        if (m.id === undefined) return res.writeHead(202).end();
        const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } } : { tools: [{ name: 'split', inputSchema: { type: 'object' } }] };
        const json = JSON.stringify({ jsonrpc: '2.0', id: m.id, result }, null, 1);
        // Every line of the message on its own "data:" line, as the event-stream format allows.
        return res.writeHead(200, { 'content-type': 'text/event-stream' }).end(`event: message\r\n${json.split('\n').map(l => `data: ${l}`).join('\r\n')}\r\n\r\n`);
      }
      if (req.url === '/flaky/mcp' && !up) return res.writeHead(503).end('Service Unavailable');
      // /k-123/mcp: a server whose address carries the person's key (Zoho's).
      if (req.url !== '/mcp' && req.url !== '/k-123/mcp' && req.url !== '/flaky/mcp') return res.writeHead(req.url === '/sse' ? 405 : 404).end('Method Not Allowed');
      const m = JSON.parse(body);
      if (m.id === undefined) return res.writeHead(202).end();
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } } : { tools: [{ name: 'ask', inputSchema: { type: 'object' } }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const at = (path: string) => Integration.parse({ kind: 'mcp', id: 'zz-http', name: 'Wiki', what: 'x', auth: { type: 'none' }, url: base + path, local: true }) as McpIntegration;

test('an old .../sse MCP address is tried at .../mcp beside it', async () => {
  assert.deepEqual((await listMcpTools(at('/sse'), undefined)).map(t => t.name), ['ask']);
});

test('an .../sse address with nothing at .../mcp says what it is', async () => {
  await assert.rejects(listMcpTools(at('/old/sse'), undefined), /old SSE kind of MCP server.*ends in \/mcp/);
});

test("a sign-in by fields fills the address (Zoho's server name and key), and a field can't move the host", async () => {
  const zoho = Integration.parse({
    kind: 'mcp',
    id: 'zz-fields',
    name: 'Zoho',
    what: 'x',
    auth: { type: 'fields', fields: [{ name: 'token', label: 'Key' }] },
    url: `${base}/{{token}}/mcp`,
    local: true,
  }) as McpIntegration;
  assert.deepEqual((await listMcpTools(zoho, JSON.stringify({ token: 'k-123' }))).map(t => t.name), ['ask']);
  const host = 'https://{{server}}.zohomcp.com/mcp/{{api_key}}/message';
  assert.equal(filledUrl(host, 'https://agency-1234567890.zohomcp.com/mcp/k/message').host, 'agency-1234567890.zohomcp.com');
  assert.throws(() => filledUrl(host, 'https://evil.com/x?.zohomcp.com/mcp/k/message'), /valid address/);
});

test("a wrong new key that leaves the working one in place isn't sent to the Agency Engineer as broken", async () => {
  const { resetDbForTests } = await import('../runner/db.js');
  const { addIntegration, connectIntegration, listIntegrations, loadIntegrations, removeIntegration, whenConnectFailed } = await import('./index.js');
  resetDbForTests();
  await loadIntegrations();
  const told: string[] = [];
  whenConnectFailed(id => void told.push(id));
  await addIntegration({ kind: 'mcp', id: 'zz-replace', name: 'Replace', what: 'x', auth: { type: 'fields', fields: [{ name: 'token', label: 'Key' }] }, url: `${base}/{{token}}/mcp`, local: true });
  await connectIntegration('zz-replace', undefined, { token: 'k-123' });
  await assert.rejects(connectIntegration('zz-replace', undefined, { token: 'k-typo' }), /still in use/);
  assert.deepEqual(told, []);
  assert.equal((await listIntegrations()).find(i => i.id === 'zz-replace')?.repairing, false);
  await removeIntegration('zz-replace');
});

test('a server on an older protocol version is spoken to in that version after the handshake', async () => {
  assert.deepEqual((await listMcpTools(at('/v-old/mcp'), undefined)).map(t => t.name), ['old']);
});

test('a streamed answer split over several data lines is read whole', async () => {
  assert.deepEqual((await listMcpTools(at('/split/mcp'), undefined)).map(t => t.name), ['split']);
});

test('a working connection that breaks is noticed by the background check and goes to the Engineer; working again, the flag clears', async () => {
  const { resetDbForTests } = await import('../runner/db.js');
  const { addIntegration, connectIntegration, listIntegrations, loadIntegrations, recheckStale, removeIntegration, whenConnectFailed } = await import('./index.js');
  resetDbForTests();
  await loadIntegrations();
  const told: string[] = [];
  whenConnectFailed((id, how) => void told.push(`${id} ${how}`));
  await addIntegration({ kind: 'mcp', id: 'zz-flaky', name: 'Flaky', what: 'x', auth: { type: 'none' }, url: `${base}/flaky/mcp`, local: true });
  await connectIntegration('zz-flaky');
  const day = 25 * 3_600_000;
  const repairing = async () => (await listIntegrations()).find(i => i.id === 'zz-flaky')?.repairing;
  up = false;
  await recheckStale(Date.now() + day);
  assert.deepEqual(told, ['zz-flaky recheck']);
  assert.equal(await repairing(), true);
  up = true;
  await recheckStale(Date.now() + 2 * day);
  assert.equal(await repairing(), false);
  await removeIntegration('zz-flaky');
});
