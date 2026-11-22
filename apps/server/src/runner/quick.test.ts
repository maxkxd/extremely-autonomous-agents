import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fallbacks, QUICK_MS, withDeadline } from './quick.js';
import { ModelError } from './providers.js';

const keys = (cs: { connection: string; model: string }[]) => cs.map(c => `${c.connection}/${c.model}`);
const avail = [
  { connection: 'google', models: ['gemini-3-pro', 'gemini-3-flash'] },
  { connection: 'claude-code', models: ['opus', 'sonnet', 'haiku'] },
];

test('a helper whose only AI ran out of credit tries the other AIs that work', () => {
  const tried = [{ connection: 'google', model: 'gemini-3-pro' }];
  const out = keys(fallbacks(tried, avail, c => c.connection !== 'google', 'careful'));
  assert.ok(out.length > 0);
  assert.ok(out.every(k => k.startsWith('claude-code/')), out.join(', '));
});

test('fallbacks never repeat a model the helper already tried', () => {
  const tried = [{ connection: 'claude-code', model: 'opus' }];
  const out = keys(fallbacks(tried, avail, () => true, 'careful'));
  assert.ok(!out.includes('claude-code/opus'));
});

test('no other AI works: nothing to fall back to', () => {
  assert.deepEqual(fallbacks([], avail, () => false, 'cheap'), []);
});

test("a helper's call that never answers is cut off and its program told to stop, so pacing isn't held for hours", async () => {
  let aborted = false;
  const hung = withDeadline(30, 'claude-code/claude-haiku-5-5', signal => {
    signal.addEventListener('abort', () => (aborted = true));
    return new Promise<string>(() => {}); // Claude Code retrying offline: never settles
  });
  await assert.rejects(hung, (e: unknown) => e instanceof ModelError && e.kind === 'network' && /claude-code\/claude-haiku-5-5 gave no answer/.test(e.message));
  assert.equal(aborted, true);
  assert.equal(await withDeadline(1000, 'x', async () => 'paced'), 'paced');
  await assert.rejects(withDeadline(1000, 'x', async () => { throw new Error('ENOTFOUND'); }), /ENOTFOUND/);
  // It ends before a 'running' row nobody holds is swept as lost (10 minutes).
  assert.ok(QUICK_MS < 10 * 60_000);
});
