import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './paths.js';

// Credentials for model connections (API keys, OAuth tokens). Encrypted at rest
// with AES-256-GCM; the key is EAA_VAULT_KEY (base64, 32 bytes) or a key file
// made on first use beside the vault. Values never leave the server: the app
// only ever sees whether something is connected and a masked hint.

const DATA = DATA_DIR;
const VAULT = join(DATA, 'vault.json');
const KEY_FILE = join(DATA, 'vault.key');

type Sealed = { iv: string; tag: string; data: string };

let keyPromise: Promise<Buffer> | null = null;
function key(): Promise<Buffer> {
  keyPromise ??= (async () => {
    if (process.env.EAA_VAULT_KEY) {
      const k = Buffer.from(process.env.EAA_VAULT_KEY, 'base64');
      if (k.length !== 32) throw new Error('EAA_VAULT_KEY must be 32 bytes, base64-encoded.');
      return k;
    }
    try {
      return Buffer.from(await patiently(() => readFile(KEY_FILE, 'utf8')), 'base64');
    } catch (e) {
      // Only a vault that has never had a key gets a new one. One that couldn't be
      // read, or is gone while keys are sealed with it, stops here: a new key would
      // be written over it and every saved key would be unreadable for good.
      if (code(e) !== 'ENOENT') throw e;
      if (Object.keys(await readAll()).length) throw new Error(`The vault's key (${KEY_FILE}) is missing, so the saved keys can't be opened. Put the key file back, or set EAA_VAULT_KEY.`);
      const k = randomBytes(32);
      await mkdir(DATA, { recursive: true });
      await writeFile(KEY_FILE, k.toString('base64'), { mode: 0o600, flag: 'wx' }); // never over one
      return k;
    }
  })();
  const p = keyPromise;
  p.catch(() => keyPromise === p && (keyPromise = null)); // a failure is tried again next time
  return p;
}

// A save writes the whole vault to TMP, then puts it in VAULT's place. While TMP
// is there and newer than VAULT, it is the latest vault (a save whose last step
// was refused).
const TMP = `${VAULT}.tmp`;

type Vault = Record<string, Sealed>;
const code = (e: unknown) => (e as NodeJS.ErrnoException | undefined)?.code ?? '';
// On Windows a file another program has open (a virus scanner, the search
// indexer, a backup, a read of a key at the same moment) is briefly refused.
const BUSY = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function patiently<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= 20 || !BUSY.has(code(e))) throw e;
      await new Promise(r => setTimeout(r, 25 + i * 25));
    }
  }
}

// The vault in one file: null when there's no such file. Anything else (still
// locked, half written, not a vault) throws. It's never read as an empty vault:
// the next save would write that over every key.
async function readVault(file: string): Promise<Vault | null> {
  let text: string;
  try {
    text = await patiently(() => readFile(file, 'utf8'));
  } catch (e) {
    if (code(e) === 'ENOENT') return null;
    throw e;
  }
  const all = JSON.parse(text) as unknown;
  if (!all || typeof all !== 'object' || Array.isArray(all)) throw new SyntaxError(`${file} isn't a vault.`);
  return all as Vault;
}

const modified = (file: string) => stat(file).then(s => s.mtimeMs);

async function readAll(): Promise<Vault> {
  let saved: Vault | null = null;
  let unreadable: unknown;
  try {
    saved = await readVault(VAULT);
  } catch (e) {
    unreadable = e;
  }
  // A copy beside it: a save under way (half written: not it), or one that
  // couldn't take the vault's place.
  const pending = await readVault(TMP).catch(() => null);
  if (pending) {
    // Newer than the vault, or the vault is half written (a copy that stopped part way).
    if (!saved && !unreadable) return pending;
    if (unreadable instanceof SyntaxError) return pending;
    if (saved && (await modified(TMP)) >= (await modified(VAULT))) return pending;
  }
  if (unreadable) throw unreadable;
  return saved ?? {};
}

// Puts the new copy in the vault's place. When that's refused for long (something
// keeps the vault open and won't let it be replaced), the vault is written over
// in place instead. If even that fails, the copy stays beside it, and reads and
// the next save use it (readAll): nothing saved is lost.
async function swapIn() {
  try {
    return await patiently(() => rename(TMP, VAULT));
  } catch (e) {
    if (!BUSY.has(code(e))) throw e;
  }
  await patiently(() => copyFile(TMP, VAULT));
  await rm(TMP, { force: true }).catch(() => {});
}

// Writes go one at a time, so two saves can't lose each other; one that fails
// doesn't fail every save after it.
let writing: Promise<unknown> = Promise.resolve();
function writeAll(update: (all: Vault) => void): Promise<void> {
  const next = writing.then(async () => {
    const all = await readAll();
    update(all);
    await mkdir(DATA, { recursive: true });
    await patiently(() => writeFile(TMP, JSON.stringify(all), { mode: 0o600 }));
    await swapIn();
    await chmod(VAULT, 0o600).catch(() => {});
  });
  writing = next.catch(() => {});
  return next;
}

export async function getSecret<T>(id: string): Promise<T | null> {
  const sealed = (await readAll())[id];
  if (!sealed) return null;
  const d = createDecipheriv('aes-256-gcm', await key(), Buffer.from(sealed.iv, 'base64'));
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  const plain = Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]);
  return JSON.parse(plain.toString('utf8')) as T;
}

export async function setSecret(id: string, value: unknown) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', await key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  const sealed: Sealed = { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
  await writeAll(all => {
    all[id] = sealed;
  });
}

export const deleteSecret = (id: string) =>
  writeAll(all => {
    delete all[id];
  });

// "sk-ant-...abcd": enough to recognise a key, never enough to use it.
export const mask = (s: string) => (s.length <= 10 ? '••••' : `${s.slice(0, 6)}…${s.slice(-4)}`);
