// Puts together what the installer ships beside the app (build/stage), from the repo:
//   server/ - apps/server as it runs in development: its source (run with tsx, so
//             every path it reads works as it does there), shipped integrations,
//             packs, and its production dependencies
//   ui/     - apps/desktop built (VITE_CLERK_PUBLISHABLE_KEY and VITE_EAA_BACKEND_URL
//             from the environment, or apps/desktop/.env.local)
//   node/   - the Node that runs this script, as the agency's own runtime
// Run on the platform being built for: node and the dependencies are that platform's.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const STAGE = path.join(__dirname, '..', 'build', 'stage');
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit', env: process.env });

// The agency needs node:sqlite, unflagged from Node 22.13; built and tested on 24.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) throw new Error(`Node ${process.versions.node} is too old to ship: use 24.`);

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

// --- server ---
const server = path.join(STAGE, 'server');
const from = path.join(ROOT, 'server');
for (const item of ['src', 'integrations', 'packs', 'package.json', 'package-lock.json'])
  fs.cpSync(path.join(from, item), path.join(server, item), {
    recursive: true,
    // Tests and local state stay behind.
    filter: src => !/\.test\.ts$/.test(src) && !/[\\/](data|node_modules)([\\/]|$)/.test(path.relative(from, src)),
  });
run('npm ci --omit=dev --no-audit --no-fund', server);

// --- ui ---
run('npm ci --no-audit --no-fund', path.join(ROOT, 'desktop'));
run('npm run build', path.join(ROOT, 'desktop'));
fs.cpSync(path.join(ROOT, 'desktop', 'dist'), path.join(STAGE, 'ui'), { recursive: true });

// --- node ---
fs.mkdirSync(path.join(STAGE, 'node'), { recursive: true });
fs.copyFileSync(process.execPath, path.join(STAGE, 'node', path.basename(process.execPath)));

console.log(`Staged in ${STAGE} (Node ${process.versions.node}).`);
