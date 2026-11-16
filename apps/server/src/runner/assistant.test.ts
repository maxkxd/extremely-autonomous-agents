import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeCodeCommand, cursorLink, isClaudeDesktop, vscodeLink, withAgency } from './assistant.js';

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

test('Claude Desktop is told apart from Claude Code, which is also a claude program', () => {
  assert.ok(isClaudeDesktop(String.raw`C:\Program Files\WindowsApps\Claude_4.4212.0.0_x64__pzs8sxrjxfjjc\app\Claude.exe`));
  assert.ok(isClaudeDesktop(String.raw`C:\Users\a\AppData\Local\AnthropicClaude\app-1.2.3\claude.exe`));
  assert.ok(!isClaudeDesktop(String.raw`C:\Users\a\AppData\Local\Claude-Data\claude_x\claude-code\2.1.309\9078b9c1d466\claude.exe`));
});

test('one connection for every agency: the earlier one-per-organization ones are dropped', () => {
  const before = JSON.stringify({ mcpServers: { 'extremely-autonomous-agents': SERVER, 'extremely-autonomous-agents-northside-bikes': SERVER, other: { command: 'x', args: [] } } });
  assert.deepEqual(Object.keys(JSON.parse(withAgency(before, 'extremely', SERVER)).mcpServers), ['other', 'extremely']);
});

test("VS Code's link and Claude Code's command carry the address", () => {
  const link = vscodeLink(ADDRESS);
  assert.ok(link.startsWith('vscode:mcp/install?'));
  assert.deepEqual(JSON.parse(decodeURIComponent(link.slice('vscode:mcp/install?'.length))), { name: 'extremely', type: 'http', url: ADDRESS });
  assert.equal(claudeCodeCommand(ADDRESS), `claude mcp add --transport http --scope user extremely ${ADDRESS}`);
});
