// Puts together what the installer ships beside the app (build/stage), from the repo:
//   server/ - apps/server as it runs in development: its source (run with tsx, so
//             every path it reads works as it does there), shipped integrations,
//             packs, and its production dependencies
//   ui/     - apps/desktop built (VITE_CLERK_PUBLISHABLE_KEY and VITE_EAA_BACKEND_URL
//             from the environment, or apps/desktop/.env.local)
//   extension/ - the EXTREMELY extension (apps/person-chrome), its runtime files only:
//             the agents' profiles load it (apps/server/src/runner/agent-profiles.ts)
//   browser-<arch>/ - the browser those profiles open in (stage-browser.cjs)
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
const microsoft = fromEnv('EAA_MICROSOFT_CLIENT_ID');
const shared = {
  ...(google && { google: { clientId: google, clientSecret: fromEnv('EAA_GOOGLE_CLIENT_SECRET') || undefined } }),
  // Microsoft's is a public client: an id and no secret.
  ...(microsoft && { microsoft: { clientId: microsoft } }),
};
if (Object.keys(shared).length) fs.writeFileSync(path.join(server, 'shared-clients.json'), JSON.stringify(shared));
if (!google) console.warn("No EAA_GOOGLE_CLIENT_ID: Gmail sign-in will ask for the person's own Google client.");
if (!microsoft) console.warn("No EAA_MICROSOFT_CLIENT_ID: Outlook sign-in will ask for the person's own Microsoft app.");
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
// And what never runs stays out of the download: type declarations, TypeScript
// sources kept for source maps, source maps, docs (a third of node_modules).
// Licence and notice files stay.
function slim(modules) {
  const gh = path.join(modules, '@github');
  for (const name of fs.existsSync(gh) ? fs.readdirSync(gh) : [])
    if (/^copilot-sdk-(darwin|linux|linuxmusl|win32)-/.test(name)) fs.rmSync(path.join(gh, name), { recursive: true, force: true });
  let saved = 0;
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'docs') {
          fs.rmSync(p, { recursive: true, force: true });
          continue;
        }
        walk(p);
      } else if (/\.(map|[cm]?ts|md|markdown)$/i.test(entry.name) && !/^(licen[cs]e|notice|copying)/i.test(entry.name)) {
        saved += fs.statSync(p).size;
        fs.rmSync(p, { force: true });
      }
    }
  };
  walk(modules);
  console.log(`Left out ${(saved / 1e6).toFixed(1)} MB of declarations, maps and docs from ${modules}.`);
}
slim(path.join(server, 'node_modules'));
// A Mac build makes Apple silicon and Intel apps in one go (one latest-mac.yml for
// the updater), and the server's native parts (esbuild, koffi) differ by processor:
// EAA_EXTRA_ARCHS=x64 also stages build/stage/node_modules-x64, which after-pack.cjs
// uses for that architecture's app.
for (const arch of (process.env.EAA_EXTRA_ARCHS ?? '').split(',').map(a => a.trim()).filter(Boolean)) {
  const other = path.join(STAGE, `server-${arch}`);
  fs.mkdirSync(other, { recursive: true });
  for (const f of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(server, f), path.join(other, f));
  // --ignore-scripts: their binaries come prebuilt in per-processor packages
  // (@esbuild/darwin-x64, @koromix/koffi-darwin-x64). koffi's install script checks
  // its binary by loading it on this machine, which can't load another processor's,
  // so it would fall back to compiling from source - for the wrong processor.
  run(`npm ci --omit=dev --no-audit --no-fund --ignore-scripts --cpu=${arch}`, other);
  slim(path.join(other, 'node_modules'));
  fs.renameSync(path.join(other, 'node_modules'), path.join(STAGE, `node_modules-${arch}`));
  fs.rmSync(other, { recursive: true, force: true });
}

// --- extension ---
// What the browser loads, and nothing else: the manifest (with its key, so the
// extension's id - and the pairing it keeps - is the same as in development), the
// scripts, the popup and the icons. Tests, the store notes and the packer stay behind.
const ext = path.join(STAGE, 'extension');
const extFrom = path.join(ROOT, 'person-chrome');
fs.mkdirSync(ext, { recursive: true });
for (const name of fs.readdirSync(extFrom)) {
  const runtime = name === 'manifest.json' || name === 'popup.html' || /^icon\d+\.png$/.test(name) || (name.endsWith('.js') && !/\.test\.js$/.test(name));
  if (runtime && fs.statSync(path.join(extFrom, name)).isFile()) fs.copyFileSync(path.join(extFrom, name), path.join(ext, name));
}
// Every file the manifest names must be there, or the browser refuses the extension.
const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
const named = [manifest.background?.service_worker, manifest.action?.default_popup, ...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {}), ...(manifest.content_scripts || []).flatMap(c => c.js || [])].filter(Boolean);
for (const n of named) if (!fs.existsSync(path.join(ext, n))) throw new Error(`The extension's manifest names ${n}, which isn't staged.`);

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

// --- browser ---
// The agents' profiles' own browser (stage-browser.cjs), for each processor built.
const archs = [process.arch, ...(process.env.EAA_EXTRA_ARCHS ?? '').split(',').map(a => a.trim()).filter(Boolean)];
require('./stage-browser.cjs')
  .stageBrowser(STAGE, archs)
  .then(
    () => console.log(`Staged in ${STAGE}.`),
    e => {
      console.error(e);
      process.exit(1);
    },
  );
