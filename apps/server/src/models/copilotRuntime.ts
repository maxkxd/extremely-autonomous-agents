import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { RuntimeConnection } from '@github/copilot-sdk';
import { DATA_DIR } from '../paths.js';

// GitHub Copilot's runtime - the program the Copilot SDK talks to - is most of
// the desktop app's size (about 160 MB), and only people who connect Copilot
// need it. So the installer leaves its package out (apps/electron/scripts/
// stage.cjs), and it's fetched here the first time Copilot is connected or
// used: the exact version the SDK asks for, from npm, checked against npm's
// published sha512, unpacked into the agency's data folder. In development the
// SDK's own installed copy is used as always.

const require = createRequire(import.meta.url);
// A package's folder, found the way Node (and the SDK) would - its package.json
// isn't exported, so it can't simply be required.
const packageRoot = (name: string) => (require.resolve.paths(name) ?? []).map(base => join(base, ...name.split('/'))).find(dir => existsSync(join(dir, 'package.json'))) ?? null;
const sdkRoot = packageRoot('@github/copilot-sdk');
const sdk = (sdkRoot ? JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8')) : {}) as { optionalDependencies?: Record<string, string> };

const platform = () => (process.arch === 'x64' || process.arch === 'arm64' ? `${process.platform}-${process.arch}` : null);
const packageName = (p: string) => `@github/copilot-sdk-${p}`;
const wrapperIn = (root: string, p: string) => join(root, 'prebuilds', p, p.startsWith('win32') ? 'copilot-runtime.exe' : 'copilot-runtime');

// Installed beside the SDK (development, or a build that kept it): nothing to fetch.
const installedRoot = (p: string) => packageRoot(packageName(p));

const version = (p: string) => sdk.optionalDependencies?.[packageName(p)] ?? null;
const fetchedRoot = (p: string, v: string) => join(DATA_DIR, 'runtimes', 'copilot', `${p}-${v}`, 'package');

let fetching: Promise<string> | null = null;
let progress: number | null = null; // 0-100 while downloading
export const copilotRuntimeProgress = () => progress;

// The client's connection: the fetched runtime, or the SDK's default when it's installed.
export async function copilotConnection(): Promise<{ connection?: ReturnType<typeof RuntimeConnection.forStdio> }> {
  const p = platform();
  if (!p || installedRoot(p)) return {};
  return { connection: RuntimeConnection.forStdio({ path: await ensureCopilotRuntime() }) };
}

// Fetched once (shared by everyone asking at the same time); the path to the runtime.
export function ensureCopilotRuntime(): Promise<string> {
  const p = platform();
  if (!p) return Promise.reject(new Error(`Copilot isn't available on ${process.platform}-${process.arch}.`));
  const v = version(p);
  if (!v) return Promise.reject(new Error(`This build of the Copilot SDK has no runtime for ${p}.`));
  const root = fetchedRoot(p, v);
  if (existsSync(wrapperIn(root, p))) return Promise.resolve(wrapperIn(root, p));
  fetching ??= download(p, v, root).finally(() => {
    fetching = null;
    progress = null;
  });
  return fetching;
}

async function download(p: string, v: string, root: string): Promise<string> {
  const meta = (await (await fetch(`https://registry.npmjs.org/${packageName(p).replace('/', '%2f')}/${v}`)).json()) as { dist?: { tarball?: string; integrity?: string } };
  const { tarball, integrity } = meta.dist ?? {};
  if (!tarball || !integrity?.startsWith('sha512-')) throw new Error("npm didn't say where Copilot's runtime is.");
  progress = 0;
  const res = await fetch(tarball);
  if (!res.ok || !res.body) throw new Error(`Downloading Copilot's runtime failed (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const chunks: Buffer[] = [];
  let got = 0;
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
    got += chunk.length;
    if (total) progress = Math.min(99, Math.round((got / total) * 100));
  }
  const file = Buffer.concat(chunks);
  // What npm published, byte for byte.
  if (`sha512-${createHash('sha512').update(file).digest('base64')}` !== integrity) throw new Error("Copilot's runtime didn't match what npm published. Try again.");
  const parent = join(root, '..'); // runtimes/copilot/<platform>-<version>
  const base = join(parent, '..');
  await mkdir(base, { recursive: true });
  const staging = await mkdtemp(join(base, '.copilot-'));
  try {
    const tgz = join(staging, 'runtime.tgz');
    await writeFile(tgz, file);
    await untar(tgz, staging); // -> staging/package
    await rm(tgz, { force: true });
    if (!existsSync(wrapperIn(join(staging, 'package'), p))) throw new Error("Copilot's runtime was missing its program.");
    await rm(parent, { recursive: true, force: true });
    await rename(staging, parent);
  } catch (e) {
    await rm(staging, { recursive: true, force: true });
    throw e;
  }
  return wrapperIn(root, p);
}

// tar ships with Windows 10 and later, macOS and Linux.
function untar(file: string, into: string): Promise<void> {
  return new Promise((done, fail) => {
    const tar = spawn('tar', ['-xzf', file, '-C', into], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    tar.stderr.on('data', d => (err += d));
    tar.on('error', e => fail(new Error(`Unpacking Copilot's runtime failed: ${e.message}`)));
    tar.on('exit', code => (code === 0 ? done() : fail(new Error(`Unpacking Copilot's runtime failed: ${err.trim().slice(0, 200) || `tar exited ${code}`}`))));
  });
}

// For tests: whether a runtime is already where it'd be fetched to.
export const copilotRuntimeFetched = (p = platform()) => !!p && !!version(p) && existsSync(wrapperIn(fetchedRoot(p, version(p)!), p));
export const copilotSdkRuntimeVersion = (p = platform()) => (p ? version(p) : null);
