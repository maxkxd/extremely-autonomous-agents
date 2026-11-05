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
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c)).on('end', () => {
      // /k-123/mcp: a server whose address carries the person's key (Zoho's).
      if (req.url !== '/mcp' && req.url !== '/k-123/mcp') return res.writeHead(req.url === '/sse' ? 405 : 404).end('Method Not Allowed');
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
