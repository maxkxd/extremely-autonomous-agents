import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { diskReport, RETAIN_FULL, RETAIN_TIGHT, sweepDisk, sweepRetention } from './disk-sweep.js';

// The volume is 5 GB and filled up with renders. When it is 80% full a studio's old output goes (oldest
// first, newest few kept, only until there is room); at 90% a tighter rule. Caches Chrome only reads at
// start go from an open profile too, and more of a profile's downloaded data goes from a closed one.

const DAY = 86_400_000;
const put = async (file: string, bytes = 10) => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, 'x'.repeat(bytes));
};
const exists = (p: string) => stat(p).then(() => true, () => false);
const age = (path: string, days: number) => utimes(path, new Date(Date.now() - days * DAY), new Date(Date.now() - days * DAY));

test('old renders go oldest first, the newest few and anything recent stay, and nothing else is touched', async () => {
  const keepDir = await mkdtemp(join(tmpdir(), 'eaa-retain-'));
  try {
    const renders = join(keepDir, 'VideoStudio', 'renders');
    const files = ['a', 'b', 'c', 'd', 'e'].map(n => join(renders, `${n}.mp4`));
    // a is the oldest (10 days), e the newest (today).
    for (const [i, f] of files.entries()) {
      await put(f, 100 * (i + 1));
      await age(f, 10 - i * 2.5);
    }
    // Beside renders: however old, never touched.
    const model = join(keepDir, 'VideoStudio', 'kokoro', 'model.bin');
    const bin = join(keepDir, 'VideoStudio', 'bin', 'tool');
    await put(model, 500);
    await put(bin, 600);
    await age(model, 100);
    await age(bin, 100);

    const rules = [{ folder: 'renders', days: 7, keepNewest: 2 }];
    // Ages: a 10, b 7.5, c 5, d 2.5, e 0. Newest two (e, d) stay; of the rest only a and b are 7 days old.
    assert.equal(await sweepRetention({ keepDir, rules }), 100 + 200);
    assert.deepEqual(await Promise.all(files.map(exists)), [false, false, true, true, true]);
    assert.equal(await exists(model), true, 'a model is never touched');
    assert.equal(await exists(bin), true, "a studio's own programs are never touched");
    assert.equal(await exists(renders), true, 'the renders folder itself stays');
    assert.equal(await sweepRetention({ keepDir, rules }), 0, 'a second prune frees nothing');
  } finally {
    await rm(keepDir, { recursive: true, force: true });
  }
});

test('a render folder with a recent file inside it stays; the newest-N rule counts each item', async () => {
  const keepDir = await mkdtemp(join(tmpdir(), 'eaa-retain-busy-'));
  try {
    const busy = join(keepDir, 'LaunchStudio', 'projects', 'p1');
    const busyFile = join(busy, 'frame.png');
    await put(busyFile, 400);
    await age(busy, 30); // the folder's own time is old, but a file in it was just written
    const idle = join(keepDir, 'LaunchStudio', 'projects', 'p2');
    await put(join(idle, 'f'), 300);
    await age(join(idle, 'f'), 30);
    await age(idle, 30);
    assert.equal(await sweepRetention({ keepDir, rules: [{ folder: 'projects', days: 7, keepNewest: 0 }] }), 300);
    assert.equal(await exists(busyFile), true, 'a project being written stays');
    assert.equal(await exists(idle), false);
  } finally {
    await rm(keepDir, { recursive: true, force: true });
  }
});

test('it stops as soon as there is room again', async () => {
  const keepDir = await mkdtemp(join(tmpdir(), 'eaa-retain-enough-'));
  try {
    const clips = ['c1', 'c2', 'c3'].map(n => join(keepDir, 'VideoStudio', 'veo-clips', `${n}.mp4`));
    for (const [i, f] of clips.entries()) {
      await put(f, 100 * (i + 1));
      await age(f, 20 - i); // c1 oldest
    }
    let asked = 0;
    // Room again after the first removal.
    const enough = () => Promise.resolve(++asked > 1);
    assert.equal(await sweepRetention({ keepDir, rules: [{ folder: 'veo-clips', days: 3, keepNewest: 0 }], enough }), 100);
    assert.deepEqual(await Promise.all(clips.map(exists)), [false, true, true]);
  } finally {
    await rm(keepDir, { recursive: true, force: true });
  }
});

test('a renders folder that is a link, and a missing keep folder, are left alone', { skip: process.platform === 'win32' }, async () => {
  const keepDir = await mkdtemp(join(tmpdir(), 'eaa-retain-link-'));
  try {
    const target = join(keepDir, 'elsewhere', 'precious');
    await put(target, 5);
    await age(target, 90);
    await mkdir(join(keepDir, 'VideoStudio'), { recursive: true });
    await symlink(join(keepDir, 'elsewhere'), join(keepDir, 'VideoStudio', 'renders'));
    assert.equal(await sweepRetention({ keepDir, rules: RETAIN_TIGHT }), 0);
    assert.equal(await exists(target), true);
  } finally {
    await rm(keepDir, { recursive: true, force: true });
  }
  assert.equal(await sweepRetention({ keepDir: join(tmpdir(), 'eaa-no-such-keep'), rules: RETAIN_FULL }), 0);
});

