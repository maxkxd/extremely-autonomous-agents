// Windows: the desktop app's runtime is a windowed program, so the processes the agency
// runs on it (plugins, npm programs such as HyperFrames) have no console. Any console
// program they start - ffmpeg, a headless Chrome, Python - then opens a console window
// on the person's screen, one per program. Loaded first in those processes (sandbox.ts,
// programs.ts), this makes "hidden" the default for every program they start; a call
// that asks for a window (windowsHide: false) still gets one.
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

function install() {
  const cp = require('node:child_process');
  if (cp.spawn.__hidesWindows) return;
  const { promisify } = require('node:util');
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = cp[name];
    const wrapped = function (...args) {
      return original.apply(this, hideByDefault(args));
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

if (process.platform === 'win32') install();

module.exports = { hideByDefault };
