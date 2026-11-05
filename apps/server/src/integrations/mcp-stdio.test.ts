import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { callMcpTool, listMcpTools } from './mcp-client.js';
import { missing, stopStdioServer } from './mcp-stdio.js';
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

test("a program that isn't on this computer says what to install (a new computer has no npx)", () => {
  assert.match(missing('npx', "'npx' is not recognized as an internal or external command,\r\noperable program or batch file.") ?? '', /npx isn't installed.*Node\.js/);
  assert.match(missing('C:\\tools\\uvx.exe', "'C:\\tools\\uvx.exe' is not recognized as an internal or external command,") ?? '', /uvx\.exe isn't installed.*uv/);
  assert.match(missing('/opt/bin/thing', 'sh: /opt/bin/thing: No such file or directory') ?? '', /isn't on this computer/);
  assert.equal(missing('npx', 'Error: something else broke'), null);
});

// A server that asks us something first, with the same id as our request, and
// writes down its process id - to see it answered right, and really stopped.
const ASKING = `
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], String(process.pid));
const send = m => process.stdout.write(JSON.stringify(m) + '\\n');
let waiting = null;
createInterface({ input: process.stdin }).on('line', l => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } } });
  if (m.method === 'tools/list') { waiting = m.id; return send({ jsonrpc: '2.0', id: m.id, method: 'ping' }); }
  // Our answer to its ping arrives: only now the tools.
  if (m.id === waiting && m.result) send({ jsonrpc: '2.0', id: waiting, result: { tools: [{ name: 'after_ping', inputSchema: { type: 'object' } }] } });
});
`;

test("a server on this computer asking us something (a ping, with an id like ours) is answered, not taken for our answer; stopped, it's really gone", async () => {
  await writeFile(join(dir, 'asking.mjs'), ASKING);
  const pidFile = join(dir, 'pid.txt');
  const asking = Integration.parse({ kind: 'mcp', id: 'zz-asking', name: 'Asking', what: 'x', auth: { type: 'none' }, command: ['node', join(dir, 'asking.mjs'), pidFile] }) as McpIntegration;
  assert.deepEqual((await listMcpTools(asking, undefined)).map(t => t.name), ['after_ping']);
  const { readFile } = await import('node:fs/promises');
  const pid = Number(await readFile(pidFile, 'utf8'));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(alive(), true);
  stopStdioServer('zz-asking');
  for (let i = 0; i < 40 && alive(); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(alive(), false);
});
