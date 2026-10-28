import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getSetting } from '../runner/db.js';
import type { CodeModule } from './modules/types.js';

// Code plugins (docs/integrations.md): TypeScript the Fleet Engineer writes for
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

// Saves a plugin's code. It isn't loaded: that waits for a person's approval.
export async function writePlugin(module: string, code: string) {
  const bad = networkProblems(code);
  if (bad.length) throw new Error(`Plugins reach the network only through kit.fetch. Found: ${bad.join('; ')}.`);
  await mkdir(PLUGINS, { recursive: true });
  await writeFile(file(module), code);
  installed.delete(module);
}

const installed = new Map<string, CodeModule>();
export const pluginModule = (module: string) => installed.get(module);

// Loads the plugin a person approved. Refuses if the file changed since.
export async function installPlugin(module: string, approvedHash: string): Promise<CodeModule> {
  const code = await readPlugin(module);
  if (code == null) throw new Error(`The plugin "${module}" has no code.`);
  if (codeHash(code) !== approvedHash) throw new Error(`The plugin "${module}" changed after it was approved, so it won't run. Propose it again.`);
  const bad = networkProblems(code);
  if (bad.length) throw new Error(`The plugin "${module}" reaches the network other than through kit.fetch (${bad.join('; ')}), so it won't run. Rewrite it with kit.fetch and propose it again.`);
  const loaded = (await import(`${pathToFileURL(file(module)).href}?v=${approvedHash.slice(0, 12)}`)) as { default?: unknown };
  const mod = loaded.default as CodeModule | undefined;
  if (!mod || !Array.isArray(mod.tools) || !mod.tools.length) throw new Error(`The plugin "${module}" must export default { tools: [...] }.`);
  for (const t of mod.tools) {
    if (typeof t.id !== 'string' || !/^[a-z0-9_-]+\.[a-z0-9_]+$/.test(t.id)) throw new Error(`A tool in "${module}" has a bad id (want server.tool, lowercase).`);
    if (!['T0', 'T1', 'T2'].includes(t.tier)) throw new Error(`${t.id} needs a tier: T0, T1 or T2.`);
    if (typeof t.run !== 'function' || typeof t.description !== 'string' || !t.input) throw new Error(`${t.id} needs a description, an input schema and a run function.`);
  }
  installed.set(module, mod);
  return mod;
}
