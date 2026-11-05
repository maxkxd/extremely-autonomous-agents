import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

// Its own file (its own process): nothing listens for failures until this test does,
// as when the app starts and a plugin fails to load before the Engineer is set up.
test("a connection failure from before the Agency Engineer listens is told to it when it starts listening, not dropped", async () => {
  const { resetDbForTests } = await import('../runner/db.js');
  const { connectIntegration, discardDraft, loadIntegrations, whenConnectFailed, writeDraftIntegration } = await import('./index.js');
  resetDbForTests();
  await loadIntegrations();
  const def = `kind: http\nid: zz-early\nname: Early\nwhat: x\nauth: { type: bearer }\nbase_url: https://api.zz-early.invalid\ntest: { tool: zz-early.list, args: {} }\ntools:\n  - { id: zz-early.list, tier: T0, description: x, input: { type: object }, request: { method: GET, path: /items } }\n`;
  await writeDraftIntegration(def, 'fleet', 1);
  await assert.rejects(connectIntegration('zz-early', 'k-123'));
  const told: string[] = [];
  whenConnectFailed((id, how) => void told.push(`${id} ${how}`));
  assert.deepEqual(told, ['zz-early connect']);
  await discardDraft('zz-early');
});
