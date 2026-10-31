// The desktop app (docs/packaging.md): starts this computer's agency (apps/server)
// with Electron's own Node (ELECTRON_RUN_AS_NODE), shows the app it serves, and keeps the agency
// running in the tray when the window closes - agents work in the background.
// Updates come from GitHub Releases; before one installs, the agency is put on
// standby and running agents finish, so no run is cut off.

const { app, BrowserWindow, Menu, Tray, dialog, shell } = require('electron');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

// Fixed, not picked at random: a service's sign-in comes back to 127.0.0.1:5175,
// and that's the address people register with Google, Zoho and the like.
// (EAA_*_PORT only to try a build beside a running development server.)
const PORTS = { app: Number(process.env.EAA_APP_PORT) || 5175, hooks: Number(process.env.EAA_HOOKS_PORT) || 5176, hosted: Number(process.env.EAA_HOSTED_PORT) || 5185 };
const ORIGIN = `http://127.0.0.1:${PORTS.app}`;

// Packaged: everything is in resources. Run from the repo (npm start): the repo's own folders.
const RES = app.isPackaged ? process.resourcesPath : path.join(__dirname, 'build', 'stage');
const SERVER_DIR = app.isPackaged ? path.join(RES, 'server') : path.join(__dirname, '..', 'server');
const UI_DIR = app.isPackaged ? path.join(RES, 'ui') : path.join(__dirname, '..', 'desktop', 'dist');
// Electron is Node too: run as Node, it starts the agency - and whatever the agency
// starts with process.execPath (an organisation it hosts, the plugin sandbox),
// since they inherit ELECTRON_RUN_AS_NODE. One runtime shipped, not two.
const NODE = app.isPackaged ? process.execPath : 'node';

const DATA = path.join(app.getPath('userData'), 'data');
const LOGS = path.join(app.getPath('userData'), 'logs');
const RESUME_FILE = path.join(app.getPath('userData'), 'resume-after-update.json');

let server = null;
let quitting = false;
let restarts = 0;
let win = null;
let tray = null;

// --- One copy only ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => show());
  app.whenReady().then(start);
}

// --- The agency ------------------------------------------------------------------------------

const portFree = port =>
  new Promise(done => {
    const s = net.createServer();
    s.once('error', () => done(false));
    s.once('listening', () => s.close(() => done(true)));
    s.listen(port, '0.0.0.0');
  });

function log() {
  fs.mkdirSync(LOGS, { recursive: true });
  return fs.createWriteStream(path.join(LOGS, 'agency.log'), { flags: 'a' });
}

function startServer() {
  const out = log();
  out.write(`\n--- started ${new Date().toISOString()} ---\n`);
  server = spawn(NODE, ['--import', 'tsx', 'src/index.ts'], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORTS.app),
      HOOKS_PORT: String(PORTS.hooks),
      EAA_HOSTED_PORT: String(PORTS.hosted),
      EAA_DATA_DIR: DATA,
      EAA_UI_DIR: UI_DIR,
      EAA_APP_PID: String(process.pid), // it stops if the app goes (hosting.ts)
      NODE_ENV: 'production',
      ELECTRON_RUN_AS_NODE: app.isPackaged ? '1' : undefined,
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(out, { end: false });
  server.stderr.pipe(out, { end: false });
  server.on('exit', code => {
    server = null;
    out.write(`--- stopped (${code}) ${new Date().toISOString()} ---\n`);
    if (quitting) return;
    // It fell over: start it again, waiting longer each time; after five, say so.
    if (restarts++ < 5) setTimeout(startServer, 1000 * 2 ** restarts);
    else dialog.showErrorBox('The agency stopped', `It kept stopping. What it said is in:\n${path.join(LOGS, 'agency.log')}`);
  });
}

// Stopped with everything it started (an organisation's agency it hosts, tools' processes).
function stopServer() {
  if (!server) return Promise.resolve();
  const pid = server.pid;
  return new Promise(done => {
    server.once('exit', done);
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
    else server.kill();
    setTimeout(done, 5000);
  });
}

