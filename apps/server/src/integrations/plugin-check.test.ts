import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPlugin, writePlugin } from './plugins.js';

// A plugin whose tools would fail going live is caught when it's proposed, not
// after the person approves it (a "clips" plugin named its tools "grab_clip").
const tool = (id: string) => `{ id: '${id}', tier: 'T0', description: 'x', input: { type: 'object' }, run: async () => 'ok' }`;
const perms = { read: [], write: [], commands: false };

test("a plugin's tool ids are checked before its go-live card, with the fix named", async () => {
  await writePlugin('zz-clips', `export default { tools: [${tool('zz-clips.grab_clip')}, ${tool('grab_clip')}] };`);
  await assert.rejects(checkPlugin('zz-clips', perms), /bad id \("grab_clip"\).*e\.g\. "zz-clips\.grab_clip"/);
  await writePlugin('zz-clips', `export default { tools: [${tool('zz-clips.grab_clip')}, ${tool('zz-clips.check_setup')}] };`);
  await checkPlugin('zz-clips', perms);
});
