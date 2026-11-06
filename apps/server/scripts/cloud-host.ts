import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { openSealed, unpackBundle, vaultKeyBytes } from '../src/move.js';

// An organization's agency in a container (docs/hosting-in-the-cloud.md): what
// the container runs. On its volume:
//
//   agency/      the agency's folder (EAA_DATA_DIR)
//   incoming/    a bundle moving an organization in (scripts/move-org.ts) -
//                or EAA_MOVE_IN_URL says where to fetch one
//   sidecars/    extra programs (*.mjs) run beside the agency, with EAA_URL set
//                to it - started again a minute after they stop
//
// A bundle is only opened where this organisation isn't hosted yet: an agency
// that is its host (its vault has the host secret) is never overwritten. With neither, it waits for a bundle
// (EAA_START_EMPTY=1: starts an empty agency instead).

const DATA = resolve(process.env.EAA_DATA_DIR ?? '/data/agency');
const ROOT = dirname(DATA);
const INCOMING = join(ROOT, 'incoming');
const SIDECARS = join(ROOT, 'sidecars');
const PORT = Number(process.env.PORT ?? 5185);
const SERVER = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const log = (m: string) => console.log(`[cloud] ${m}`);

// Already this organisation's host: its vault has the host secret (a bundle brings it).
// An agency without one - started empty - may still be replaced by a bundle.
async function isHost() {
  if (!existsSync(join(DATA, 'agency.db'))) return false;
  const org = process.env.EAA_HOSTED_ORG ?? '';
  try {
    const vault = JSON.parse(await readFile(join(DATA, 'vault.json'), 'utf8')) as Record<string, { iv: string; tag: string; data: string }>;
    return !!vault[`hosting:${org}:secret`] && !!openSealed(vaultKeyBytes(process.env.EAA_VAULT_KEY ?? ''), vault[`hosting:${org}:secret`]);
  } catch {
    return false;
  }
}

async function moveIn() {
  if (await isHost()) return;
  const existing = existsSync(join(DATA, 'agency.db'));
  await mkdir(INCOMING, { recursive: true });
  const url = process.env.EAA_MOVE_IN_URL;
  if (url && !(await readdir(INCOMING)).some(f => f.endsWith('.eaa'))) {
    log('Fetching the organization’s bundle.');
    const r = await fetch(url);
    if (!r.ok || !r.body) throw new Error(`Fetching the bundle: ${r.status}`);
    await pipeline(Readable.fromWeb(r.body as never), createWriteStream(join(INCOMING, 'fetched.eaa')));
  }
  let bundle = (await readdir(INCOMING)).filter(f => f.endsWith('.eaa')).sort()[0];
  // A container is for an organisation moving in: it waits for it (EAA_START_EMPTY: a new one, empty).
  if (!bundle && (existing || process.env.EAA_START_EMPTY)) return log(existing ? 'No bundle: carrying on with the agency here.' : 'No agency here yet: starting an empty one.');
  if (!bundle) log(`Waiting for the organisation's bundle in ${INCOMING}.`);
  while (!bundle) {
    await new Promise(r => setTimeout(r, 10_000));
    // Whole files only: an upload in progress isn't named .eaa yet, or is still growing.
    const ready = (await readdir(INCOMING)).filter(f => f.endsWith('.eaa')).sort()[0];
    if (!ready) continue;
    const size = (await stat(join(INCOMING, ready))).size;
    await new Promise(r => setTimeout(r, 3000));
    if ((await stat(join(INCOMING, ready))).size === size) bundle = ready;
  }
  if (!process.env.EAA_VAULT_KEY) throw new Error('EAA_VAULT_KEY is needed to open the bundle.');
  const into = join(INCOMING, 'opened');
  await rm(into, { recursive: true, force: true });
  await mkdir(into, { recursive: true });
  await unpackBundle(join(INCOMING, bundle), vaultKeyBytes(process.env.EAA_VAULT_KEY), into);
  await mkdir(ROOT, { recursive: true });
  await rm(DATA, { recursive: true, force: true }); // none, or one that isn't the host (isHost)
  await rename(join(into, 'agency'), DATA);
  if (existsSync(join(into, 'sidecars'))) {
    await mkdir(SIDECARS, { recursive: true });
    for (const f of await readdir(join(into, 'sidecars'))) await rename(join(into, 'sidecars', f), join(SIDECARS, f));
  }
  await rm(into, { recursive: true, force: true });
  await rm(join(INCOMING, bundle), { force: true });
  log('Moved the organization in.');
}

const children = new Set<ChildProcess>();
function keep(name: string, args: string[], env: NodeJS.ProcessEnv, again: boolean) {
  const p = spawn(process.execPath, args, { env, stdio: 'inherit' });
  children.add(p);
  p.on('exit', code => {
    children.delete(p);
    if (!again) {
      log(`${name} stopped (${code}).`);
      for (const c of children) c.kill();
      process.exit(code ?? 1);
    }
    log(`${name} stopped (${code}); starting it again in a minute.`);
    setTimeout(() => keep(name, args, env, again), 60_000);
  });
}

await moveIn();
// The agency: when it stops, so does the container (and the host starts it again).
keep('The agency', ['--import', 'tsx', SERVER], { ...process.env, EAA_DATA_DIR: DATA, PORT: String(PORT), EAA_CLOUD_HOST: '1' }, false);
if (existsSync(SIDECARS))
  for (const f of (await readdir(SIDECARS)).filter(f => f.endsWith('.mjs')).sort()) {
    log(`Starting ${f}.`);
    // Not the agency's own keys: a sidecar reads the agency through its address.
    const env: NodeJS.ProcessEnv = { ...process.env, EAA_URL: `http://127.0.0.1:${PORT}` };
    delete env.EAA_VAULT_KEY;
    keep(f, [join(SIDECARS, f)], env, true);
  }
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => (children.forEach(c => c.kill(sig)), setTimeout(() => process.exit(0), 10_000).unref()));
