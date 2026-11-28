// The browser the agents' own profiles open in, shipped with the app: Google's
// Chrome for Testing, which (unlike branded Chrome and Edge) keeps loading an
// extension the app gives it on the command line. Staged per processor in
// build/stage/browser-<arch> (package.json's extraResources picks the one for the
// app being built), and signed with the app when the app is signed - Windows' Smart
// App Control won't start it unsigned (win.signExts).
//
// Windows x64 and Mac (Apple silicon and Intel) only: there's no Windows-on-Arm
// build, and Linux uses the system's Chromium. Where there's none, the folder is
// left empty and the app opens the profiles in Edge or a Chromium it finds.
//
// EAA_BROWSER_VERSION pins a version (e.g. 158.0.8127.88); by default it's the
// current stable one. Downloads are kept in build/browser-cache.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CACHE = path.join(__dirname, '..', 'build', 'browser-cache');
const STABLE = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';
const ALL = 'https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json';

// Chrome for Testing's platform name for a build target, or null where there's none.
function cftPlatform(platform, arch) {
  if (platform === 'win32') return arch === 'x64' ? 'win64' : null;
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : arch === 'x64' ? 'mac-x64' : null;
  return null;
}

// Where the browser is inside its folder, as the app looks for it (agent-profiles.ts).
const EXE = { win64: 'chrome.exe', 'mac-arm64': 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'mac-x64': 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing' };

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const part = `${file}.part`;
  fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(part, file);
}

function unzip(zip, to, platform) {
  fs.mkdirSync(to, { recursive: true });
  // ditto keeps the Mac app's symbolic links and its frameworks as they are.
  if (platform === 'darwin') execFileSync('ditto', ['-x', '-k', zip, to], { stdio: 'inherit' });
  // Windows' own tar (bsdtar) reads zips; a Git Bash tar earlier on the PATH doesn't.
  else if (platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', to], { stdio: 'inherit' });
  else execFileSync('unzip', ['-q', zip, '-d', to], { stdio: 'inherit' });
}

async function stageBrowser(stage, archs, platform = process.platform) {
  const wanted = archs.map(arch => ({ arch, cft: cftPlatform(platform, arch) }));
  let version = process.env.EAA_BROWSER_VERSION?.trim();
  let downloads;
  if (wanted.some(w => w.cft)) {
    if (version) {
      const found = (await json(ALL)).versions.find(v => v.version === version);
      if (!found?.downloads?.chrome) throw new Error(`Chrome for Testing ${version} isn't one Google lists.`);
      downloads = found.downloads.chrome;
    } else {
      const stable = (await json(STABLE)).channels.Stable;
      version = stable.version;
      downloads = stable.downloads.chrome;
    }
  }
  for (const { arch, cft } of wanted) {
    const to = path.join(stage, `browser-${arch}`);
    fs.rmSync(to, { recursive: true, force: true });
    fs.mkdirSync(to, { recursive: true });
    if (!cft) {
      fs.writeFileSync(path.join(to, 'NONE.txt'), `No browser is shipped for ${platform} ${arch}: the agents' profiles open in Edge or Chromium.\n`);
      console.log(`No browser for ${platform} ${arch}.`);
      continue;
    }
    const url = downloads.find(d => d.platform === cft)?.url;
    if (!url) throw new Error(`Chrome for Testing ${version} has no ${cft} download.`);
    fs.mkdirSync(CACHE, { recursive: true });
    const zip = path.join(CACHE, `${version}-${cft}.zip`);
    if (!fs.existsSync(zip)) {
      console.log(`Downloading Chrome for Testing ${version} (${cft})...`);
      await download(url, zip);
    }
    const tmp = path.join(stage, `browser-${arch}.unzip`);
    fs.rmSync(tmp, { recursive: true, force: true });
    unzip(zip, tmp, platform);
    // The zip holds one folder (chrome-win64, chrome-mac-arm64): its contents are the browser.
    const inner = path.join(tmp, `chrome-${cft}`);
    if (!fs.existsSync(inner)) throw new Error(`${zip} doesn't hold chrome-${cft}.`);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(inner, to);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(path.join(to, EXE[cft]))) throw new Error(`The staged browser has no ${EXE[cft]}.`);
    fs.writeFileSync(path.join(to, 'BROWSER.json'), JSON.stringify({ name: 'Chrome for Testing', version, platform: cft, exe: EXE[cft] }, null, 2));
    console.log(`Staged Chrome for Testing ${version} for ${platform} ${arch}.`);
  }
}

module.exports = { stageBrowser, cftPlatform, EXE };

if (require.main === module) {
  const archs = [process.arch, ...(process.env.EAA_EXTRA_ARCHS ?? '').split(',').map(a => a.trim()).filter(Boolean)];
  stageBrowser(path.join(__dirname, '..', 'build', 'stage'), archs).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
