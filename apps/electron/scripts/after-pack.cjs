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
  fs.cpSync(from, to, { recursive: true });
  // Chromium's WebGPU shader compiler (25 MB): the app's own pages don't use WebGPU.
  if (context.packager.platform.name === 'windows') for (const f of ['dxcompiler.dll', 'dxil.dll']) fs.rmSync(path.join(context.appOutDir, f), { force: true });
};
