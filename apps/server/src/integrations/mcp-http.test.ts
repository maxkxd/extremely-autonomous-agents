import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { listMcpTools } from './mcp-client.js';
import { Integration, type McpIntegration } from './schema.js';

// A streamable-HTTP MCP server at /mcp that answers its old /sse address with
// 405, the way Asana's and DeepWiki's do.
let server: Server;
let base: string;
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c)).on('end', () => {
      if (req.url !== '/mcp') return res.writeHead(req.url === '/sse' ? 405 : 404).end('Method Not Allowed');
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
