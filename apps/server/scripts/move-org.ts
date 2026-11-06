import { execFileSync, spawn } from 'node:child_process';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Cdp } from '../src/runner/cdp.js';
import { openSealed, packBundle, sealFor, vaultKeyBytes } from '../src/move.js';

// Moving the organization this computer hosts to a machine of its own - the
// cloud (docs/hosting-in-the-cloud.md). Run on the computer that hosts it, from
// apps/server:
//
//   node --import tsx scripts/move-org.ts --to-key <the new machine's EAA_VAULT_KEY> --out org.eaa
//        [--data <the app's data folder>] [--stop] [--sidecar file.mjs ...]
//   node --import tsx scripts/move-org.ts --new-key      a new vault key for the new machine
//   ... --check      everything but the move: finds and opens the keys and vaults, changes nothing
//
// The bundle has the organization's folder as it is (agents, runs, messages,
// memories, connections), its vault opened here and sealed again with the new
// machine's key, the host's key pair and secret (so the new machine is the same
// host to our relay and directory, and members notice nothing), and every
// cookie in each of the agents' browser profiles - read through the browser's
// own DevTools connection, because a profile's cookie file is locked to this
// computer's account and is no use copied. The profiles themselves start empty
// there, with those cookies added.
//
// The organization's agency here has to be stopped first (its folder still):
// --stop stops it, as "this computer no longer hosts it" - the app reaches it
// through the relay from then on, wherever it runs.

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const opts = (name: string) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []));
const say = (m: string) => console.log(m);

if (flag('--new-key')) {
  say(randomBytes(32).toString('base64'));
  process.exit(0);
}

const APP_DIR = process.env.APPDATA ? join(process.env.APPDATA, 'Extremely Autonomous Agents') : '';
const DATA = resolve(opt('--data') ?? join(APP_DIR, 'data'));
const PERSONAL_PORT = Number(opt('--port') ?? 5175);
const HOSTED_PORT = Number(opt('--hosted-port') ?? 5185);
const toKeyB64 = opt('--to-key');
const out = resolve(opt('--out') ?? 'org.eaa');
if (!toKeyB64) throw new Error('--to-key: the new machine’s EAA_VAULT_KEY (make one with --new-key).');
const toKey = vaultKeyBytes(toKeyB64);

type Sealed = { iv: string; tag: string; data: string };
type Hosting = { orgId: string; orgName: string; issuer: string; self?: boolean };
const readJson = async <T>(f: string) => JSON.parse(await readFile(f, 'utf8')) as T;
const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) }).then(
    () => true,
    () => false,
  );

// --- This agency's own vault key: given, in its folder, or sealed by the desktop app ---
// The desktop app keeps it sealed by the system (Electron's safeStorage): on Windows a
// key in "Local State" protected by the person's account (DPAPI), then AES-256-GCM.
function personalKey(): Buffer {
  if (opt('--personal-key')) return vaultKeyBytes(opt('--personal-key')!);
  const plain = join(DATA, 'vault.key');
  if (existsSync(plain)) return vaultKeyBytes(readFileSync(plain, 'utf8').trim());
  const sealed = join(APP_DIR, 'vault-key.sealed');
  if (process.platform !== 'win32' || !existsSync(sealed)) throw new Error('Can’t find this agency’s vault key: give it with --personal-key.');
  const state = JSON.parse(readFileSync(join(APP_DIR, 'Local State'), 'utf8'));
  const wrapped = Buffer.from(state.os_crypt.encrypted_key, 'base64').subarray(5); // after "DPAPI"
  const ps = `Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${wrapped.toString('base64')}'), $null, 'CurrentUser'))`;
  const osKey = Buffer.from(execFileSync('powershell', ['-NoProfile', '-Command', ps]).toString().trim(), 'base64');
  const b = readFileSync(sealed); // "v10", 12-byte nonce, ciphertext, 16-byte tag
  const d = createDecipheriv('aes-256-gcm', osKey, b.subarray(3, 15));
  d.setAuthTag(b.subarray(b.length - 16));
  return vaultKeyBytes(Buffer.concat([d.update(b.subarray(15, b.length - 16)), d.final()]).toString('utf8').trim());
}

