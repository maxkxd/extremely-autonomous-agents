import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { HIDE_WINDOWS } from './programs.js';

const { hideByDefault } = createRequire(import.meta.url)('./hide-windows.cjs') as { hideByDefault: (a: unknown[]) => unknown[] };
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
