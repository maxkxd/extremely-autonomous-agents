import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { approveAll, CopilotClient, defineTool, ToolSet } from '@github/copilot-sdk';
import { copilotConnection } from '../models/copilotRuntime.js';
import { getSecret } from '../vault.js';
import { claudeCommand, claudeEnv, noteClaudeCodeTooOld } from '../models/connections.js';
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
// usd: what the plan says the run would have cost on its API (Claude Code
// reports it, cache reads at their own price); null when it can't be told;
// left out, the runner prices the tokens itself.
export type HarnessResult = { text: string; usage: Usage; usd?: number | null };
export type Harness = (r: HarnessRun) => Promise<HarnessResult>;

export function harnessFor(connection: string): Harness | null {
  if (connection === 'claude-code') return claudeCode;
  if (connection === 'copilot') return copilot;
  return null;
}

// --- Claude Code -------------------------------------------------------------------

const LIMIT = /usage limit|rate limit|limit reached|overloaded|429|too many requests/i;

// Its environment without any Anthropic key, so it can only use the person's
// own Claude sign-in or plan token (never the server's key, never billed by
// mistake): claudeEnv in models/connections.ts.

type ClaudeOut = { result?: string; is_error?: boolean; subtype?: string; session_id?: string; total_cost_usd?: number; usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number } };

// One `claude -p` call; the prompt goes in on stdin. Claude Code is found where
// the connection check finds it (claudeCommand), not only on the PATH the app
// started with. Through the shell (an npm .cmd) every argument is quoted - they
// are the runner's own flags, ids and paths, never the agent's text.
const shellQuote = (a: string) => `"${a.replace(/"/g, '\\"')}"`;
export async function claudeOnce(args: string[], prompt: string, cwd: string, signal?: AbortSignal): Promise<ClaudeOut> {
  const cmd = await claudeCommand();
  if (!cmd) throw new ModelError("Claude Code isn't installed on this computer. Install it in Settings > Connectors (Claude).", 'auth');
  return new Promise((resolve, reject) => {
    const child = cmd.shell
      ? spawn([shellQuote(cmd.bin), ...args.map(shellQuote)].join(' '), { cwd, env: claudeEnv(), windowsHide: true, signal, shell: true })
      : spawn(cmd.bin, args, { cwd, env: claudeEnv(), windowsHide: true, signal });
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('error', e => {
      void claudeCommand(true); // look again next time: it may have moved
      reject(new ModelError(`Couldn't start Claude Code: ${e.message}`, 'network'));
    });
    child.on('close', (code, sig) => {
      const text = out.trim();
      try {
        resolve(JSON.parse(text.slice(text.indexOf('{'))) as ClaudeOut);
      } catch {
        if (!signal?.aborted && crashed(code, sig, err)) {
          noteCrash(err, sig ?? `exit ${code}`);
          return reject(new ClaudeCrash(`Claude Code crashed (${sig ?? `exit ${code}`})`));
        }
        const why = (err || text || `exit ${code}`).slice(0, 300);
        reject(tooOld(why) ?? new ModelError(`Claude Code: ${why}`, LIMIT.test(why) ? 'rate' : 'server'));
      }
    });
    child.stdin.end(prompt);
  });
}

// Claude Code itself crashing mid-turn (killed by a signal, or its runtime
// aborting: "Bun has crashed", exit 134) isn't the model failing: what the agent
// did so far is in its session, so the turn carries on from there.
export class ClaudeCrash extends ModelError {
  constructor(message: string) {
    super(message, 'server');
  }
}
export const crashed = (code: number | null, sig: NodeJS.Signals | null, err: string) =>
  sig != null || code === null || code === 134 || code === 139 || /Bun has crashed|panic\(/.test(err);
const CRASH_RETRIES = 3;
// The last day's crashes, for the Doctor and the Agency Engineer (host.ts): why
// they happened is in what Claude Code said as it fell over.
export const claudeCrashes: { at: number; why: string }[] = [];
export const crashCause = (err: string, how: string) =>
  /EAGAIN|Resource temporarily unavailable|Failed to start .*thread|pthread_create/i.test(err)
    ? "couldn't start a thread or process: the machine's limit is reached"
    : /out of memory|heap limit|ENOMEM/i.test(err)
      ? 'out of memory'
      : `crashed (${how})`;
function noteCrash(err: string, how: string) {
  const now = Date.now();
  claudeCrashes.push({ at: now, why: crashCause(err, how) });
  while (claudeCrashes.length && (claudeCrashes[0].at < now - 24 * 3_600_000 || claudeCrashes.length > 500)) claudeCrashes.shift();
}
// Whether Claude Code wrote anything of this session before it stopped.
async function sessionSaved(id: string) {
  const projects = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
  for (const dir of await readdir(projects).catch(() => [] as string[]))
    if (await access(join(projects, dir, `${id}.jsonl`)).then(() => true, () => false)) return true;
  return false;
}
const CARRY_ON = 'Claude Code stopped unexpectedly in the middle of your last turn. Carry on from where you were.';

// Claude Code too old for the model: said plainly, and the Connectors row offers the update.
const tooOld = (why: string) => {
  const v = noteClaudeCodeTooOld(why);
  return v ? new ModelError(`Claude Code needs updating to ${v} or newer for this model. Update it in Settings > Connectors (Claude).`, 'server') : null;
};

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
    let usd: number | null = 0;
    // Named up front, so a crash in the very first turn can still be resumed.
    let session: string = randomUUID();
    let started = false;
    let prompt: string | null = run.opening;
    let text = '';
    let crashes = 0;
    while (prompt) {
      let out: ClaudeOut;
      try {
        out = await claudeOnce(['-p', ...(started ? ['--resume', session] : ['--session-id', session]), ...isolate], prompt, cwd, run.signal);
      } catch (e) {
        if (!(e instanceof ClaudeCrash) || ++crashes > CRASH_RETRIES) throw e;
        console.error(`[harness] ${e.message}; carrying on (${crashes}/${CRASH_RETRIES}).`);
        // A crash before anything was saved leaves no session to resume: that turn starts again.
        if (started || (await sessionSaved(session))) [started, prompt] = [true, CARRY_ON];
        continue;
      }
      started = true;
      if (out.is_error) {
        const why = out.result || out.subtype || 'Claude Code failed';
        throw tooOld(why) ?? new ModelError(`Claude Code: ${why}`, LIMIT.test(why) ? 'rate' : 'server');
      }
      session = out.session_id ?? session;
      usage.input += (out.usage?.input_tokens ?? 0) + (out.usage?.cache_read_input_tokens ?? 0) + (out.usage?.cache_creation_input_tokens ?? 0);
      usage.output += out.usage?.output_tokens ?? 0;
      usd = usd == null || !Number.isFinite(out.total_cost_usd) ? null : usd + out.total_cost_usd!;
      text = out.result?.trim() || text;
      prompt = run.next();
    }
    return { text, usage, usd };
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
  const client = new CopilotClient({ ...(await copilotConnection()), gitHubToken: token, useLoggedInUser: false, logLevel: 'error' });
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
    // Copilot doesn't say what a reply used: its cost is unknown, never $0.
    return { text, usage: { input: 0, output: 0 }, usd: null };
  } finally {
    await client.stop().catch(() => {});
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
};
