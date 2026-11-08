import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Claude Code crashing in the middle of a turn ("Bun has crashed", exit 134) used
// to fail the whole run, after the agent had already done its work. The turn now
// carries on from the session it saved. A stand-in Claude Code crashes once.

test('a Claude Code crash mid-turn resumes its session instead of failing the run', async () => {
  const home = await mkdtemp(join(tmpdir(), 'eaa-fake-claude-'));
  const log = join(home, 'calls.log');
  const script = join(home, 'fake-claude.mjs');
  await writeFile(
    script,
    `import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
let prompt = '';
for await (const c of process.stdin) prompt += c;
const flag = args.includes('--resume') ? '--resume' : '--session-id';
const id = args[args.indexOf(flag) + 1];
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ flag, id, prompt }) + '\\n');
const dir = join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'run');
mkdirSync(dir, { recursive: true });
const file = join(dir, id + '.jsonl');
if (!existsSync(file)) {
  writeFileSync(file, '{}\\n'); // the agent got some way, then the runtime fell over
  process.stderr.write('panic(main thread): abort() called\\noh no: Bun has crashed. This indicates a bug in Bun, not your code.\\n');
  process.exit(134);
}
console.log(JSON.stringify({ result: 'Added 5 leads.', session_id: id, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 }));
`,
  );
  const win = process.platform === 'win32';
  if (win) {
    process.env.APPDATA = home;
    await mkdir(join(home, 'npm'), { recursive: true });
    await writeFile(join(home, 'npm', 'claude.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    await mkdir(join(home, '.local', 'bin'), { recursive: true });
    const bin = join(home, '.local', 'bin', 'claude');
    await writeFile(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude');

  const { harnessFor } = await import('./harness.js');
  const out = await harnessFor('claude-code')!({ model: 'claude-test', system: 'You find leads.', opening: 'Find leads.', tools: [], call: async () => ({ content: '', error: false }), next: () => null });
  assert.equal(out.text, 'Added 5 leads.');

  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(l => JSON.parse(l) as { flag: string; id: string; prompt: string });
  assert.equal(calls.length, 2);
  assert.deepEqual([calls[0].flag, calls[0].prompt], ['--session-id', 'Find leads.']);
  assert.equal(calls[1].flag, '--resume');
  assert.equal(calls[1].id, calls[0].id, 'the same session carries on');
  assert.match(calls[1].prompt, /Carry on from where you were/);
});

test('what counts as Claude Code crashing, and what is a real answer', async () => {
  const { crashed } = await import('./harness.js');
  assert.ok(crashed(null, 'SIGABRT', ''));
  assert.ok(crashed(134, null, ''));
  assert.ok(crashed(1, null, 'oh no: Bun has crashed.'));
  assert.ok(!crashed(1, null, 'Error: Invalid API key'));
  assert.ok(!crashed(1, null, ''));
});
