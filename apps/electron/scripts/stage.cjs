// Puts together what the installer ships beside the app (build/stage), from the repo:
//   server/ - apps/server as it runs in development: its source (run with tsx, so
//             every path it reads works as it does there), shipped integrations,
//             packs, and its production dependencies
//   ui/     - apps/desktop built (VITE_CLERK_PUBLISHABLE_KEY and VITE_EAA_BACKEND_URL
//             from the environment, or apps/desktop/.env.local)
// Run on the platform being built for: the dependencies are that platform's.

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const STAGE = path.join(__dirname, '..', 'build', 'stage');
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit', env: process.env });

// The agency runs on Electron's Node (24 in Electron 43); building needs 22.13 or later too.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) throw new Error(`Node ${process.versions.node} is too old to build with: use 24.`);

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
// Our own OAuth clients (apps/server/src/integrations/shared-clients.ts), from the
// release environment: people sign in with them and make nothing. Never in git.
// Built on a computer that has them in apps/server/.env (development's own, also
// never in git): from there, so a local build signs in as the release does.
const serverEnv = (() => {
  try {
    return fs.readFileSync(path.join(from, '.env'), 'utf8');
  } catch {
    return '';
  }
})();
const fromEnv = name => (process.env[name] ?? new RegExp(`^${name}=(.*)$`, 'm').exec(serverEnv)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
const google = fromEnv('EAA_GOOGLE_CLIENT_ID');
if (google) fs.writeFileSync(path.join(server, 'shared-clients.json'), JSON.stringify({ google: { clientId: google, clientSecret: fromEnv('EAA_GOOGLE_CLIENT_SECRET') || undefined } }));
else console.warn("No EAA_GOOGLE_CLIENT_ID: Gmail sign-in will ask for the person's own Google client.");
// Our backend, the one the app is built with: connection failures are reported
// there as kinds only (apps/server/src/integrations/report.ts). None: nothing is sent.
const envLocal = (() => {
  try {
    return fs.readFileSync(path.join(ROOT, 'desktop', '.env.local'), 'utf8');
  } catch {
    return '';
  }
})();
const backend = (process.env.VITE_EAA_BACKEND_URL ?? /^VITE_EAA_BACKEND_URL=(.*)$/m.exec(envLocal)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
if (/^https:\/\//.test(backend)) fs.writeFileSync(path.join(server, 'backend.json'), JSON.stringify({ url: backend }));
else console.warn('No https VITE_EAA_BACKEND_URL: connection failures will not be reported.');
// Copilot's runtime (about 160 MB, most of the app) is fetched the first time
// someone connects Copilot (apps/server/src/models/copilotRuntime.ts), not shipped.
const gh = path.join(server, 'node_modules', '@github');
for (const name of fs.existsSync(gh) ? fs.readdirSync(gh) : [])
  if (/^copilot-sdk-(darwin|linux|linuxmusl|win32)-/.test(name)) fs.rmSync(path.join(gh, name), { recursive: true, force: true });

// --- ui ---
// Built from a copy: a running development server holds apps/desktop's esbuild.exe
// open, and npm ci there can't replace it (EPERM).
const desktop = path.join(__dirname, '..', 'build', 'desktop');
fs.rmSync(desktop, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'desktop'), desktop, { recursive: true, filter: src => !/[\\/](node_modules|dist)([\\/]|$)/.test(path.relative(path.join(ROOT, 'desktop'), src)) });
// The sign-in key: development's (pk_test_, in apps/desktop/.env.local) knows none of
// the real accounts - an app built with it comes up signed out of everything, and
// Google sign-in fails. An installer is built with production's unless asked.
const clerkKey = (process.env.VITE_CLERK_PUBLISHABLE_KEY ?? /^VITE_CLERK_PUBLISHABLE_KEY=(.*)$/m.exec(envLocal)?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
if (clerkKey.startsWith('pk_test_') && !process.env.EAA_ALLOW_TEST_SIGN_IN)
  throw new Error("This would build with development's sign-in key (pk_test_): set VITE_CLERK_PUBLISHABLE_KEY to production's (the release environment's CLERK_PUBLISHABLE_KEY), or EAA_ALLOW_TEST_SIGN_IN=1 for a test build.");
run('npm ci --no-audit --no-fund', desktop);
run('npm run build', desktop);
fs.cpSync(path.join(desktop, 'dist'), path.join(STAGE, 'ui'), { recursive: true });

console.log(`Staged in ${STAGE}.`);
