import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { SCRATCH_AFTER_DAYS, sweepScratch, volumeLine } from './disk-sweep.js';

// A studio's scratch (<keep>/<app>/tmp) piled up on the volume. Only what is directly inside a tmp
// folder goes, and only once nothing in it has changed for a day. Renders, clips and models stay.

const DAY = 86_400_000;
const put = async (file: string, bytes = 10) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'x'.repeat(bytes));
};
const exists = (p: string) => stat(p).then(() => true, () => false);
const age = (path: string, days: number) => utimes(path, new Date(Date.now() - days * DAY), new Date(Date.now() - days * DAY));

test('old scratch in a studio tmp goes; recent scratch, renders and the tmp folder itself stay', async () => {
  const keepDir = await mkdtemp(join(tmpdir(), 'eaa-sweep-scratch-'));
  try {
    const old = SCRATCH_AFTER_DAYS + 1;
    // Old scratch: a file, and a folder whose files are all old.
    const oldFile = join(keepDir, 'VideoStudio', 'tmp', 'a.wav');
    const oldDir = join(keepDir, 'VideoStudio', 'tmp', 'job-1');
    const oldDirFile = join(oldDir, 'f');
    const otherApp = join(keepDir, 'LaunchStudio', 'tmp', 'b');
    await put(oldFile, 100);
    await put(oldDirFile, 200);
    await put(otherApp, 300);
    for (const p of [oldFile, oldDirFile, oldDir, otherApp]) await age(p, old);
    // A folder whose own time is old but a file inside it was just written (a render in progress).
    const busy = join(keepDir, 'VideoStudio', 'tmp', 'job-2');
    const busyFile = join(busy, 'frame');
    await put(busyFile, 400);
    await age(busy, old);
    // A recent file.
    const recent = join(keepDir, 'VideoStudio', 'tmp', 'recent');
    await put(recent, 500);
    // Beside tmp: never touched, however old.
    const render = join(keepDir, 'VideoStudio', 'renders', 'film.mp4');
    const clip = join(keepDir, 'VideoStudio', 'veo-clips', 'c.mp4');
    await put(render, 600);
    await put(clip, 700);
    for (const p of [render, clip]) await age(p, old + 30);

    assert.equal(await sweepScratch({ keepDir }), 100 + 200 + 300);
    assert.equal(await exists(oldFile), false);
    assert.equal(await exists(oldDir), false);
    assert.equal(await exists(otherApp), false);
    assert.equal(await exists(busyFile), true, 'a folder with a recent change inside stays');
    assert.equal(await exists(recent), true);
    assert.equal(await exists(render), true, 'renders are never touched');
    assert.equal(await exists(clip), true, 'clips are never touched');
    assert.equal(await exists(join(keepDir, 'VideoStudio', 'tmp')), true, 'the tmp folder itself stays');
    assert.equal(await sweepScratch({ keepDir }), 0, 'a second sweep frees nothing');
  } finally {
    await rm(keepDir, { recursive: true, force: true });
  }
});

test('a tmp that is a link is left alone, and no keep folder is nothing to clear', { skip: process.platform === 'win32' }, async () => {
  const keepDir = await mkdtemp(join(tmpdir(), 'eaa-sweep-scratch-link-'));
  try {
    const target = join(keepDir, 'elsewhere', 'precious');
    await put(target, 5);
    await age(target, 30);
    await mkdir(join(keepDir, 'VideoStudio'), { recursive: true });
    await symlink(join(keepDir, 'elsewhere'), join(keepDir, 'VideoStudio', 'tmp'));
    assert.equal(await sweepScratch({ keepDir }), 0);
    assert.equal(await exists(target), true);
  } finally {
    await rm(keepDir, { recursive: true, force: true });
  }
  assert.equal(await sweepScratch({ keepDir: join(tmpdir(), 'eaa-no-such-keep-folder') }), 0);
});

test('the daily volume line says how full it is, or that it could not be read', () => {
  assert.equal(volumeLine(0.84), '[volume] 84% full, 16% free');
  assert.equal(volumeLine(null), '[volume] could not be read');
});
