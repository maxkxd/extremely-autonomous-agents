import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, copyFileSync, rmSync, writeFileSync } from 'node:fs';
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
const fakeGitHub = async (url: string) => {
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
};
setProgramFetcher(fakeGitHub);
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

  // Unchanged, it stays.
  const told: string[] = [];
  await verifyPrograms(name => told.push(name));
  assert.deepEqual(told, []);
  assert.ok(programPathDirs().some(d => d.endsWith(join('pkg', 'bin'))));

  // A compiled Python file appearing counts (Python could run a planted one): programs
  // run with PYTHONDONTWRITEBYTECODE, so none appears by itself.
  mkdirSync(join(programsRoot(), 'packed', '7', 'pkg', '__pycache__'), { recursive: true });
  writeFileSync(join(programsRoot(), 'packed', '7', 'pkg', '__pycache__', 'x.cpython-312.pyc'), 'x');
  const told1: string[] = [];
  await verifyPrograms(name => void told1.push(name));
  assert.deepEqual(told1, ['packed']);
  rmSync(join(programsRoot(), 'packed', '7', 'pkg', '__pycache__'), { recursive: true });

  // An edited file does too.
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
  assert.throws(() => installSpecOf({ name: 'x', version: '1', source: 'apt', bins: [] }), /github_release, pypi or npm/);
  const card = BUILT_IN_CARDS['engineer.install_program'];
  assert.match(card.wants_to, /\{program\}/);
  // Every placeholder is a field the preview fills in.
  const filled = ['program', 'where', 'for_agent_name', 'source_line', 'checked', 'heads_up', 'why'];
  for (const t of [card.wants_to, card.body ?? '', ...card.headers.map(h => h.value)]) for (const m of t.matchAll(/\{(\w+)\}/g)) assert.ok(filled.includes(m[1]), m[1]);
});

