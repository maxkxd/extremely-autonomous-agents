import { fork } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transform } from 'esbuild';
import { safeFetch } from '../runner/net.js';

// Where code plugins run (docs/integrations.md): a separate Node process under
// Node's permission model, allowed only what the plugin declared - the folders
// it reads and writes, and whether it may start programs. The network it gets
// is kit.fetch, served here through the safe fetcher. A plugin that declares
// programs can do whatever those programs do: the approval card says so.

export type Permissions = { read: string[]; write: string[]; commands: boolean };

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_SOURCE = join(HERE, 'sandbox-child.mjs');
const BUILT = join(HERE, '..', '..', 'data', 'plugins', '.built');
// The sandbox's own script runs from the build folder, beside the plugins: the
// one folder the sandbox can read (with a package.json, so Node's search for
// one stops there instead of reading folders above).
const CHILD = join(BUILT, 'sandbox-child.mjs');
const TIMEOUT_MS = 120_000;
const MAX_BODY = 50 * 1024 * 1024;

// "~/Pictures/x" -> an absolute path. Refuses a whole drive or the whole home folder.
export function declaredPath(p: string): string {
  const raw = p.trim().replace(/^~(?=$|[\\/])/, homedir());
  if (!isAbsolute(raw)) throw new Error(`"${p}" must be an absolute path or start with ~/.`);
  const abs = resolve(raw);
  if (abs === parse(abs).root || abs.toLowerCase() === homedir().toLowerCase()) throw new Error(`"${p}" is too broad: name the folder the plugin needs.`);
  return abs;
}
export const resolvePermissions = (p?: { read?: string[]; write?: string[]; commands?: boolean }): Permissions => ({
  read: (p?.read ?? []).map(declaredPath),
  write: (p?.write ?? []).map(declaredPath),
  commands: !!p?.commands,
});

// TypeScript -> plain JavaScript, so the locked-down process needs no loader.
export async function buildPlugin(module: string, code: string, hash: string): Promise<string> {
  const out = await transform(code, { loader: 'ts', format: 'esm', target: 'node22' }).catch(e => {
    throw new Error(`The plugin's code doesn't compile: ${String((e as Error).message).split('\n').slice(0, 3).join(' ')}`);
  });
  await mkdir(BUILT, { recursive: true });
  // Node looks for the nearest package.json when it loads a module: one here
  // stops it searching up through folders the sandbox can't read.
  await writeFile(join(BUILT, 'package.json'), '{ "type": "module" }\n');
  await copyFile(CHILD_SOURCE, CHILD);
  const file = join(BUILT, `${module}-${hash.slice(0, 12)}.mjs`);
  await writeFile(file, out.code);
  return file;
}

// Only what programs need to run - never the server's own environment, which
// holds keys (ANTHROPIC_API_KEY...) and its TypeScript loader.
const PASS = ['PATH', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH', 'USERNAME', 'LANG', 'TZ'];
const sandboxEnv = () => Object.fromEntries(PASS.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]!]));

type Done = { result?: string; error?: string; tools?: { id: string; tier: string; description: string; input: unknown; run: string }[] };

export function runSandboxed(file: string, perms: Permissions, msg: { op: 'describe' } | { op: 'run'; tool: string; args: unknown; token?: string }): Promise<Done> {
  for (const d of perms.write) void mkdir(d, { recursive: true }).catch(() => {});
  // One flag per path (Node 24 doesn't take a comma-separated list).
  const execArgv = [
    '--permission',
    ...[BUILT, ...perms.read, ...perms.write].map(p => `--allow-fs-read=${p}`),
    ...perms.write.map(p => `--allow-fs-write=${p}`),
    ...(perms.commands ? ['--allow-child-process'] : []),
  ];
  return new Promise((resolveDone, reject) => {
    const child = fork(CHILD, [], { execArgv, env: sandboxEnv(), stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('The plugin took longer than 2 minutes and was stopped.'))), TIMEOUT_MS);
    child.stderr?.on('data', d => (stderr = (stderr + String(d)).slice(-2000)));
    child.on('message', async (m: { fetch?: { id: number; url: string; init?: Record<string, unknown> }; done?: Done }) => {
      if (m.done) return finish(() => resolveDone(m.done!));
      if (!m.fetch) return;
      const { id, url, init } = m.fetch;
      try {
        const { res } = await safeFetch(url, init as Parameters<typeof safeFetch>[1]);
        const body = Buffer.from(await res.arrayBuffer());
        if (body.length > MAX_BODY) throw new Error('The response is larger than 50 MB.');
        child.send({ fetched: { id, status: res.status, headers: Object.fromEntries(res.headers), body: body.toString('base64') } });
      } catch (e) {
        child.send({ fetched: { id, error: (e as Error).message } });
      }
    });
    child.on('exit', code =>
      finish(() => {
        const why = stderr.trim().split('\n').filter(Boolean).pop();
        reject(new Error(`The plugin stopped (exit ${code})${why ? `: ${why.slice(0, 300)}` : ''}.`));
      }),
    );
    child.send({ ...msg, file: pathToFileURL(file).href });
  });
}
