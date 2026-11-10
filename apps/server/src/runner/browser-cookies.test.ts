import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedCookies } from './browser.js';

const cookie = (name: string, value: string) => ({ domain: 'site.com', path: '/', name, value });

test("only what the person's window changed goes back to the agents' browser", () => {
  const given = new Map([['site.com|/|session', 'old'], ['site.com|/|prefs', 'a']]);
  const now = [cookie('session', 'old'), cookie('prefs', 'b'), cookie('new-login', 'x')];
  // The untouched session stays out: the agents' browser may have renewed it since.
  assert.deepEqual(changedCookies(now, given).map(c => c.name), ['prefs', 'new-login']);
});

test('with no record of what the window was given, everything goes back', () => {
  const now = [cookie('session', 'old')];
  assert.deepEqual(changedCookies(now, undefined), now);
});

test("Google's own sign-in never goes to the agents' browser; other sites' do", async () => {
  const { googleCookie } = await import('./browser.js');
  for (const d of ['.google.com', 'accounts.google.com', '.youtube.com', '.google.com.au', 'lh3.googleusercontent.com']) assert.equal(googleCookie({ domain: d }), true, d);
  for (const d of ['.fazier.com', 'notgoogle.com', '.github.com', 'google.example.com']) assert.equal(googleCookie({ domain: d }), false, d);
});
