import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_DATA_DIR, normaliseDataDir } from './data-dir.js';

// EAA_DATA_DIR set from Git Bash on Windows arrives as a Windows path.

test('a normal path is left as it is, with nothing to say', () => {
  assert.deepEqual(normaliseDataDir('/data/agency'), { dir: '/data/agency' });
  assert.deepEqual(normaliseDataDir('  /srv/eaa  '), { dir: '/srv/eaa' });
});

test('nothing set gives the default', () => {
  assert.deepEqual(normaliseDataDir(undefined), { dir: DEFAULT_DATA_DIR });
  assert.deepEqual(normaliseDataDir(''), { dir: DEFAULT_DATA_DIR });
});

test('the Git Bash prefix is taken off', () => {
  for (const raw of ['C:/Program Files/Git/data/agency', 'c:\\Program Files\\Git\\data\\agency', 'D:/Program Files (x86)/Git/data/agency']) {
    const r = normaliseDataDir(raw);
    assert.equal(r.dir, '/data/agency', raw);
    assert.match(r.note ?? '', /Git Bash/);
  }
});

test('another Windows path is refused: the default is used', () => {
  for (const raw of ['C:/Users/me/agency', 'D:\\agency', 'C:', 'C:/Program Files/Git']) {
    const r = normaliseDataDir(raw);
    assert.equal(r.dir, DEFAULT_DATA_DIR, raw);
    assert.match(r.note ?? '', /not a folder on this host/);
  }
});

test('a folder that merely starts like the prefix is not touched', () => {
  assert.deepEqual(normaliseDataDir('/Program Files/Git/data'), { dir: '/Program Files/Git/data' });
});
