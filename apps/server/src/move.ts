import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { relative } from 'node:path';

// Moving an organization's agency to another machine, the cloud say
// (docs/hosting-in-the-cloud.md): its whole folder as one file, encrypted with
// the vault key of the machine it's going to - the file is no use to anyone
// without that key, wherever it's left on the way.
//
// A bundle: "EAAMOVE1", a 12-byte nonce, the folder as a .tar.gz encrypted with
// AES-256-GCM, and its 16-byte tag at the end.

const MAGIC = Buffer.from('EAAMOVE1');

export const vaultKeyBytes = (b64: string) => {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error('A vault key is 32 bytes, base64-encoded.');
  return k;
};

// The vault's own format (vault.ts), for writing one for another machine.
export function sealFor(key: Buffer, value: unknown) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
export function openSealed<T>(key: Buffer, sealed: { iv: string; tag: string; data: string }): T {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
  d.setAuthTag(Buffer.from(sealed.tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(sealed.data, 'base64')), d.final()]).toString('utf8')) as T;
}

// Run in the folder, the archive named relative to it: GNU tar (Git's, on Windows)
// takes any "C:..." for a remote machine.
const tar = (mode: '-czf' | '-xzf', archive: string, dir: string) =>
  new Promise<void>((resolve, reject) => {
    const p = spawn('tar', [mode, relative(dir, archive).split('\\').join('/'), ...(mode === '-czf' ? ['.'] : [])], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`tar: ${err.trim() || `exit ${code}`}`))));
  });

// The folder `dir` (its contents) into an encrypted bundle at `out`.
export async function packBundle(dir: string, key: Buffer, out: string) {
  const plain = `${out}.tar.gz`;
  await tar('-czf', plain, dir);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const w = createWriteStream(out);
  w.write(Buffer.concat([MAGIC, iv]));
  await pipeline(createReadStream(plain), c, w, { end: false });
  await new Promise<void>((resolve, reject) => w.end(c.getAuthTag(), (e?: Error | null) => (e ? reject(e) : resolve())));
  await rm(plain, { force: true });
}

// A bundle back into the folder `dir` (made already, empty). Refused - nothing
// written - when it isn't one, or was made for another key or tampered with.
export async function unpackBundle(file: string, key: Buffer, dir: string) {
  const size = (await stat(file)).size;
  const head = Buffer.alloc(MAGIC.length + 12);
  const tag = Buffer.alloc(16);
  const fh = await open(file, 'r');
  try {
    await fh.read(head, 0, head.length, 0);
    await fh.read(tag, 0, 16, size - 16);
  } finally {
    await fh.close();
  }
  if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("That isn't an agency bundle.");
  const d = createDecipheriv('aes-256-gcm', key, head.subarray(MAGIC.length));
  d.setAuthTag(tag);
  const plain = `${file}.tar.gz`;
  try {
    await pipeline(createReadStream(file, { start: head.length, end: size - 17 }), d, createWriteStream(plain));
  } catch {
    await rm(plain, { force: true });
    throw new Error("The bundle doesn't open with this vault key (made for another, or damaged).");
  }
  await tar('-xzf', plain, dir);
  await rm(plain, { force: true });
}
