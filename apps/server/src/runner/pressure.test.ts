import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BRAKE_AT, CLEAN_AT, holdsBack, inactiveFile, makeBrake, memoryFraction } from './pressure.js';

// memory.current counts the file cache, so it sat near 98% with nothing wrong: what
// counts is memory.current less the inactive file cache.

const files = (o: Record<string, string>) => async (f: string) => {
  if (f in o) return o[f];
  throw new Error(`no ${f}`);
};

test('the inactive file cache is read from memory.stat', () => {
  assert.equal(inactiveFile('anon 100\nfile 900\ninactive_file 400\nactive_file 500\n'), 400);
  assert.equal(inactiveFile('anon 100\n'), 0);
});

test('memory in use is memory.current less the inactive file cache, over memory.max', async () => {
  const read = files({ 'memory.current': '9000\n', 'memory.max': '10000\n', 'memory.stat': 'anon 1\ninactive_file 4000\n' });
  assert.equal(await memoryFraction(read), 0.5);
  // No memory.stat: the whole of memory.current.
  assert.equal(await memoryFraction(files({ 'memory.current': '9000', 'memory.max': '10000' })), 0.9);
});

test('no limit, or no cgroup: nothing to measure against', async () => {
  assert.equal(await memoryFraction(files({ 'memory.current': '9000', 'memory.max': 'max\n' })), null);
  assert.equal(await memoryFraction(files({})), null);
  assert.equal(await memoryFraction(files({ 'memory.current': '', 'memory.max': '10000' })), null);
});

test('the thresholds: clear browsers at 85%, hold new runs at 90%', () => {
  assert.equal(CLEAN_AT, 0.85);
  assert.equal(BRAKE_AT, 0.9);
});

test('the brake turns on at 90% and off below it, and says so once each way', () => {
  const said: string[] = [];
  const brake = makeBrake(l => said.push(l));
  assert.equal(brake.update(0.5), false);
  assert.equal(brake.update(0.89), false);
  assert.deepEqual(said, []);
  assert.equal(brake.update(0.9), true);
  assert.equal(brake.update(0.97), true);
  assert.equal(said.length, 1);
  assert.match(said[0], /Memory is at 90%.*no new run starts/);
  assert.equal(brake.update(0.88), false);
  assert.equal(brake.update(0.2), false);
  assert.equal(said.length, 2);
  assert.match(said[1], /Memory is down to 88%.*start again/);
  // Memory unreadable while it was on: off.
  brake.update(0.95);
  assert.equal(brake.update(null), false);
  assert.match(said.at(-1)!, /can no longer be read/);
});

test('a run waits for the brake only while others are going', () => {
  assert.equal(holdsBack(true, 3), true);
  assert.equal(holdsBack(true, 0), false);
  assert.equal(holdsBack(false, 3), false);
});