test('the card names the computer it installs on, for whoever approves it', async () => {
  const { setSetting } = await import('../runner/db.js');
  const { hostName } = await import('../runner/engineer.js');
  const keep = { cloud: process.env.EAA_CLOUD_HOST, self: process.env.EAA_SELF_HOSTED, org: process.env.EAA_HOSTED_ORG };
  try {
    delete process.env.EAA_CLOUD_HOST;
    delete process.env.EAA_SELF_HOSTED;
    delete process.env.EAA_HOSTED_ORG;
    assert.equal(hostName(), 'this computer', "a person's own agency, on their own computer");
    process.env.EAA_HOSTED_ORG = 'org_1';
    assert.equal(hostName(), 'the computer hosting the organization');
    setSetting('host_person', 'Sam Lee');
    assert.equal(hostName(), "Sam Lee's computer", 'teammates elsewhere see whose PC it is');
    process.env.EAA_SELF_HOSTED = '1';
    assert.equal(hostName(), "the organization's server");
    process.env.EAA_CLOUD_HOST = '1';
    assert.equal(hostName(), "the organization's cloud host");
  } finally {
    for (const [k, v] of [['EAA_CLOUD_HOST', keep.cloud], ['EAA_SELF_HOSTED', keep.self], ['EAA_HOSTED_ORG', keep.org]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
});

test('npm: an exact version that exists, with the commands named; deprecated ones and ranges are refused', async () => {
  const { npmRelease, checkSpec } = await import('./programs.js');
  const meta: Record<string, unknown> = {
    'https://registry.npmjs.org/@mermaid-js%2Fmermaid-cli/11.4.0': { description: 'Command-line interface for mermaid', bin: { mmdc: 'src/cli.js' }, dist: { integrity: 'sha512-x', tarball: 'https://registry.npmjs.org/t.tgz' } },
    'https://registry.npmjs.org/old-tool/1.0.0': { deprecated: 'use new-tool', dist: { integrity: 'sha512-x', tarball: 'https://registry.npmjs.org/o.tgz' } },
    'https://registry.npmjs.org/one-bin/2.0.0': { bin: './cli.js', dist: { integrity: 'sha512-x', tarball: 'https://registry.npmjs.org/b.tgz' } },
  };
  setProgramFetcher(async url => ({ res: url in meta ? Response.json(meta[url]) : new Response('{}', { status: 404 }) }));
  try {
    assert.deepEqual((await npmRelease('@mermaid-js/mermaid-cli', '11.4.0')).bins, ['mmdc']);
    assert.deepEqual((await npmRelease('one-bin', '2.0.0')).bins, ['one-bin'], 'a single bin is named after the package');
    await assert.rejects(npmRelease('old-tool', '1.0.0'), /deprecated/);
    await assert.rejects(npmRelease('no-such', '1.0.0'), /npm has no no-such 1.0.0/);
  } finally {
    setProgramFetcher(fakeGitHub);
  }
  const spec = (version: string, pkg = 'prettier') => ({ name: 'prettier', version, source: { kind: 'npm' as const, package: pkg }, bins: [] });
  checkSpec(spec('3.3.3'));
  assert.throws(() => checkSpec(spec('^3.3.3')), /isn't a version|exact npm version/);
  assert.throws(() => checkSpec(spec('latest')), /exact npm version/);
  assert.throws(() => checkSpec(spec('3.3.3', '../evil')), /isn't an npm package name/);
});

test('kit.command: a plugin starts an installed program the same way everywhere', async () => {
  const code = `import { execFileSync } from 'node:child_process';
export default { tools: [
  { id: 'x.cmd', tier: 'T0', description: '', input: {}, run: async (a, t, kit) => { const [cmd, ...pre] = kit.command('fakeprog'); return execFileSync(cmd, [...pre, '--version']).toString().trim() + ' ' + JSON.stringify(kit.command('not-installed')); } },
]};`;
  const file = await buildPlugin('zz-kit-command', code, 'cafe'.repeat(16));
  const out = await runSandboxed(file, { read: [], write: [], commands: true }, { op: 'run', tool: 'x.cmd', args: {} });
  assert.equal(out.result, `${process.version} ["not-installed"]`);
});

test("a program's check never sees the server's keys", async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-test-must-not-leak';
  releases = [{ tag: 'e1', files: { 'envprog': NODE }, digests: true }];
  const p = await installProgram({ name: 'envprog', version: '1', source: parseReleaseUrl('https://github.com/o/p/releases/download/e1/envprog'), sha256: sha(NODE), bins: ['envprog'], checkArgs: ['-p', 'process.env.ANTHROPIC_API_KEY'] });
  assert.equal(p.check, 'undefined');
  await removeProgram('envprog');
});

test('two installs at once both end up recorded', async () => {
  releases = [{ tag: 'c1', files: { 'one': NODE, 'two': NODE }, digests: true }];
  const url = (f: string) => parseReleaseUrl(`https://github.com/o/p/releases/download/c1/${f}`);
  await Promise.all([
    installProgram({ name: 'one', version: '1', source: url('one'), sha256: sha(NODE), bins: ['one'] }),
    installProgram({ name: 'two', version: '1', source: url('two'), sha256: sha(NODE), bins: ['two'] }),
  ]);
  const names = (await listPrograms()).map(x => x.name);
  assert.ok(names.includes('one') && names.includes('two'), names.join(','));
  await removeProgram('one');
  await removeProgram('two');
});

test("installing Python again drops the old one's packages from the record, and says which", async () => {
  releases = [{ tag: 'py1', files: { 'python': NODE }, digests: true }];
  const spec = { name: 'python', version: '3.12.1', source: parseReleaseUrl('https://github.com/o/p/releases/download/py1/python'), sha256: sha(NODE), bins: ['python'], checkArgs: ['--version'] };
  await installProgram(spec);
  // A package pip put in it (written as pip's install records it).
  const manifest = join(programsRoot(), 'programs.json');
  const m = JSON.parse(readFileSync(manifest, 'utf8'));
  m.programs['yt-dlp'] = { name: 'yt-dlp', version: '2026.10.26', source: { kind: 'pypi', package: 'yt-dlp' }, sha256: null, bins: ['yt-dlp'], pathDirs: [], dir: null, files: {}, installedAt: 1, by: null, check: null };
  writeFileSync(manifest, JSON.stringify(m));
  const again = await installProgram({ ...spec, version: '3.12.2' });
  assert.deepEqual(again.dropped, ['yt-dlp']);
  assert.equal((await listPrograms()).find(x => x.name === 'yt-dlp'), undefined);
  await removeProgram('python');
});

test('an approved install a restart cut short starts again, and the Engineer hears how it went', async () => {
  const { addPending, pendingInstalls } = await import('./programs.js');
  const { checkPrograms } = await import('../runner/engineer.js');
  releases = [{ tag: 'r1', files: { 'resumed': NODE }, digests: true }];
  await addPending({ id: 'resumed-x', spec: { name: 'resumed', version: '1', source: parseReleaseUrl('https://github.com/o/p/releases/download/r1/resumed'), sha256: sha(NODE), bins: ['resumed'] }, by: 'fleet', requestId: null, at: Date.now() });
  // Left behind by the restart.
  mkdirSync(join(programsRoot(), '.staging', 'resumed-old'), { recursive: true });
  const woken: string[] = [];
  await checkPrograms((_agent, _t, task) => void woken.push(task));
  for (let i = 0; i < 100 && !woken.length; i++) await new Promise(r => setTimeout(r, 100));
  assert.match(woken[0] ?? '', /^Installed resumed 1/);
  assert.equal((await listPrograms()).find(x => x.name === 'resumed')?.state, 'ok');
  for (let i = 0; i < 20 && (await pendingInstalls()).length; i++) await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(await pendingInstalls(), [], 'no longer pending');
  await removeProgram('resumed');
});

test('the card names the package actually installed, and where its checksum came from', async () => {
  const { fromLine } = await import('../runner/engineer.js');
  assert.equal(fromLine({ kind: 'pypi', package: 'yt-dlp-tools' }), 'yt-dlp-tools on PyPI, the Python package library');
  assert.equal(fromLine({ kind: 'npm', package: '@mermaid-js/mermaid-cli' }), '@mermaid-js/mermaid-cli on npm, the JavaScript package library');
  assert.equal(fromLine(parseReleaseUrl('https://github.com/yt-dlp/yt-dlp/releases/download/1/x')), 'yt-dlp on GitHub');
});
