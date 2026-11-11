import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  installProgram,
  listPrograms,
  parseReleaseUrl,
  programPathDirs,
  programsRoot,
  releaseChecksum,
  removeProgram,
  setProgramFetcher,
  verifyPrograms,
  withProgramsOnPath,
} from './programs.js';
import { buildPlugin, runSandboxed } from './sandbox.js';
import { BUILT_IN_CARDS } from '../runner/approvals.js';
import { installSpecOf } from '../runner/engineer.js';

// Programs a plugin runs (programs.ts). Node's own binary stands in for a
// downloaded program: it's on every machine the tests run on, and answers --version.

const WIN = process.platform === 'win32';
const NODE = readFileSync(process.execPath);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const work = mkdtempSync(join(tmpdir(), 'eaa-programs-'));

// A pretend GitHub: releases by tag, and their files.
type Rel = { tag: string; files: Record<string, Buffer>; digests?: boolean };
let releases: Rel[] = [];
const served: string[] = [];
setProgramFetcher(async url => {
  served.push(url);
  const api = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/releases\/tags\/(.+)$/);
  if (api) {
    const r = releases.find(x => x.tag === decodeURIComponent(api[2]));
    if (!r) return { res: new Response('{"message":"Not Found"}', { status: 404 }) };
    const assets = Object.entries(r.files).map(([name, b]) => ({
      name,
      size: b.length,
      digest: r.digests ? `sha256:${sha(b)}` : null,
      browser_download_url: `https://github.com/o/p/releases/download/${r.tag}/${name}`,
    }));
    return { res: Response.json({ assets }) };
  }
  const dl = url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/([^/]+)\/([^/]+)$/);
  const body = dl && releases.find(x => x.tag === decodeURIComponent(dl[1]))?.files[decodeURIComponent(dl[2])];
  return { res: body ? new Response(new Uint8Array(body)) : new Response('nope', { status: 404 }) };
});
after(() => setProgramFetcher(null));

test('only a pinned GitHub release download is a source', () => {
  const s = parseReleaseUrl('https://github.com/yt-dlp/yt-dlp/releases/download/2025.10.22/yt-dlp_linux');
  assert.deepEqual([s.repo, s.tag, s.asset], ['yt-dlp/yt-dlp', '2025.10.22', 'yt-dlp_linux']);
  assert.throws(() => parseReleaseUrl('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'), /release on GitHub/);
  assert.throws(() => parseReleaseUrl('https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz'), /Pin a release/);
  assert.throws(() => parseReleaseUrl('https://example.com/ffmpeg.tar.xz'), /release on GitHub/);
  assert.throws(() => parseReleaseUrl('http://github.com/a/b/releases/download/v1/x'), /release on GitHub/);
  assert.throws(() => parseReleaseUrl('https://github.com/a/b/releases/download/v1/x?evil=1'), /release on GitHub/);
});

