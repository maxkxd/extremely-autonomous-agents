import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeExtension, cursorLink, zip } from './assistant.js';

// Your AI assistant: the Claude Desktop extension and Cursor's install link.

const ADDRESS = 'http://127.0.0.1:5175/mcp/' + 'a'.repeat(48);

// Reads a stored (uncompressed) zip back: name -> contents.
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  let at = 0;
  while (buf.readUInt32LE(at) === 0x04034b50) {
    const size = buf.readUInt32LE(at + 18);
    const nameLen = buf.readUInt16LE(at + 26);
    const name = buf.subarray(at + 30, at + 30 + nameLen).toString('utf8');
    out.set(name, buf.subarray(at + 30 + nameLen, at + 30 + nameLen + size).toString('utf8'));
    at += 30 + nameLen + size;
  }
  return out;
}

test('the zip holds each file as written, with a central directory at the end', () => {
  const buf = zip([
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir/b.txt', data: Buffer.from('world') },
  ]);
  const files = unzip(buf);
  assert.equal(files.get('a.txt'), 'hello');
  assert.equal(files.get('dir/b.txt'), 'world');
  // End of central directory: two entries.
  const end = buf.length - 22;
  assert.equal(buf.readUInt32LE(end), 0x06054b50);
  assert.equal(buf.readUInt16LE(end + 10), 2);
});

test("the Claude Desktop extension has a 0.3 manifest pointing its bridge at this agency's address", () => {
  const files = unzip(claudeExtension(ADDRESS));
  const manifest = JSON.parse(files.get('manifest.json')!);
  assert.equal(manifest.manifest_version, '0.3');
  for (const field of ['name', 'version', 'description', 'author', 'server']) assert.ok(manifest[field], field);
  assert.equal(manifest.server.entry_point, 'server/index.js');
  assert.equal(manifest.server.mcp_config.env.AGENCY_MCP_URL, ADDRESS);
  assert.match(files.get('server/index.js')!, /AGENCY_MCP_URL/);
});

test("Cursor's link carries the address as its base64 config", () => {
  const link = new URL(cursorLink(ADDRESS));
  assert.equal(link.protocol, 'cursor:');
  assert.equal(link.searchParams.get('name'), 'agency');
  assert.deepEqual(JSON.parse(Buffer.from(link.searchParams.get('config')!, 'base64').toString()), { url: ADDRESS });
});
