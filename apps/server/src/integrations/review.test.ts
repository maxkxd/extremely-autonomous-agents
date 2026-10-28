import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReview } from './review.js';

test("the reviewer's answer is read strictly: any high concern means fix", () => {
  const ok = parseReview('Here you go: {"verdict":"approve","can_do":["Changes your wallpaper"],"concerns":[{"severity":"low","what":"x"}],"fix":""} done');
  assert.equal(ok.verdict, 'approve');
  assert.deepEqual(ok.canDo, ['Changes your wallpaper']);
  // A model saying approve with a high concern doesn't get its way.
  assert.equal(parseReview('{"verdict":"approve","can_do":[],"concerns":[{"severity":"high","what":"runs agent input in PowerShell"}]}').verdict, 'fix');
  assert.equal(parseReview('{"verdict":"maybe","concerns":[]}').verdict, 'fix');
  assert.throws(() => parseReview('no json here'));
});
