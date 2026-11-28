// electron-builder never copies a node_modules folder through extraResources,
// whatever the filter says - and the agency can't start without its
// dependencies. So once the app is laid out (before the installer is made from
// it), they're copied in beside the server.

const fs = require('node:fs');
const path = require('node:path');

// electron-builder's Arch enum, by number.
const ARCH = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

exports.default = async function afterPack(context) {
  const stage = path.join(__dirname, '..', 'build', 'stage');
  // Another processor's own native parts, when stage.cjs made them (EAA_EXTRA_ARCHS).
  const forArch = path.join(stage, `node_modules-${ARCH[context.arch]}`);
  const from = fs.existsSync(forArch) ? forArch : path.join(stage, 'server', 'node_modules');
  const resources = context.packager.platform.name === 'mac' ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : path.join(context.appOutDir, 'resources');
  const to = path.join(resources, 'server', 'node_modules');
  if (!fs.existsSync(from)) throw new Error(`Nothing staged at ${from}: run npm run stage first.`);
  // Without .bin: its command links are for npm scripts, and the app never runs
  // them. A Mac app can't hold a link that leads outside it (codesign's "invalid
  // destination for symbolic link"), and cpSync would make every relative link
  // absolute - so links are kept as written (verbatimSymlinks).
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, filter: src => path.basename(src) !== '.bin' });
  // The agents' profiles' browser (stage-browser.cjs) on a Mac: copied here rather than
  // through extraResources, so its frameworks' links stay links (codesign refuses a
  // framework whose links were turned into copies). The app is signed after this, the
  // browser inside it with it. Windows ships it through win.extraResources, where it
  // is signed as it's copied (win.signExts).
  if (context.packager.platform.name === 'mac') {
    const browser = path.join(stage, `browser-${ARCH[context.arch]}`);
    if (fs.existsSync(browser)) fs.cpSync(browser, path.join(resources, 'browser'), { recursive: true, verbatimSymlinks: true });
  }
  // Chromium's WebGPU shader compiler (25 MB): the app's own pages don't use WebGPU.
  if (context.packager.platform.name === 'windows') for (const f of ['dxcompiler.dll', 'dxil.dll']) fs.rmSync(path.join(context.appOutDir, f), { force: true });
};
