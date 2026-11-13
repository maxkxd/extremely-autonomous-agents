import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { profileInUse, REPLACED_AFTER_DAYS, sweepDisk } from './disk-sweep.js';

// The volume filled with caches the agency makes again. These are the only things the
// sweep may delete: everything else it must leave exactly as it was.

const DAY = 86_400_000;
const put = async (file: string, bytes = 10) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'x'.repeat(bytes));
};
const exists = (p: string) => stat(p).then(() => true, () => false);

async function agency() {
  const root = await mkdtemp(join(tmpdir(), 'eaa-sweep-'));
  const dataDir = join(root, 'agency');
  const programsDir = join(dataDir, 'programs');
  // What stays.
  const keep = [
    join(dataDir, 'agency.db'),
    join(dataDir, 'vault.json'),
    join(dataDir, 'plugins', 'out', 'report.txt'),
    join(programsDir, 'programs.json'),
    join(programsDir, 'ffmpeg', '7.1', 'bin', 'ffmpeg'),
    join(programsDir, '.npm-cli', '11.0.0', 'package', 'npm-cli.js'),
    join(programsDir, '.staging', 'x', 'download'),
    join(dataDir, 'browser-profiles', '1', 'Local State'),
    join(dataDir, 'browser-profiles', '1', 'Default', 'Cookies'),
    join(dataDir, 'browser-profiles', '1', 'Default', 'Preferences'),
    join(dataDir, 'browser-profiles', '1', 'Default', 'Service Worker', 'Database', 'd'),
    join(dataDir, 'browser-profiles', 'person-1', 'Default', 'Cache', 'c'),
    join(root, 'other', 'x'),
    join(root, 'agency-notes', 'x'),
  ];
  for (const f of keep) await put(f);
  // What goes.
  await put(join(programsDir, '.npm-cache', 'a'), 100);
  await put(join(programsDir, '.cache', 'ms-playwright', 'b'), 200);
  const one = join(dataDir, 'browser-profiles', '1');
  await put(join(one, 'Default', 'Cache', 'Cache_Data', 'c'), 300);
  await put(join(one, 'Default', 'Code Cache', 'js', 'c'), 400);
  await put(join(one, 'Default', 'GPUCache', 'g'), 500);
  await put(join(one, 'Default', 'Service Worker', 'CacheStorage', 's'), 600);
  await put(join(one, 'GPUCache', 'r'), 50);
  await put(join(root, 'agency.replaced-1', 'old.db'), 10);
  await put(join(root, 'agency.replaced-2', 'old.db'), 20);
  // A profile whose browser is open.
  await put(join(dataDir, 'browser-profiles', '2', 'Default', 'Cache', 'c'), 700);
  return { root, dataDir, programsDir, keep, one };
}

test('only the caches and old agency copies go, and the bytes freed are counted', async () => {
  const a = await agency();
  try {
    const open = (dir: string) => Promise.resolve(dir === join(a.dataDir, 'browser-profiles', '2'));
    const r = await sweepDisk({ dataDir: a.dataDir, programsDir: a.programsDir, now: Date.now() + (REPLACED_AFTER_DAYS + 7) * DAY, inUse: open });
    assert.deepEqual(r, { freed: 300 + 1850 + 30, programs: 300, browsers: 1850, replaced: 30, keptOpen: [2] });
    for (const gone of [join(a.programsDir, '.npm-cache'), join(a.programsDir, '.cache'), join(a.one, 'Default', 'Cache'), join(a.one, 'Default', 'Code Cache'), join(a.one, 'Default', 'GPUCache'), join(a.one, 'Default', 'Service Worker', 'CacheStorage'), join(a.one, 'GPUCache'), join(a.root, 'agency.replaced-1'), join(a.root, 'agency.replaced-2')])
      assert.equal(await exists(gone), false, `${gone} is cleared`);
    for (const kept of a.keep) assert.equal(await exists(kept), true, `${kept} is kept`);
    assert.equal(await exists(join(a.dataDir, 'browser-profiles', '2', 'Default', 'Cache', 'c')), true, 'an open browser keeps its caches');
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});

test('an agency copy set aside recently stays; the caches still go', async () => {
  const a = await agency();
  try {
    const r = await sweepDisk({ dataDir: a.dataDir, programsDir: a.programsDir, now: Date.now(), inUse: () => Promise.resolve(false) });
    assert.equal(r.replaced, 0);
    assert.equal(await exists(join(a.root, 'agency.replaced-1', 'old.db')), true);
    assert.equal(r.programs, 300);
    assert.deepEqual(r.keptOpen, []);
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});

test('a second sweep, with nothing left to clear, frees nothing and breaks nothing', async () => {
  const a = await agency();
  try {
    const o = { dataDir: a.dataDir, programsDir: a.programsDir, now: Date.now() + 30 * DAY, inUse: () => Promise.resolve(false) };
    await sweepDisk(o);
    assert.equal((await sweepDisk(o)).freed, 0);
    for (const kept of a.keep) assert.equal(await exists(kept), true, `${kept} is kept`);
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});

test('a link in a cache folder is removed as a link, never followed', { skip: process.platform === 'win32' }, async () => {
  const a = await agency();
  try {
    const target = join(a.root, 'precious');
    await put(join(target, 'data'), 5);
    await symlink(target, join(a.programsDir, '.cache', 'link'));
    await sweepDisk({ dataDir: a.dataDir, programsDir: a.programsDir, now: Date.now(), inUse: () => Promise.resolve(true) });
    assert.equal(await exists(join(a.programsDir, '.cache')), false);
    assert.equal(await exists(join(target, 'data')), true);
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});

test('a profile is in use only when a live process on this machine holds its lock', { skip: process.platform === 'win32' }, async () => {
  const a = await agency();
  try {
    const dir = join(a.dataDir, 'browser-profiles', '3');
    await mkdir(dir, { recursive: true });
    assert.equal(await profileInUse(dir), false, 'no lock');
    await symlink(`${hostname()}-${process.pid}`, join(dir, 'SingletonLock'));
    assert.equal(await readlink(join(dir, 'SingletonLock')), `${hostname()}-${process.pid}`);
    assert.equal(await profileInUse(dir), true, 'this process is alive');
    await rm(join(dir, 'SingletonLock'));
    await symlink(`${hostname()}-2147483646`, join(dir, 'SingletonLock'));
    assert.equal(await profileInUse(dir), false, 'no such process');
    await rm(join(dir, 'SingletonLock'));
    await symlink(`another-machine-${process.pid}`, join(dir, 'SingletonLock'));
    assert.equal(await profileInUse(dir), false, 'another machine');
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});
