import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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
      return Buffer.from(await readFile(KEY_FILE, 'utf8'), 'base64');
    } catch {
      const k = randomBytes(32);
      await mkdir(DATA, { recursive: true });
      await writeFile(KEY_FILE, k.toString('base64'), { mode: 0o600 });
      return k;
    }
  })();
  return keyPromise;
}

async function readAll(): Promise<Record<string, Sealed>> {
  try {
    return JSON.parse(await readFile(VAULT, 'utf8')) as Record<string, Sealed>;
  } catch {
    return {};
  }
}

// Writes go one at a time, so two saves can't lose each other.
let writing = Promise.resolve();
function writeAll(update: (all: Record<string, Sealed>) => void) {
  writing = writing.then(async () => {
    const all = await readAll();
    update(all);
    await mkdir(DATA, { recursive: true });
    const tmp = `${VAULT}.tmp`;
    await writeFile(tmp, JSON.stringify(all), { mode: 0o600 });
    await rename(tmp, VAULT);
    await chmod(VAULT, 0o600).catch(() => {});
  });
  return writing;
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
