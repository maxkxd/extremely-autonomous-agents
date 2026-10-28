import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveAll, CopilotClient, defineTool, ToolSet } from '@github/copilot-sdk';
import { getSecret } from '../vault.js';
import { openBridge } from './mcp.js';
import { ModelError, type Call, type ToolSpec, type Usage } from './providers.js';

// Plans whose model comes with its own agent loop (docs/model-connections.md):
// Claude Code and GitHub Copilot. The runner hands over the instructions, the
// opening message and the agent's tools; each tool call comes back to the
// runner (tiers, limits, counting), and after every reply the runner says
// whether to nudge or stop - so floors work the same as on any other model.
// Both run isolated: none of the person's own settings, tools or files.

export type HarnessRun = {
  model: string;
  effort?: string;
  system: string;
  opening: string;
  tools: ToolSpec[];
  call: (c: Call) => Promise<{ content: string; error: boolean }>;
  next: () => string | null; // after each reply: a nudge to send, or null to end
  signal?: AbortSignal;
};
export type HarnessResult = { text: string; usage: Usage };
export type Harness = (r: HarnessRun) => Promise<HarnessResult>;

export function harnessFor(connection: string): Harness | null {
  if (connection === 'claude-code') return claudeCode;
  if (connection === 'copilot') return copilot;
  return null;
}

// --- Claude Code -------------------------------------------------------------------

const LIMIT = /usage limit|rate limit|limit reached|overloaded|429|too many requests/i;

// Its environment without any Anthropic key, so it can only use the person's
// own Claude sign-in (never the server's key, never billed by mistake).
function claudeEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

type ClaudeOut = { result?: string; is_error?: boolean; subtype?: string; session_id?: string; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };

// One `claude -p` call; the prompt goes in on stdin, so no shell quoting.
function claudeOnce(args: string[], prompt: string, cwd: string, signal?: AbortSignal): Promise<ClaudeOut> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, env: claudeEnv(), windowsHide: true, signal });
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => reject(new ModelError(`Couldn't start Claude Code: ${e.message}`, 'network')));
    child.on('close', code => {
      const text = out.trim();
      try {
        resolve(JSON.parse(text.slice(text.indexOf('{'))) as ClaudeOut);
      } catch {
        const why = (err || text || `exit ${code}`).slice(0, 300);
        reject(new ModelError(`Claude Code: ${why}`, LIMIT.test(why) ? 'rate' : 'server'));
      }
    });
    child.stdin.end(prompt);
  });
}

const claudeCode: Harness = async run => {
  const bridge = openBridge({ tools: run.tools, call: run.call });
  const cwd = await mkdtemp(join(tmpdir(), 'eaa-run-'));
  try {
    const mcpPath = join(cwd, 'mcp.json');
    const systemPath = join(cwd, 'system.md');
    await writeFile(mcpPath, JSON.stringify({ mcpServers: { agency: { type: 'http', url: bridge.url } } }));
    await writeFile(systemPath, run.system);
    const isolate = [
      '--output-format', 'json',
      '--model', run.model,
      ...(run.effort ? ['--effort', run.effort] : []),
      '--setting-sources', '',
      '--strict-mcp-config', '--mcp-config', mcpPath,
      '--tools', '',
      '--allowedTools', 'mcp__agency',
      '--disable-slash-commands',
      '--system-prompt-file', systemPath,
      '--max-turns', '150',
    ];
    const usage: Usage = { input: 0, output: 0 };
    let session: string | undefined;
    let prompt: string | null = run.opening;
    let text = '';
    while (prompt) {
      const out = await claudeOnce(['-p', ...(session ? ['--resume', session] : []), ...isolate], prompt, cwd, run.signal);
      if (out.is_error) {
        const why = out.result || out.subtype || 'Claude Code failed';
        throw new ModelError(`Claude Code: ${why}`, LIMIT.test(why) ? 'rate' : 'server');
      }
      session = out.session_id ?? session;
      usage.input += (out.usage?.input_tokens ?? 0) + (out.usage?.cache_read_input_tokens ?? 0) + (out.usage?.cache_creation_input_tokens ?? 0);
      usage.output += out.usage?.output_tokens ?? 0;
      text = out.result?.trim() || text;
      prompt = run.next();
    }
    return { text, usage };
  } finally {
    bridge.close();
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
};

// --- GitHub Copilot -------------------------------------------------------------------

const copilot: Harness = async run => {
  const token = (await getSecret<{ token: string }>('copilot'))?.token;
  if (!token) throw new ModelError('Copilot is not signed in', 'auth');
  const cwd = await mkdtemp(join(tmpdir(), 'eaa-run-'));
  const client = new CopilotClient({ gitHubToken: token, useLoggedInUser: false, logLevel: 'error' });
  try {
    await client.start();
    const session = await client.createSession({
      model: run.model,
      ...(run.effort ? { reasoningEffort: run.effort as 'low' } : {}),
      workingDirectory: cwd,
      // Only the agent's own tools - none of Copilot's shell or file tools.
      availableTools: new ToolSet().addCustom('*'),
      systemMessage: { mode: 'replace', content: run.system },
      onPermissionRequest: approveAll,
      tools: run.tools.map(t =>
        defineTool(t.name, {
          description: t.description,
          parameters: t.schema,
          skipPermission: true,
          handler: async (args: unknown) => {
            const out = await run.call({ id: `cp_${Date.now().toString(36)}`, name: t.name, args: (args ?? {}) as Record<string, unknown> });
            return out.error ? { textResultForLlm: out.content, resultType: 'failure' as const } : out.content;
          },
        }),
      ),
    });
    let prompt: string | null = run.opening;
    let text = '';
    while (prompt) {
      if (run.signal?.aborted) throw new Error('Stopped.');
      let reply;
      try {
        reply = await session.sendAndWait({ prompt }, 30 * 60_000);
      } catch (e) {
        const why = (e as Error).message;
        throw new ModelError(`Copilot: ${why}`, LIMIT.test(why) ? 'rate' : 'server');
      }
      text = String((reply as { data?: { content?: string } } | undefined)?.data?.content ?? '').trim() || text;
      prompt = run.next();
    }
    await session.disconnect().catch(() => {});
    return { text, usage: { input: 0, output: 0 } };
  } finally {
    await client.stop().catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
};
