import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentBranch, github, repoOf } from './modules/github.js';
import type { Kit } from './modules/types.js';

const NO_KIT: Kit = { fetch: async () => { throw new Error('no network in tests'); } };

test('repositories are owner/name, from a URL too', () => {
  assert.equal(repoOf('maxkxd/eaa'), 'maxkxd/eaa');
  assert.equal(repoOf('https://github.com/maxkxd/eaa.git'), 'maxkxd/eaa');
  assert.throws(() => repoOf('eaa'), /owner\/name/);
  assert.throws(() => repoOf('a/b/../c'), /owner\/name/);
});

test('agents only ever write to their own agent/ branches', () => {
  assert.equal(agentBranch('fix-login'), 'agent/fix-login');
  assert.equal(agentBranch('agent/fix-login'), 'agent/fix-login');
  assert.equal(agentBranch('main'), 'agent/main');
  assert.equal(agentBranch('refs/heads/main'), 'agent/main');
  assert.throws(() => agentBranch('x/../../main'), /usable branch/);
  assert.throws(() => agentBranch(''), /Missing branch/);
});

test('reviews never approve, and nothing calls GitHub without a token', async () => {
  const tool = (id: string) => github.tools.find(t => t.id === id)!;
  await assert.rejects(tool('github.create_review').run({ repo: 'a/b', number: 1, verdict: 'approve', body: 'lgtm' }, 'tok', NO_KIT), /for people/);
  await assert.rejects(tool('github.list_repos').run({}, undefined, NO_KIT), /not connected/);
  assert.equal(tool('github.merge_pull_request').tier, 'T2');
  assert.ok(github.tools.filter(t => t.tier === 'T0').every(t => /^github\.(list|get|read)_/.test(t.id)));
});
