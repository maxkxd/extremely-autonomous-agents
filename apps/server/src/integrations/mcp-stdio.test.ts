import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { callMcpTool, listMcpTools } from './mcp-client.js';
import { stopStdioServer } from './mcp-stdio.js';
import { Integration, type McpIntegration } from './schema.js';

// A whole MCP server on stdio, in a few lines: one tool that echoes.
const SERVER = `
import { createInterface } from 'node:readline';
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
console.log('some startup logging on stdout');
createInterface({ input: process.stdin }).on('line', l => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 't', version: '1' } } });
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] } });
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'echo:' + m.params.arguments.x }] } });
});
`;

let dir: string;
let integration: McpIntegration;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eaa stdio test-')); // a space in the path, like a "My Notes" folder
  await writeFile(join(dir, 'server.mjs'), SERVER);
  integration = Integration.parse({ kind: 'mcp', id: 'zz-stdio', name: 'Local test', what: 'x', auth: { type: 'none' }, command: ['node', join(dir, 'server.mjs')] }) as McpIntegration;
});
after(async () => {
  stopStdioServer('zz-stdio');
  await rm(dir, { recursive: true, force: true });
});

test('an MCP server on this computer: started, its tools found and called, the process reused', async () => {
  const tools = await listMcpTools(integration, undefined);
  assert.deepEqual(tools.map(t => [t.name, t.readOnly]), [['echo', true]]);
  assert.equal(await callMcpTool(integration, undefined, 'echo', { x: 'hi' }), 'echo:hi');
  assert.equal(await callMcpTool(integration, undefined, 'echo', { x: 'again' }), 'echo:again');
});