test("the checksum comes from the release: GitHub's digest, else its checksum file; a wrong one given is refused", async () => {
  const file = Buffer.from('a program');
  releases = [
    { tag: 'd1', files: { 'tool.tar.gz': file }, digests: true },
    { tag: 's1', files: { 'tool.tar.gz': file, 'SHA2-256SUMS': Buffer.from(`${sha(Buffer.from('other'))}  other.zip\n${sha(file)}  tool.tar.gz\n`) } },
    { tag: 'n1', files: { 'tool.tar.gz': file } },
  ];
  const src = (tag: string) => parseReleaseUrl(`https://github.com/o/p/releases/download/${tag}/tool.tar.gz`);
  assert.equal((await releaseChecksum(src('d1'))).sha256, sha(file));
  const fromFile = await releaseChecksum(src('s1'));
  assert.equal(fromFile.sha256, sha(file));
  assert.match(fromFile.how, /SHA2-256SUMS/);
  await assert.rejects(releaseChecksum(src('s1'), 'f'.repeat(64)), /doesn't match/);
  await assert.rejects(releaseChecksum(src('n1')), /publishes no checksum/);
  assert.equal((await releaseChecksum(src('n1'), sha(file))).sha256, sha(file));
  await assert.rejects(releaseChecksum(src('nope')), /Couldn't find release/);
  await assert.rejects(releaseChecksum(parseReleaseUrl('https://github.com/o/p/releases/download/d1/missing.zip')), /has no file "missing.zip"/);
});

test('a single-file program: downloaded, checked, tried, and on plugins\' PATH', async () => {
  releases = [{ tag: 'v1', files: { 'fakeprog_linux': NODE }, digests: true }];
  const p = await installProgram({ name: 'fakeprog', version: '1.0', source: parseReleaseUrl('https://github.com/o/p/releases/download/v1/fakeprog_linux'), sha256: sha(NODE), bins: ['fakeprog'] }, 'fleet');
  assert.equal(p.check, process.version);
  assert.equal(programPathDirs().length, 1);
  assert.ok(withProgramsOnPath('/usr/bin').startsWith(join(programsRoot(), 'fakeprog', '1.0')));
  const listed = await listPrograms();
  assert.equal(listed.find(x => x.name === 'fakeprog')?.state, 'ok');
});

test('a download whose checksum differs from the approved one installs nothing', async () => {
  releases = [{ tag: 'v2', files: { 'fakeprog_linux': Buffer.concat([NODE, Buffer.from('tampered')]) } }];
  await assert.rejects(
    installProgram({ name: 'fakeprog', version: '2.0', source: parseReleaseUrl('https://github.com/o/p/releases/download/v2/fakeprog_linux'), sha256: sha(NODE), bins: ['fakeprog'] }),
    /checksum is .* not the approved/,
  );
  // The working version stays.
  assert.equal((await listPrograms()).find(x => x.name === 'fakeprog')?.version, '1.0');
});

// Packed with the same tar the installer unpacks with.
const TAR = WIN ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
function tarball(): Buffer {
  const src = join(work, 'pkg-src');
  mkdirSync(join(src, 'pkg', 'bin'), { recursive: true });
  mkdirSync(join(src, 'pkg', 'doc'), { recursive: true });
  copyFileSync(process.execPath, join(src, 'pkg', 'bin', WIN ? 'packed.exe' : 'packed'));
  writeFileSync(join(src, 'pkg', 'doc', 'README'), 'docs');
  const out = join(work, 'packed.tar.gz');
  execFileSync(TAR, ['-czf', out, '-C', src, 'pkg']);
  return readFileSync(out);
}

test('an archive is unpacked, its command found, every file recorded - and a changed file takes it off the PATH on start', async () => {
  const tgz = tarball();
  releases = [{ tag: 'b7', files: { 'packed-linux64.tar.gz': tgz }, digests: true }];
  const p = await installProgram({ name: 'packed', version: '7', source: parseReleaseUrl('https://github.com/o/p/releases/download/b7/packed-linux64.tar.gz'), sha256: sha(tgz), bins: ['packed'] });
  assert.ok(Object.keys(p.files).some(f => f.endsWith('pkg/doc/README')));
  assert.equal(p.pathDirs[0], 'packed/7/pkg/bin');

  // Python's compiled files don't count as a change.
  mkdirSync(join(programsRoot(), 'packed', '7', 'pkg', '__pycache__'), { recursive: true });
  writeFileSync(join(programsRoot(), 'packed', '7', 'pkg', '__pycache__', 'x.cpython-312.pyc'), 'x');
  const told: string[] = [];
  await verifyPrograms(name => told.push(name));
  assert.deepEqual(told, []);
  assert.ok(programPathDirs().some(d => d.endsWith(join('pkg', 'bin'))));

  // An added file, or one edited, does.
  appendFileSync(join(programsRoot(), 'packed', '7', 'pkg', 'doc', 'README'), ' and more');
  const told2: string[] = [];
  await verifyPrograms(name => void told2.push(name));
  assert.deepEqual(told2, ['packed']);
  assert.ok(!programPathDirs().some(d => d.endsWith(join('pkg', 'bin'))), 'off the PATH');
  assert.match((await listPrograms()).find(x => x.name === 'packed')!.state, /1 file changed/);
  assert.ok(await removeProgram('packed'));
});

test('a download without the named command is refused, saying which build it needs', async () => {
  releases = [{ tag: 'w1', files: { 'other.tar.gz': tarball() }, digests: true }];
  await assert.rejects(
    installProgram({ name: 'other', version: '1', source: parseReleaseUrl('https://github.com/o/p/releases/download/w1/other.tar.gz'), sha256: sha(readFileSync(join(work, 'packed.tar.gz'))), bins: ['ffmpeg'] }),
    /has no ffmpeg/,
  );
  assert.equal((await listPrograms()).find(x => x.name === 'other'), undefined);
});

test('a sandboxed plugin with commands: true runs an installed program by its name', async () => {
  const code = `import { execFileSync } from 'node:child_process';
export default { tools: [{ id: 'x.ver', tier: 'T0', description: '', input: {}, run: async () => execFileSync('fakeprog', ['--version']).toString().trim() }] };`;
  const file = await buildPlugin('zz-runs-program', code, 'beef'.repeat(16));
  const out = await runSandboxed(file, { read: [], write: [], commands: true }, { op: 'run', tool: 'x.ver', args: {} });
  assert.equal(out.result, process.version);
  // Without commands: true, it can't.
  const refused = await runSandboxed(file, { read: [], write: [], commands: false }, { op: 'run', tool: 'x.ver', args: {} });
  assert.match(refused.error ?? '', /ERR_ACCESS_DENIED|Access to this API/);
});

test("the Engineer's arguments and the card the person sees", () => {
  const spec = installSpecOf({ name: 'FFmpeg', version: '7.1', source: 'github_release', url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2025-11-10-13-02/ffmpeg-n7.1.2-linux64-gpl-7.1.tar.xz', bins: ['ffmpeg', 'ffprobe'], check_args: ['-version'] });
  assert.equal(spec.name, 'ffmpeg');
  assert.equal(spec.source.kind === 'github_release' && spec.source.repo, 'BtbN/FFmpeg-Builds');
  assert.deepEqual(installSpecOf({ name: 'yt-dlp', version: '2025.10.22', source: 'pypi', bins: ['yt-dlp'] }).source, { kind: 'pypi', package: 'yt-dlp' });
  assert.throws(() => installSpecOf({ name: 'x', version: '1', source: 'apt', bins: [] }), /github_release or pypi/);
  const card = BUILT_IN_CARDS['engineer.install_program'];
  assert.match(card.wants_to, /\{program\}/);
  // Every placeholder is a field the preview fills in.
  const filled = ['program', 'where', 'for_agent_name', 'source_line', 'checked', 'heads_up', 'why'];
  for (const t of [card.wants_to, card.body ?? '', ...card.headers.map(h => h.value)]) for (const m of t.matchAll(/\{(\w+)\}/g)) assert.ok(filled.includes(m[1]), m[1]);
});
