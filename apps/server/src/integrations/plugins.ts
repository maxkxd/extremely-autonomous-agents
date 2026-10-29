import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSetting } from '../runner/db.js';
import type { Tier } from '../catalog.js';
import type { CodeModule } from './modules/types.js';
import { buildPlugin, runSandboxed, type Permissions } from './sandbox.js';

// Code plugins (docs/integrations.md): TypeScript the Agency Engineer writes for
// what an HTTP or MCP definition can't do (an action on this computer, say).
// Off unless a person turns them on in Settings. A plugin's code never runs
// before a person has approved it - with the code shown - and it runs only
// while its file is byte-for-byte what they approved (checked by hash).

const PLUGINS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'plugins');
export const pluginsAllowed = () => getSetting<boolean>('code_plugins', false);

const file = (module: string) => join(PLUGINS, `${module}.ts`);
export const codeHash = (code: string) => createHash('sha256').update(code).digest('hex');

export async function readPlugin(module: string): Promise<string | null> {
  return readFile(file(module), 'utf8').catch(() => null);
}

// Network access other than kit.fetch (which refuses this computer and its
// network). Not a sandbox - the person's approval, code shown, is the real
// gate - but it stops the engineer writing it by accident.
const OWN_NETWORK = [
  [/(?<![\w.])fetch\s*\(/, 'fetch() - use kit.fetch(url, init), the third argument to run'],
  [/['"](node:)?(http|https|http2|net|tls|dgram|dns)['"]/, 'node network modules - use kit.fetch'],
  [/\b(undici|axios|XMLHttpRequest|WebSocket)\b/, 'other network clients - use kit.fetch'],
  [/\b(Invoke-WebRequest|Invoke-RestMethod|curl(\.exe)?|wget|Net\.WebClient|Start-BitsTransfer)\b/i, 'downloading from a shell - fetch it with kit.fetch first'],
] as const;
export function networkProblems(code: string): string[] {
  return OWN_NETWORK.filter(([re]) => re.test(code)).map(([, why]) => why);
}

export const removePlugin = (module: string) => rm(file(module), { force: true });

// The live code of a plugin being rewritten, kept until the new code goes live
// or is turned down (then it's put back).
const backup = (module: string) => join(PLUGINS, '.live', `${module}.ts`);
export async function restorePlugin(module: string) {
  const code = await readFile(backup(module), 'utf8').catch(() => null);
  if (code == null) return false;
  await writeFile(file(module), code);
  await rm(backup(module), { force: true });
  return true;
}
export const dropPluginBackup = (module: string) => rm(backup(module), { force: true });
export const readPluginBackup = (module: string) => readFile(backup(module), 'utf8').catch(() => null);

// Saves a plugin's code. It isn't loaded: that waits for a person's approval
// (a live one keeps running its approved code meanwhile).
export async function writePlugin(module: string, code: string) {
  const bad = networkProblems(code);
  if (bad.length) throw new Error(`Plugins reach the network only through kit.fetch. Found: ${bad.join('; ')}.`);
  await mkdir(join(PLUGINS, '.live'), { recursive: true });
  // Rewriting a live one: its live code is kept, once, in case the new code is turned down.
  const live = await readPlugin(module);
  if (installed.has(module) && live != null && (await readFile(backup(module)).catch(() => null)) == null) await writeFile(backup(module), live);
  await writeFile(file(module), code);
}

const installed = new Map<string, CodeModule>();
export const pluginModule = (module: string) => installed.get(module);

// Loads the plugin a person approved, into its sandbox (sandbox.ts) with the
// permissions they saw. Refuses if the code changed since. Nothing of it runs
// in this server: describing its tools and every call happen in the sandbox.
// source: the code to load instead of the plugin's file (its live code, while it's redrafted).
export async function installPlugin(module: string, approvedHash: string, permissions: Permissions, source?: string): Promise<CodeModule> {
  const code = source ?? (await readPlugin(module));
  if (code == null) throw new Error(`The plugin "${module}" has no code.`);
  if (codeHash(code) !== approvedHash) throw new Error(`The plugin "${module}" changed after it was approved, so it won't run. Propose it again.`);
  const bad = networkProblems(code);
  if (bad.length) throw new Error(`The plugin "${module}" reaches the network other than through kit.fetch (${bad.join('; ')}), so it won't run. Rewrite it with kit.fetch and propose it again.`);
  const built = await buildPlugin(module, code, approvedHash);
  const described = await runSandboxed(built, permissions, { op: 'describe' });
  if (described.error) throw new Error(`The plugin "${module}" didn't load: ${described.error}`);
  const tools = described.tools ?? [];
  if (!tools.length) throw new Error(`The plugin "${module}" must export default { tools: [...] }.`);
  for (const t of tools) {
    if (typeof t.id !== 'string' || !/^[a-z0-9_-]+\.[a-z0-9_]+$/.test(t.id)) throw new Error(`A tool in "${module}" has a bad id (want server.tool, lowercase).`);
    if (!['T0', 'T1', 'T2'].includes(t.tier)) throw new Error(`${t.id} needs a tier: T0, T1 or T2.`);
    if (t.run !== 'function' || typeof t.description !== 'string' || !t.input) throw new Error(`${t.id} needs a description, an input schema and a run function.`);
  }
  const mod: CodeModule = {
    tools: tools.map(t => ({
      id: t.id,
      tier: t.tier as Tier,
      description: t.description,
      input: t.input as Record<string, unknown>,
      run: async (args, token) => {
        const out = await runSandboxed(built, permissions, { op: 'run', tool: t.id, args, token });
        if (out.error) throw new Error(/ERR_ACCESS_DENIED|Access to this API has been restricted/i.test(out.error) ? `The plugin tried something it didn't declare (a file or program outside its permissions): ${out.error}` : out.error);
        return out.result ?? '';
      },
    })),
  };
  installed.set(module, mod);
  return mod;
}