async function api(pathname, body) {
  const res = await fetch(ORIGIN + pathname, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${pathname}: ${res.status}`);
  return res.json();
}

async function waitForServer(ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await api('/api/runner/agency');
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return false;
}

// --- The window and tray ---------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#141414',
    title: 'Extremely Autonomous Agents',
    icon: path.join(__dirname, 'build', 'icon.png'),
    show: false,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.loadURL(ORIGIN);
  win.once('ready-to-show', () => {
    if (!process.argv.includes('--hidden')) win.show();
  });
  // Anything that isn't the app (a service's sign-in, a docs link) opens in the person's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ORIGIN)) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  // Closing the window keeps the agency working; Quit (tray) stops it.
  win.on('close', e => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function show() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function trayMenu() {
  const login = app.getLoginItemSettings();
  return Menu.buildFromTemplate([
    { label: 'Open', click: show },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: login.openAtLogin,
      click: item => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
        tray.setContextMenu(trayMenu());
      },
    },
    { type: 'separator' },
    { label: 'Quit (stops the agents)', click: () => quit() },
  ]);
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'build', 'icon.png'));
  tray.setToolTip('Extremely Autonomous Agents');
  tray.setContextMenu(trayMenu());
  tray.on('click', show);
}

async function quit() {
  quitting = true;
  await stopServer();
  app.quit();
}

// --- Updates ---------------------------------------------------------------------------------

// Both agencies this computer runs: its own, and an organisation's it hosts (if any).
const AGENCIES = ['/api', '/hosted/api'];

async function drainThenInstall(autoUpdater) {
  const before = {};
  for (const a of AGENCIES) {
    try {
      before[a] = (await api(`${a}/runner/agency`)).state;
      if (before[a] === 'active') await api(`${a}/runner/agency`, { state: 'standby' });
    } catch {
      // no organisation hosted here
    }
  }
  fs.writeFileSync(RESUME_FILE, JSON.stringify(before));
  // Running agents finish (at most half an hour).
  const end = Date.now() + 30 * 60_000;
  while (Date.now() < end) {
    let running = 0;
    for (const a of Object.keys(before)) {
      try {
        running += Object.values(await api(`${a}/runner/agents?days=1`)).filter(x => x.running).length;
      } catch {
        // gone
      }
    }
    if (!running) break;
    await new Promise(r => setTimeout(r, 5000));
  }
  quitting = true;
  await stopServer();
  autoUpdater.quitAndInstall(true, true);
}

// After an update: each agency back to how it was.
async function resumeAfterUpdate() {
  if (!fs.existsSync(RESUME_FILE)) return;
  try {
    const before = JSON.parse(fs.readFileSync(RESUME_FILE, 'utf8'));
    for (const [a, state] of Object.entries(before)) if (state === 'active') await api(`${a}/runner/agency`, { state: 'active' }).catch(() => {});
  } finally {
    fs.rmSync(RESUME_FILE, { force: true });
  }
}

function watchForUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require('electron-updater');
  autoUpdater.autoInstallOnAppQuit = false; // only through drainThenInstall, never mid-run
  autoUpdater.on('update-downloaded', async info => {
    const { response } = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart and update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: `Version ${info.version} is ready.`,
      detail: 'Agents go on standby and any run in progress finishes first, then the app restarts. They carry on as before afterwards.',
    });
    if (response === 0) await drainThenInstall(autoUpdater);
  });
  autoUpdater.on('error', e => log().write(`update check failed: ${e.message}\n`));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, 6 * 3_600_000);
}

// --- Start -----------------------------------------------------------------------------------

async function start() {
  Menu.setApplicationMenu(null);
  const busy = [];
  for (const [name, port] of Object.entries(PORTS)) if (!(await portFree(port))) busy.push(`${port} (${name})`);
  if (busy.length) {
    dialog.showErrorBox(
      'Another program is using the agency\'s ports',
      `Port ${busy.join(', ')} is in use - most likely another copy of the agency, or a development server. Close it and open the app again.`,
    );
    app.exit(1);
    return;
  }
  startServer();
  createTray();
  createWindow();
  if (!(await waitForServer())) {
    dialog.showErrorBox('The agency didn\'t start', `What it said is in:\n${path.join(LOGS, 'agency.log')}`);
    return;
  }
  restarts = 0;
  win.loadURL(ORIGIN);
  await resumeAfterUpdate();
  watchForUpdates();
}

app.on('window-all-closed', () => {
  // The tray keeps it running.
});
app.on('before-quit', () => {
  quitting = true;
});
// However it ends (signing out of Windows, a crash in here), the agency doesn't outlive it.
app.on('will-quit', () => {
  if (server && process.platform === 'win32') execFile('taskkill', ['/pid', String(server.pid), '/T', '/F'], () => {});
  else server?.kill();
});