// --- The browser the agents' profiles were made with (browser.ts browserExe) ---
function browserExe() {
  const env = process.env;
  const candidates =
    process.platform === 'win32'
      ? [
          join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          join(env.ProgramFiles ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
        : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'];
  return opt('--browser') ?? candidates.find(p => p && existsSync(p)) ?? null;
}

// Every cookie in a profile, from its browser: opened on it without a window, asked, closed.
async function cookiesOf(dir: string): Promise<Record<string, unknown>[]> {
  const exe = browserExe();
  if (!exe) throw new Error('No Edge or Chrome found to read the agents’ sign-ins with.');
  const portFile = join(dir, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const proc = spawn(exe, [`--user-data-dir=${dir}`, '--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
  try {
    let line = '';
    for (let i = 0; i < 200 && !/^\d+\n\/devtools\//.test(line); i++) {
      line = await readFile(portFile, 'utf8').catch(() => '');
      if (proc.exitCode !== null) throw new Error(`The browser on ${dir} closed straight away: is it open in another window?`);
      await new Promise(r => setTimeout(r, 100));
    }
    const [port, path] = line.split('\n').map(l => l.trim());
    if (!path) throw new Error(`The browser on ${dir} didn't start.`);
    const cdp = await Cdp.connect(`ws://127.0.0.1:${port}${path}`);
    const { cookies } = await cdp.send<{ cookies: Record<string, unknown>[] }>('Storage.getCookies');
    await cdp.send('Browser.close').catch(() => {});
    // What Storage.setCookies takes back.
    return cookies.map(({ name, value, domain, path, expires, httpOnly, secure, sameSite, priority, sourceScheme, sourcePort, partitionKey, session }) => ({
      name,
      value,
      domain,
      path,
      httpOnly,
      secure,
      ...(sameSite ? { sameSite } : {}),
      ...(priority ? { priority } : {}),
      ...(sourceScheme ? { sourceScheme } : {}),
      ...(typeof sourcePort === 'number' ? { sourcePort } : {}),
      ...(partitionKey ? { partitionKey } : {}),
      ...(session ? {} : { expires }),
    }));
  } finally {
    await new Promise(r => setTimeout(r, 500));
    if (proc.exitCode === null) proc.kill();
  }
}

// --- The move ---

const personalVault = existsSync(join(DATA, 'vault.json')) ? await readJson<Record<string, Sealed>>(join(DATA, 'vault.json')) : {};
const pKey = personalKey();
// Which organization: the one this computer hosts (asked of the app's agency), or --org.
let h: Hosting | null = null;
if (await answers(PERSONAL_PORT)) h = ((await (await fetch(`http://127.0.0.1:${PERSONAL_PORT}/api/hosting`)).json()) as { hosting: Hosting | null }).hosting;
const orgId = opt('--org') ?? h?.orgId;
if (!orgId) throw new Error('Which organization? This computer isn’t hosting one now: give --org <its id>.');
if (h?.self) throw new Error('A self-hosted organization has no host registration to move: not supported yet.');
const orgDir = join(DATA, 'hosted', orgId.replace(/[^a-zA-Z0-9-]/g, ''));
if (!existsSync(join(orgDir, 'agency.db'))) throw new Error(`No organization folder at ${orgDir}.`);
const keyEntry = personalVault[`hosting:${orgId}:key`];
const secretEntry = personalVault[`hosting:${orgId}:secret`];
if (!keyEntry || !secretEntry) throw new Error('This computer has no host key or secret for that organization: it was never registered here.');

if (flag('--check')) {
  const orgKey = vaultKeyBytes((await readFile(join(orgDir, 'vault.key'), 'utf8')).trim());
  const orgVault = existsSync(join(orgDir, 'vault.json')) ? await readJson<Record<string, Sealed>>(join(orgDir, 'vault.json')) : {};
  for (const sealed of Object.values(orgVault)) openSealed(orgKey, sealed);
  openSealed(pKey, keyEntry);
  openSealed(pKey, secretEntry);
  const profiles = existsSync(join(orgDir, 'browser-profiles')) ? (await readdir(join(orgDir, 'browser-profiles'))).filter(n => /^\d+$/.test(n)) : [];
  say(`Ready to move ${h?.orgName ?? orgId}: ${Object.keys(orgVault).length} secrets open, the host's key and secret open, ${profiles.length} browser profiles, browser ${browserExe() ?? 'not found'}.`);
} else await move();

// Stopped here, then everything copied, sealed again and packed.
async function move() {
  if (await answers(HOSTED_PORT)) {
    if (!flag('--stop')) throw new Error('The organization’s agency is running here. Run again with --stop to stop it (its folder must be still to move it).');
    say('Stopping the organization’s agency here.');
    await fetch(`http://127.0.0.1:${PERSONAL_PORT}/api/hosting/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    for (let i = 0; i < 40 && (await answers(HOSTED_PORT)); i++) await new Promise(r => setTimeout(r, 500));
    if (await answers(HOSTED_PORT)) throw new Error('It didn’t stop.');
    await new Promise(r => setTimeout(r, 2000)); // its browsers closing after it
  }

  const stage = await mkdtemp(join(tmpdir(), 'eaa-move-'));
  try {
    const agency = join(stage, 'agency');
    say('Copying its folder.');
    await cp(orgDir, agency, {
      recursive: true,
      // Its vault is written again below; its profiles start empty there (cookies carried instead).
      filter: src => {
        const rel = src.slice(orgDir.length).replace(/\\/g, '/');
        return !/^\/(vault\.json|vault\.key|vault\.json\.tmp)$/.test(rel) && !/^\/browser-profiles?\/.+\/./.test(rel) && !/^\/browser-profile\/./.test(rel);
      },
    });

    const orgKey = vaultKeyBytes((await readFile(join(orgDir, 'vault.key'), 'utf8')).trim());
    const orgVault = existsSync(join(orgDir, 'vault.json')) ? await readJson<Record<string, Sealed>>(join(orgDir, 'vault.json')) : {};
    const next: Record<string, Sealed> = {};
    for (const [id, sealed] of Object.entries(orgVault)) next[id] = sealFor(toKey, openSealed(orgKey, sealed));
    next[`hosting:${orgId}:key`] = sealFor(toKey, openSealed(pKey, keyEntry));
    next[`hosting:${orgId}:secret`] = sealFor(toKey, openSealed(pKey, secretEntry));
    say(`Vault: ${Object.keys(orgVault).length} secrets, sealed again for the new machine, and the host's key and secret.`);

    const profilesDir = join(orgDir, 'browser-profiles');
    const profiles = existsSync(profilesDir) ? (await readdir(profilesDir, { withFileTypes: true })).filter(d => d.isDirectory() && /^\d+$/.test(d.name)).map(d => d.name) : [];
    for (const n of profiles) {
      // Tried again: the agents' browser on it may still be closing from --stop.
    let cookies: Record<string, unknown>[] = [];
    for (let i = 1; ; i++) {
      try {
        cookies = await cookiesOf(join(profilesDir, n));
        break;
      } catch (e) {
        if (i >= 4) throw e;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
      next[`browser:${n}:carried-cookies`] = sealFor(toKey, cookies);
      await mkdir(join(agency, 'browser-profiles', n), { recursive: true });
      say(`Browser profile ${n}: ${cookies.length} cookies (${new Set(cookies.map(c => String(c.domain).replace(/^\./, ''))).size} sites).`);
    }
    await writeFile(join(agency, 'vault.json'), JSON.stringify(next), { mode: 0o600 });

    const sidecars = opts('--sidecar');
    if (sidecars.length) {
      await mkdir(join(stage, 'sidecars'));
      for (const f of sidecars) await cp(resolve(f), join(stage, 'sidecars', f.replace(/^.*[\\/]/, '')));
    }

    say('Packing and encrypting.');
    await packBundle(stage, toKey, out);
    say(`Done: ${out}. It opens only with the new machine's vault key.`);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
