import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { HIDE_WINDOWS } from './programs.js';

const { hideByDefault, throughLauncher } = createRequire(import.meta.url)('./hide-windows.cjs') as {
  hideByDefault: (a: unknown[]) => unknown[];
  throughLauncher: (a: unknown[], runtime?: string, electron?: boolean) => [string, string[], Record<string, unknown>] | null;
};
const cb = () => {};
const H = { windowsHide: true };

test('windowsHide goes where the options belong, whatever the call looks like', () => {
  assert.deepEqual(hideByDefault(['ffmpeg']), ['ffmpeg', H]);
  assert.deepEqual(hideByDefault(['ffmpeg', ['-y']]), ['ffmpeg', ['-y'], H]);
  assert.deepEqual(hideByDefault(['ffmpeg', ['-y'], { cwd: 'x' }]), ['ffmpeg', ['-y'], { cwd: 'x', windowsHide: true }]);
  assert.deepEqual(hideByDefault(['ffmpeg', ['-y'], cb]), ['ffmpeg', ['-y'], H, cb]);
  assert.deepEqual(hideByDefault(['ffmpeg', ['-y'], undefined]), ['ffmpeg', ['-y'], H]);
  assert.deepEqual(hideByDefault(['ffmpeg', null, { cwd: 'x' }]), ['ffmpeg', null, { cwd: 'x', windowsHide: true }]);
  assert.deepEqual(hideByDefault(['ffmpeg', undefined, cb]), ['ffmpeg', undefined, H, cb]);
  assert.deepEqual(hideByDefault(['dir /b', cb]), ['dir /b', H, cb]);
  assert.deepEqual(hideByDefault(['dir /b', { shell: true }, cb]), ['dir /b', { shell: true, windowsHide: true }, cb]);
});

test('a call that asks for a window still gets one', () => {
  assert.deepEqual(hideByDefault(['chrome', ['about:blank'], { windowsHide: false }]), ['chrome', ['about:blank'], { windowsHide: false }]);
});

test('a detached, hidden program goes through the launcher; anything else starts as it is', () => {
  const env = { PATH: 'x' };
  const [runtime, args, opts] = throughLauncher(['python', ['job.py', 'scan'], { cwd: 'C:\\t', detached: true, windowsHide: true, stdio: ['ignore', 3, 3], env, shell: false }], 'C:\\app.exe', true)!;
  assert.equal(runtime, 'C:\\app.exe');
  assert.deepEqual(JSON.parse(args[2]), { file: 'python', args: ['job.py', 'scan'], shell: false, verbatim: false, runAsNode: null });
  assert.deepEqual(opts, { cwd: 'C:\\t', detached: true, windowsHide: true, stdio: ['ignore', 3, 3], env: { PATH: 'x', ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(throughLauncher(['python', ['a'], { windowsHide: true }]), null, 'not detached');
  assert.equal(throughLauncher(['chrome', [], { detached: true, windowsHide: false }]), null, 'asks for a window');
  assert.equal(throughLauncher(['node', ['x'], { detached: true, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }]), null, 'talks over ipc');
});

test('the launcher passes output and exit code through, and gives the program its own environment back', () => {
  const [runtime, args, opts] = throughLauncher(
    [process.execPath, ['-e', 'process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE)); process.exit(4)'], { detached: true, windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }],
    process.execPath,
    true,
  )!;
  delete (opts.env as Record<string, unknown>).ELECTRON_RUN_AS_NODE; // plain Node here, not Electron
  const r = spawnSync(runtime, args, { ...opts, detached: false, encoding: 'utf8' });
  assert.equal(r.stdout, 'undefined');
  assert.equal(r.status, 4);
});

test('preloaded, it leaves programs working: output, exit codes and promisified execFile', () => {
  const script = `
    const cp = require('node:child_process');
    const { promisify } = require('node:util');
    const a = cp.execFileSync(process.execPath, ['-e', 'process.stdout.write("one")']).toString();
    const b = cp.spawnSync(process.execPath, ['-e', 'process.exit(3)']).status;
    promisify(cp.execFile)(process.execPath, ['-e', 'process.stdout.write("two")']).then(r => console.log(JSON.stringify([a, b, r.stdout, cp.spawn.__hidesWindows === (process.platform === 'win32')])));
  `;
  const out = execFileSync(process.execPath, ['--require', HIDE_WINDOWS, '-e', script], { windowsHide: true }).toString().trim();
  assert.deepEqual(JSON.parse(out), ['one', 3, 'two', true]);
});