test('the tight rule is stricter than the full one, and never prunes models, bin or tmp', () => {
  for (const t of RETAIN_TIGHT) {
    const f = RETAIN_FULL.find(x => x.folder === t.folder)!;
    assert.ok(f, `${t.folder} is in both`);
    assert.ok(t.days <= f.days && t.keepNewest <= f.keepNewest, `${t.folder}: tight is no looser than full`);
  }
  const named = [...RETAIN_FULL, ...RETAIN_TIGHT].map(r => r.folder);
  for (const never of ['kokoro', 'bin', 'tmp', 'clips', 'programs']) assert.ok(!named.includes(never), `${never} is not pruned by age`);
});

async function profiles() {
  const root = await mkdtemp(join(tmpdir(), 'eaa-sweep-caches-'));
  const dataDir = join(root, 'agency');
  const programsDir = join(dataDir, 'programs');
  return { root, dataDir, programsDir, profile: (n: string) => join(dataDir, 'browser-profiles', n) };
}

test("a closed profile's downloaded data goes too: Wasm TTS, Safe Browsing, optimization models, service worker scripts; sign-ins stay", async () => {
  const a = await profiles();
  try {
    const one = a.profile('person-1');
    await put(join(one, 'WasmTtsEngine', 'a'), 100);
    await put(join(one, 'Safe Browsing', 'b'), 200);
    await put(join(one, 'optimization_guide_model_store', 'c'), 300);
    await put(join(one, 'Default', 'Service Worker', 'ScriptCache', 'd'), 400);
    const keep = [join(one, 'Default', 'Service Worker', 'Database', 'x'), join(one, 'Default', 'Cookies'), join(one, 'Local State'), join(one, 'Default', 'Preferences')];
    for (const k of keep) await put(k);
    const r = await sweepDisk({ dataDir: a.dataDir, programsDir: a.programsDir, inUse: () => Promise.resolve(false) });
    assert.equal(r.browsers, 1000);
    for (const gone of ['WasmTtsEngine', 'Safe Browsing', 'optimization_guide_model_store']) assert.equal(await exists(join(one, gone)), false, `${gone} is cleared`);
    assert.equal(await exists(join(one, 'Default', 'Service Worker', 'ScriptCache')), false);
    for (const k of keep) assert.equal(await exists(k), true, `${k} is kept`);
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});

test('an open profile keeps its caches, unless the volume is nearly full: then only what Chrome downloaded and reads at start goes', async () => {
  const a = await profiles();
  try {
    const two = a.profile('2');
    const open = (dir: string) => Promise.resolve(dir === two);
    const stays = [join(two, 'Default', 'Cache', 'c'), join(two, 'Default', 'Code Cache', 'c'), join(two, 'Default', 'Cookies'), join(two, 'Safe Browsing', 's')];
    for (const s of stays) await put(s, 50);
    await put(join(two, 'component_crx_cache', 'x'), 60);
    await put(join(two, 'WasmTtsEngine', 'y'), 70);
    await put(join(two, 'optimization_guide_model_store', 'z'), 80);

    const normal = await sweepDisk({ dataDir: a.dataDir, programsDir: a.programsDir, inUse: open });
    assert.equal(normal.browsers, 0);
    assert.deepEqual(normal.keptOpen, [2]);
    assert.equal(await exists(join(two, 'component_crx_cache', 'x')), true, 'an open profile is left alone at a normal sweep');

    const nearlyFull = await sweepDisk({ dataDir: a.dataDir, programsDir: a.programsDir, inUse: open, openToo: true });
    assert.equal(nearlyFull.browsers, 60 + 70 + 80);
    assert.deepEqual(nearlyFull.keptOpen, [2]);
    for (const s of stays) assert.equal(await exists(s), true, `${s} stays while the browser is open`);
    assert.equal(await exists(join(two, 'component_crx_cache')), false);
  } finally {
    await rm(a.root, { recursive: true, force: true });
  }
});

test('the report says what is inside a big program (version folders and what is in them)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'eaa-report-programs-'));
  try {
    const dataDir = join(root, 'agency');
    const programsDir = join(dataDir, 'programs');
    const MB = 1_000_000;
    await put(join(programsDir, 'ffmpeg', '7.1', 'build-a', 'bin', 'ffmpeg'), 120 * MB);
    await put(join(programsDir, 'ffmpeg', '7.1', 'build-b', 'ffmpeg'), 5 * MB);
    await put(join(programsDir, 'small', '1.0', 'x'), 1 * MB);
    const lines = await diskReport({ dataDir, programsDir, keepDir: join(root, 'keep'), tmpDir: join(root, 'tmp') });
    const inside = lines.find(l => l.startsWith('inside the big programs'))!;
    assert.ok(inside, 'a line for the big programs');
    assert.match(inside, /ffmpeg\/7\.1 125 MB/);
    assert.match(inside, /ffmpeg\/7\.1\/build-a 120 MB/);
    assert.doesNotMatch(inside, /small/);
    assert.match(lines[1]!, /^programs 126 MB: ffmpeg 125 MB$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
