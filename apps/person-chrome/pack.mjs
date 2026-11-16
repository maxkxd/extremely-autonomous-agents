// Makes the store upload: dist/extremely-<version>.zip, from this folder.
//   node apps/person-chrome/pack.mjs
// Leaves out what the stores shouldn't get: the listing notes, the privacy text (it's
// on the website), the tests, this script, and the development `key` in the manifest
// (the stores assign their own id). Node only, no packages.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const LEAVE_OUT = new Set(['STORE.md', 'PRIVACY.md', 'pack.mjs', 'test', 'dist', 'store', '.DS_Store', 'Thumbs.db']);

const manifest = JSON.parse(readFileSync(join(here, 'manifest.json'), 'utf8'));
delete manifest.key;

const files = [['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')]];
for (const name of readdirSync(here).sort()) {
  if (LEAVE_OUT.has(name) || name === 'manifest.json' || name.startsWith('.')) continue;
  const path = join(here, name);
  if (!statSync(path).isFile()) {
    console.error(`[pack] ${name} is a folder; add it to the package on purpose or to LEAVE_OUT`);
    process.exit(1);
  }
  files.push([name, readFileSync(path)]);
}

// Every file the manifest names must be in the package.
const named = [manifest.background?.service_worker, manifest.action?.default_popup, ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}), ...(manifest.content_scripts || []).flatMap(c => c.js || [])].filter(Boolean);
for (const n of named) {
  if (!files.some(([f]) => f === n)) {
    console.error(`[pack] the manifest names ${n}, which is missing`);
    process.exit(1);
  }
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// A plain zip: deflate, no extra fields, fixed 2026-01-01 timestamps so the same
// files make the same zip.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
const locals = [];
const centrals = [];
let offset = 0;
for (const [name, data] of files) {
  const nameBuf = Buffer.from(name, 'utf8');
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // utf-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, nameBuf, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // made by
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, nameBuf);
  offset += local.length + nameBuf.length + packed.length;
}
const centralSize = centrals.reduce((n, b) => n + b.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(here, 'dist'), { recursive: true });
const out = join(here, 'dist', `extremely-${manifest.version}.zip`);
writeFileSync(out, Buffer.concat([...locals, ...centrals, end]));
console.log(`[pack] ${out}: ${files.map(([f]) => f).join(', ')}`);
