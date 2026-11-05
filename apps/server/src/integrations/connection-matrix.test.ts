import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { httpRequest } from './http.js';
import { listMcpTools } from './mcp-client.js';
import { Auth, Integration, type HttpIntegration, type McpIntegration } from './schema.js';

// Every kind of connection with every kind of sign-in, end to end: what reaches the
// service carries the key, the token or the person's fields where the definition
// says. MCP servers with pasted fields once sent "{{server}}" as their address -
// a whole combination nobody had tried. A new kind of sign-in fails the last test
// here until it's covered.

const KEY = 'k-123';
// What the person's saved key looks like for each sign-in: a key, an access token
// (OAuth and MCP sign-ins), or their fields as JSON (a token step's token included).
const saved: Record<string, string | undefined> = {
  none: undefined,
  api_key: KEY,
  bearer: KEY,
  oauth2: KEY,
  mcp_oauth: KEY,
  fields: JSON.stringify({ account: 'acct-9', secret: KEY, token: 't-456' }),
};

const sign: Record<string, object> = {
  none: { type: 'none' },
  api_key: { type: 'api_key', header: 'x-api-key' },
  'api_key query': { type: 'api_key', query: 'api_key' },
  bearer: { type: 'bearer' },
  oauth2: { type: 'oauth2', authorize_url: 'https://auth.example.com/a', token_url: 'https://auth.example.com/t', scopes: ['all'] },
  mcp_oauth: { type: 'mcp_oauth' },
  'fields in a header': { type: 'fields', fields: [{ name: 'secret', label: 'Secret' }, { name: 'account', label: 'Account', secret: false }], headers: { authorization: 'Key {{secret}}' } },
  'fields in the query': { type: 'fields', fields: [{ name: 'secret', label: 'Secret' }], query: { key: '{{secret}}' } },
  'fields in the address': { type: 'fields', fields: [{ name: 'secret', label: 'Secret' }, { name: 'account', label: 'Account', secret: false }] },
};
const kindOf = (name: string) => name.split(' ')[0];

// What the service must have been sent, from what it received.
const expect: Record<string, (got: { path: string; headers: IncomingMessage['headers'] }) => void> = {
  none: g => assert.equal(g.headers.authorization, undefined),
  api_key: g => assert.equal(g.headers['x-api-key'], KEY),
  'api_key query': g => assert.match(g.path, new RegExp(`api_key=${KEY}`)),
  bearer: g => assert.equal(g.headers.authorization, `Bearer ${KEY}`),
  oauth2: g => assert.equal(g.headers.authorization, `Bearer ${KEY}`),
  mcp_oauth: g => assert.equal(g.headers.authorization, `Bearer ${KEY}`),
  'fields in a header': g => assert.equal(g.headers.authorization, `Key ${KEY}`),
  'fields in the query': g => assert.match(g.path, new RegExp(`key=${KEY}`)),
  'fields in the address': g => assert.match(g.path, new RegExp(`^/acct-9/${KEY}/`)),
};

// --- HTTP: the request each sign-in builds ----------------------------------------

for (const [name, auth] of Object.entries(sign)) {
  if (name === 'mcp_oauth') continue; // MCP only
  test(`http, ${name}: the key goes where the service wants it`, () => {
    const inAddress = name === 'fields in the address';
    const integration = Integration.parse({
      kind: 'http',
      id: 'zz-matrix',
      name: 'Matrix',
      what: 'x',
      auth,
      base_url: inAddress ? 'https://api.example.com/{{account}}/{{secret}}' : 'https://api.example.com',
      test: { tool: 'zz-matrix.list', args: {} },
      tools: [{ id: 'zz-matrix.list', tier: 'T0', description: 'x', input: { type: 'object' }, request: { method: 'GET', path: '/items' } }],
    }) as HttpIntegration;
    const r = httpRequest(integration, integration.tools[0], {}, saved[kindOf(name)]);
    const u = new URL(r.url);
    expect[name]({ path: u.pathname + u.search, headers: r.headers as IncomingMessage['headers'] });
    assert.equal(u.host, 'api.example.com');
  });
}

// --- MCP: a real (fake) server on this computer -------------------------------------

let server: Server;
let base: string;
const seen: { path: string; headers: IncomingMessage['headers'] }[] = [];
before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', c => (body += c)).on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers });
      const m = JSON.parse(body);
      if (m.id === undefined) return res.writeHead(202).end();
      const result = m.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } } : { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

for (const [name, auth] of Object.entries(sign)) {
  if (name === 'oauth2') continue; // an MCP server signs in with mcp_oauth, not a client the person made
  test(`mcp, ${name}: the server gets the key, and its tools are found`, async () => {
    seen.length = 0;
    const inAddress = name === 'fields in the address';
    const integration = Integration.parse({ kind: 'mcp', id: 'zz-matrix', name: 'Matrix', what: 'x', auth, url: inAddress ? `${base}/{{account}}/{{secret}}/mcp` : `${base}/mcp`, local: true }) as McpIntegration;
    assert.deepEqual((await listMcpTools(integration, saved[kindOf(name)])).map(t => t.name), ['ping']);
    assert.ok(seen.length >= 2);
    for (const got of seen) expect[name](got);
  });
}

// --- Nothing left out ---------------------------------------------------------------

test('every kind of sign-in the schema allows is covered above', () => {
  const kinds = Auth.options.map(o => o.shape.type.value);
  for (const k of kinds) assert.ok(Object.keys(sign).some(n => kindOf(n) === k), `"${k}" sign-ins have no connection test: add them to sign and expect above`);
});
