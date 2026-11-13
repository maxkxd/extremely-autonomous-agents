import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { diskFraction, FULL_AT, FULL_SWEEP_EVERY_MS, sweepDisk, sweepDue, sweepTemp, TEMP_AFTER_DAYS } from './disk-sweep.js';

// The volume filled faster than a daily sweep: it is also swept when it is 80% full, and
// Chrome's shader and component caches and a run's old temp folders go with the rest.

const DAY = 86_400_000;
const put = async (file: string, bytes = 10) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'x'.repeat(bytes));
};
const exists = (p: string) => stat(p).then(() => true, () => false);
const age = (path: string, days: number) => utimes(path, new Date(Date.now() - days * DAY), new Date(Date.now() - days * DAY));

test('the volume is read the way df shows it, and null when it cannot be read', async () => {
  assert.equal(await diskFraction('/data', async () => ({ blocks: 1000, bfree: 300, bavail: 300 })), 0.7);
  // Blocks only root may use count as used, like df.
  assert.equal(await diskFraction('/data', async () => ({ blocks: 1000, bfree: 300, bavail: 200 })), 700 / 900);
  assert.equal(await diskFraction('/data', async () => ({ blocks: 0, bfree: 0, bavail: 0 })), null);
  assert.equal(await diskFraction('/data', () => Promise.reject(new Error('no such volume'))), null);
});

test('an extra sweep is due at 80% full, and then at most once an hour', () => {
  const now = 10 * DAY;
  assert.equal(FULL_AT, 0.8);
  assert.equal(sweepDue(0.79, 0, now), false);
  assert.equal(sweepDue(0.8, 0, now), true);
  assert.equal(sweepDue(0.95, now - FULL_SWEEP_EVERY_MS + 1, now), false);
  assert.equal(sweepDue(0.95, now - FULL_SWEEP_EVERY_MS, now), true);
  assert.equal(sweepDue(null, 0, now), false);
});

test("Chrome's shader and component caches go; sign-ins and the rest stay", async () => {
  const root = await mkdtemp(join(tmpdir(), 'eaa-sweep-full-'));
  try {
    const dataDir = join(root, 'agency');
    const one = join(dataDir, 'browser-profiles', '1');
    for (const gone of [join(one, 'DawnCache', 'a'), join(one, 'GraphiteDawnCache', 'b'), join(one, 'GrShaderCache', 'c'), join(one, 'ShaderCache', 'd'), join(one, 'component_crx_cache', 'e'), join(one, 'Default', 'DawnCache', 'f')]) await put(gone, 100);
    const keep = [join(one, 'Local State'), join(one, 'Default', 'Cookies'), join(one, 'Default', 'Preferences'), join(one, 'Default', 'IndexedDB', 'i')];
    for (const k of keep) await put(k);
    const r = await sweepDisk({ dataDir, programsDir: join(dataDir, 'programs'), inUse: () => Promise.resolve(false) });
    assert.equal(r.browsers, 600);
    for (const k of keep) assert.equal(await exists(k), true, `${k} is kept`);
    for (const dir of ['DawnCache', 'GraphiteDawnCache', 'GrShaderCache', 'ShaderCache', 'component_crx_cache']) assert.equal(await exists(join(one, dir)), false, `${dir} is cleared`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('only old eaa-upload-* and eaa-run-* temp folders go', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'eaa-sweep-temp-'));
  try {
    const oldUpload = join(tmp, 'eaa-upload-abc');
    const oldRun = join(tmp, 'eaa-run-def');
    const newRun = join(tmp, 'eaa-run-new');
    const oldMove = join(tmp, 'eaa-move-xyz');
    const oldOther = join(tmp, 'something-else');
    await put(join(oldUpload, 'f'), 100);
    await put(join(oldRun, 'mcp.json'), 200);
    await put(join(newRun, 'mcp.json'), 300);
    await put(join(oldMove, 'f'), 400);
    await put(join(oldOther, 'f'), 500);
    for (const d of [oldUpload, oldRun, oldMove, oldOther]) await age(d, TEMP_AFTER_DAYS + 1);
    assert.equal(await sweepTemp({ tmpDir: tmp }), 300);
    assert.equal(await exists(oldUpload), false);
    assert.equal(await exists(oldRun), false);
    assert.equal(await exists(newRun), true, 'a recent run folder stays');
    assert.equal(await exists(oldMove), true, 'a move in progress is never touched');
    assert.equal(await exists(oldOther), true, "someone else's folder stays");
    assert.equal(await sweepTemp({ tmpDir: tmp }), 0, 'a second sweep frees nothing');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('no temp folder to read is nothing to clear', async () => {
  assert.equal(await sweepTemp({ tmpDir: join(tmpdir(), 'eaa-no-such-folder-here') }), 0);
});
