// Debug: one tiny prompt through the person's own Claude Code, on their Claude
// plan. The server's Anthropic key is removed from the environment, so it can
// only use their Claude sign-in.
//   npx tsx scripts/claude-code-test.ts
import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { claudeCodeStatus } from '../src/models/connections.js';

const run = promisify(execFile);
const env = { ...process.env };
delete env.ANTHROPIC_API_KEY;
delete env.ANTHROPIC_AUTH_TOKEN;

const status = await claudeCodeStatus();
console.log('status:', JSON.stringify(status));
if (!status.loggedIn) process.exit(1);

// An empty folder, so no project files or settings come into it.
const cwd = await mkdtemp(join(tmpdir(), 'eaa-claude-test-'));
// Isolated the way an agent run will be: none of the person's own settings,
// plugins, hooks, skills or MCP connectors - only what the agent is given.
// (--bare would also do this, but it refuses the Claude account login.)
const isolate = [
  '--setting-sources', '',
  '--strict-mcp-config',
  '--tools', '',
  '--disable-slash-commands',
  '--system-prompt', 'You are a test agent. Do exactly what you are asked, nothing more.',
];
const { stdout } = await run('claude', ['-p', '"Reply with the single word: ok"', '--output-format', 'json', '--max-turns', '1', ...isolate.map(a => (a === '' ? '""' : a.includes(' ') ? `"${a}"` : a))], {
  cwd,
  env,
  timeout: 120_000,
  shell: process.platform === 'win32',
  windowsHide: true,
});
const r = JSON.parse(stdout) as { result?: string; is_error?: boolean; subtype?: string; duration_ms?: number };
console.log('reply:', JSON.stringify(r.result), '| error:', !!r.is_error, '|', r.subtype, `| ${r.duration_ms}ms`);
