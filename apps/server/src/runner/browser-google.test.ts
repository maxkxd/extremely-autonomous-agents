import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { profileArg } from './browser.js';

test("a profile's browser processes are found by their folder, quoted or not, and not a longer folder's", () => {
  const dir = String.raw`C:\Users\sam\AppData\Roaming\App\browser-profiles\1`;
  const want = profileArg(dir);
  assert.ok(want.test(String.raw`"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" "--user-data-dir=${dir}" --remote-debugging-port=0`), 'the browser itself');
  assert.ok(want.test(`msedge.exe --type=renderer --user-data-dir="${dir}" --lang=en-US`), 'its renderers');
  assert.ok(want.test(`msedge.exe --user-data-dir=${dir}`), 'last on the line');
  assert.ok(!want.test(`msedge.exe --user-data-dir="${dir}0" --type=gpu-process`), 'profile 10 is not profile 1');
  assert.ok(!want.test(String.raw`msedge.exe --user-data-dir="C:\Users\sam\AppData\Local\Microsoft\Edge\User Data"`), "the person's own Edge");
  assert.ok(profileArg('/data/agency/browser-profiles/2').test('/opt/google/chrome/chrome --user-data-dir=/data/agency/browser-profiles/2 --no-first-run'), 'Linux');
});
