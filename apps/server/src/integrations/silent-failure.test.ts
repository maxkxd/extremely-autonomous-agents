import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { silentFailure } from './index.js';

test('a tool that reports success but plainly failed is caught, whatever the tool', () => {
  assert.match(silentFailure('downloaded\nTraceback (most recent call last):\n  File "x.py", line 3', 'T1') ?? '', /Python crash/);
  assert.match(silentFailure('...\nRESULT: FAILED - no contact sheets', 'T1') ?? '', /own check failed/);
  assert.match(silentFailure("'npx' is not recognized as an internal or external command,", 'T1') ?? '', /wouldn't start/);
  assert.match(silentFailure('Error [ERR_ACCESS_DENIED]: Access to this API has been restricted', 'T0') ?? '', /sandbox refused/);
  assert.match(silentFailure('   ', 'T1') ?? '', /returned nothing/);
});

test("ordinary results aren't mistaken for failures", () => {
  assert.equal(silentFailure('', 'T0'), null); // a read can be empty (an empty file, no matches)
  assert.equal(silentFailure('Saved clips/a.mp4. 3 errors were fixed in the doc.', 'T1'), null);
  assert.equal(silentFailure('RESULT: PASS - winners/x has the film, cuts, sheets and facts', 'T1'), null);
  assert.equal(silentFailure('The page says: "Traceback" is a word on this blog.', 'T0'), null);
});
