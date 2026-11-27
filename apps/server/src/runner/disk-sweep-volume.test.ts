import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { diskReport } from './disk-sweep.js';

// The report can also name the folders of the whole volume (the agency's folder, keep, incoming...),
// so what fills the volume shows even when it is not in the agency's own folder.

const MB = 1_000_000;
const put = async (file: string, bytes: number) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'x'.repeat(bytes));
};

test('with volume on, the first line names each big folder beside the agency folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eaa-volume-'));
  try {
    const dataDir = join(root, 'agency');
    await put(join(dataDir, 'agency.db'), 11 * MB);
    await put(join(root, 'incoming', 'old.eaa'), 14 * MB);
    await put(join(root, 'keep', 'VideoStudio', 'r', 'f'), 12 * MB);
    await put(join(root, 'tiny'), 10);

    const lines = await diskReport({ dataDir, programsDir: join(dataDir, 'programs'), keepDir: join(root, 'keep'), tmpDir: join(root, 'tmp'), volume: true });
    assert.match(lines[0]!, /^volume folder .* 37 MB: incoming 14 MB, keep 12 MB, agency 11 MB$/);
    assert.doesNotMatch(lines[0]!, /tiny/);
    assert.match(lines[1]!, /^data folder /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('without volume the report is as it was', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eaa-volume-'));
  try {
    const dataDir = join(root, 'agency');
    await put(join(dataDir, 'agency.db'), 11 * MB);
    const lines = await diskReport({ dataDir, programsDir: join(dataDir, 'programs'), keepDir: join(root, 'keep'), tmpDir: join(root, 'tmp') });
    assert.match(lines[0]!, /^data folder /);
    assert.ok(!lines.some(l => l.startsWith('volume folder')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
