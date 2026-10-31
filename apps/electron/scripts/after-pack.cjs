// electron-builder never copies a node_modules folder through extraResources,
// whatever the filter says - and the agency can't start without its
// dependencies. So once the app is laid out (before the installer is made from
// it), they're copied in beside the server.

const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const from = path.join(__dirname, '..', 'build', 'stage', 'server', 'node_modules');
  const resources = context.packager.platform.name === 'mac' ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources') : path.join(context.appOutDir, 'resources');
  const to = path.join(resources, 'server', 'node_modules');
  if (!fs.existsSync(from)) throw new Error(`Nothing staged at ${from}: run npm run stage first.`);
  fs.cpSync(from, to, { recursive: true });
};
