import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cursorLink, withAgency } from './assistant.js';

// Your AI assistant: Claude Desktop's settings, and Cursor's install link.

const ADDRESS = 'http://127.0.0.1:5175/mcp/' + 'a'.repeat(48);
const SERVER = { command: 'node', args: ['bridge.js'], env: { AGENCY_MCP_URL: ADDRESS } };

test("Claude Desktop's settings get the agency, and keep everything else", () => {
  const before = JSON.stringify({ preferences: { theme: 'dark' }, mcpServers: { other: { command: 'x', args: [] } } });
  const after = JSON.parse(withAgency(before, 'extremely-autonomous-agents', SERVER));
  assert.deepEqual(after.preferences, { theme: 'dark' });
  assert.deepEqual(after.mcpServers.other, { command: 'x', args: [] });
  assert.deepEqual(after.mcpServers['extremely-autonomous-agents'], SERVER);
});

test('settings that are missing or empty start fresh; connecting again updates the address', () => {
  const first = withAgency(null, 'extremely-autonomous-agents', SERVER);
  const again = JSON.parse(withAgency(first, 'extremely-autonomous-agents', { ...SERVER, env: { AGENCY_MCP_URL: 'http://new' } }));
  assert.deepEqual(Object.keys(again.mcpServers), ['extremely-autonomous-agents']);
  assert.equal(again.mcpServers['extremely-autonomous-agents'].env.AGENCY_MCP_URL, 'http://new');
  assert.deepEqual(JSON.parse(withAgency('  ', 'k', SERVER)).mcpServers.k, SERVER);
});

test("settings that aren't JSON are never written over", () => {
  assert.throws(() => withAgency('{ not json', 'k', SERVER));
});

test("Cursor's link carries the address as its base64 config", () => {
  const link = new URL(cursorLink(ADDRESS, 'extremely-autonomous-agents-northside-bikes'));
  assert.equal(link.protocol, 'cursor:');
  assert.equal(link.searchParams.get('name'), 'extremely-autonomous-agents-northside-bikes');
  assert.deepEqual(JSON.parse(Buffer.from(link.searchParams.get('config')!, 'base64').toString()), { url: ADDRESS });
});
