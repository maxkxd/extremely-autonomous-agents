import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { diskReport } from './disk-sweep.js';

// The sweep logs how big each folder is, so the host's logs show what fills the volume.

const MB = 1_000_000;
const put = async (file: string, bytes: number) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'x'.repeat(bytes));
};

test('the report names each big folder with its size, and leaves out the small ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eaa-report-'));
  try {
    const dataDir = join(root, 'agency');
    const programsDir = join(dataDir, 'programs');
    const keepDir = join(root, 'keep');
    const tmp = join(root, 'tmp');
    await put(join(dataDir, 'agency.db'), 30 * MB);
    await put(join(dataDir, 'small.txt'), 10);
    await put(join(programsDir, '.cache', 'a'), 20 * MB);
    await put(join(dataDir, 'browser-profiles', '1', 'Cache', 'a'), 15 * MB);
    await put(join(dataDir, 'browser-profiles', '1', 'Default', 'IndexedDB', 'b'), 12 * MB);
    await put(join(dataDir, 'browser-profiles', '1', 'Local State'), 10);
    await put(join(keepDir, 'VideoStudio', 'render-1', 'f'), 11 * MB);
    await put(join(root, 'agency.replaced-1', 'x'), 13 * MB);
    await put(join(tmp, 'eaa-upload-a', 'f'), 5);
    await put(join(tmp, 'eaa-run-b', 'f'), 7);
    await put(join(tmp, 'eaa-run-c', 'f'), 9);
    await put(join(tmp, 'eaa-move-d', 'f'), 9 * MB);

    const lines = await diskReport({ dataDir, programsDir, keepDir, tmpDir: tmp });
    const text = lines.join('\n');
    assert.match(text, /data folder .*: agency\.db 30 MB/);
    assert.doesNotMatch(text, /small\.txt/);
    assert.match(text, /programs 20 MB: \.cache 20 MB/);
    assert.match(text, /browser profile 1 27 MB: Cache 15 MB, Default\/IndexedDB 12 MB/);
    assert.match(text, /VideoStudio \(kept on the volume\) 11 MB: render-1 11 MB/);
    assert.match(text, /LaunchStudio \(kept on the volume\) 0 MB: nothing over 10 MB/);
    assert.match(text, /old agency copies 13 MB: agency\.replaced-1 13 MB/);
    assert.match(text, /temporary folders: 1 eaa-upload-\* 0 MB, 2 eaa-run-\* 0 MB/);
    assert.doesNotMatch(text, /eaa-move/);
    assert.match(lines[lines.length - 1]!, /^volume: \d+% full, \d+% free$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing data folder is a report of nothing, not an error', async () => {
  const lines = await diskReport({ dataDir: join(tmpdir(), 'eaa-no-such-data-folder'), programsDir: join(tmpdir(), 'eaa-no-such-programs'), keepDir: join(tmpdir(), 'eaa-no-such-keep'), tmpDir: join(tmpdir(), 'eaa-no-such-tmp') });
  assert.match(lines[0]!, /^data folder .* 0 MB: nothing over 10 MB$/);
  assert.match(lines[lines.length - 1]!, /^volume: could not be read$/);
});
