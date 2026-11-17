// Windows: the desktop app's runtime is a windowed program, so the processes the agency
// runs on it (plugins, npm programs such as HyperFrames) have no console. Any console
// program they start - ffmpeg, a headless Chrome, Python - then opens a console window
// on the person's screen, one per program. Loaded first in those processes (sandbox.ts,
// programs.ts), this makes "hidden" the default for every program they start; a call
// that asks for a window (windowsHide: false) still gets one.
//
// A detached program (plugins detach long jobs so they outlive the plugin's process)
// gets no console at all - Windows ignores windowsHide then - so every console program
// IT starts opens a window (job.py's Python tools, their ffmpeg). Those go through this
// file as a launcher instead: the launcher is the detached one, and it starts the program
// in a hidden console its own programs share. Killing the launcher kills the program.
'use strict';

// The arguments with windowsHide defaulted to true: the options object is the first
// plain object after the command; with none, one goes where the options belong
// (before a callback, or at the end).
function hideByDefault(args) {
  const out = [...args];
  for (let i = 1; i <= out.length; i++) {
    const a = out[i];
    if (Array.isArray(a) || (a == null && i < out.length - 1)) continue;
    if (a && typeof a === 'object') {
      if (a.windowsHide === undefined) out[i] = { ...a, windowsHide: true };
    } else if (a === undefined && i === out.length - 1) {
      out[i] = { windowsHide: true };
    } else {
      out.splice(i, 0, { windowsHide: true });
    }
    break;
  }
  return out;
}

const hasIpc = stdio => Array.isArray(stdio) && stdio.includes('ipc');

// spawn(file, args, opts) for a detached, hidden program -> the same call starting the
// launcher with it; anything else -> null (started as it is).
function throughLauncher(spawnArgs, runtime = process.execPath, electron = Boolean(process.versions.electron)) {
  const [file, maybeArgs, maybeOpts] = spawnArgs;
  const args = Array.isArray(maybeArgs) ? maybeArgs : [];
  const opts = Array.isArray(maybeArgs) ? maybeOpts : maybeArgs;
  if (!opts || typeof opts !== 'object' || !opts.detached || opts.windowsHide === false || hasIpc(opts.stdio)) return null;
  const base = opts.env ?? process.env;
  const spec = { file: String(file), args: args.map(String), shell: opts.shell ?? false, verbatim: Boolean(opts.windowsVerbatimArguments), argv0: opts.argv0, runAsNode: base.ELECTRON_RUN_AS_NODE ?? null };
  // The app's runtime is Electron: it runs this file as Node only with ELECTRON_RUN_AS_NODE.
  // The launcher puts the program's own value back.
  const env = electron ? { ...base, ELECTRON_RUN_AS_NODE: '1' } : base;
  const { shell, windowsVerbatimArguments, argv0, ...rest } = opts;
  // --no-warnings: Node's own notices (a plugin's permission flags carry over) would land in the program's log.
  return [runtime, ['--no-warnings', __filename, JSON.stringify(spec)], { ...rest, env, windowsHide: true }];
}

function install() {
  const cp = require('node:child_process');
  if (cp.spawn.__hidesWindows) return;
  const { promisify } = require('node:util');
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = cp[name];
    const wrapped = function (...args) {
      const hidden = hideByDefault(args);
      return original.apply(this, (name === 'spawn' && throughLauncher(hidden)) || hidden);
    };
    // exec/execFile promisify to { stdout, stderr }, like Node's own.
    if (original[promisify.custom])
      wrapped[promisify.custom] = (...args) => {
        let child;
        const p = new Promise((resolve, reject) => {
          child = wrapped(...args, (err, stdout, stderr) => (err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout, stderr })));
        });
        p.child = child;
        return p;
      };
    wrapped.__hidesWindows = true;
    cp[name] = wrapped;
  }
  // `import { spawn } from 'node:child_process'` sees the new functions too.
  require('node:module').syncBuiltinESMExports();
}

// As the launcher: start the program in a hidden console, pass its output straight
// through, and end as it ends. A program that can't start says why on its stderr.
function launch(spec) {
  const env = { ...process.env };
  if (spec.runAsNode == null) delete env.ELECTRON_RUN_AS_NODE;
  else env.ELECTRON_RUN_AS_NODE = spec.runAsNode;
  const child = require('node:child_process').spawn(spec.file, spec.args, { stdio: 'inherit', env, shell: spec.shell, windowsVerbatimArguments: spec.verbatim, argv0: spec.argv0, windowsHide: true });
  child.on('error', e => {
    process.stderr.write(`Couldn't start ${spec.file}: ${e.message}\n`);
    process.exit(127);
  });
  child.on('exit', code => process.exit(code ?? 1));
}

if (process.platform === 'win32') install();
if (require.main === module) launch(JSON.parse(process.argv[2]));

module.exports = { hideByDefault, throughLauncher };
