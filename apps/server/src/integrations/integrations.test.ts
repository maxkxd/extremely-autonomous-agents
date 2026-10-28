import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { authParts, fill, shape } from './http.js';
import { Integration } from './schema.js';

test('placeholders keep types, take defaults, and drop missing optional inputs', () => {
  assert.deepEqual(fill({ q: '{{query}}', count: '{{count:10}}', depth: 'basic', missing: '{{nope}}' }, { query: 'cats' }), { q: 'cats', count: 10, depth: 'basic' });
  assert.deepEqual(fill({ count: '{{count:10}}' }, { count: 3 }), { count: 3 });
  assert.equal(fill('/repos/{{owner}}/{{repo}}', { owner: 'a', repo: 'b' }), '/repos/a/b');
  assert.equal(fill('/repos/{{owner}}', {}), undefined);
  assert.deepEqual(fill({ tags: '{{tags}}' }, { tags: ['x', 'y'] }), { tags: ['x', 'y'] });
  assert.deepEqual(fill({ contents: { text: { maxCharacters: 600 } } }, {}), { contents: { text: { maxCharacters: 600 } } });
});

test('answers are trimmed to the fields the definition keeps', () => {
  const answer = { web: { results: [{ title: 'A', url: 'https://a', description: 'about a', extra: 'x' }, { title: 'B', url: 'https://b', description: 'about\n b' }] } };
  const text = shape(answer, { items: 'web.results', fields: { title: 'title', url: 'url', snippet: 'description' } });
  assert.equal(text, '1. title: A\n   url: https://a\n   snippet: about a\n\n2. title: B\n   url: https://b\n   snippet: about b');
  assert.equal(shape({ web: { results: [] } }, { items: 'web.results' }), 'No results.');
  assert.equal(shape({ data: { n: 1 } }, { pick: 'data.n' }), '1');
});

test('the key goes where the service wants it', () => {
  assert.deepEqual(authParts({ type: 'api_key', header: 'X-Subscription-Token' }, 'k1'), { headers: { 'X-Subscription-Token': 'k1' }, query: {} });
  assert.deepEqual(authParts({ type: 'bearer' }, 'k2'), { headers: { authorization: 'Bearer k2' }, query: {} });
  assert.deepEqual(authParts({ type: 'api_key', query: 'api_key' }, 'k3'), { headers: {}, query: { api_key: 'k3' } });
  assert.deepEqual(authParts({ type: 'none' }, undefined), { headers: {}, query: {} });
  assert.throws(() => authParts({ type: 'bearer' }, undefined), /no key saved/);
});

test('every shipped integration is a valid definition', async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'integrations');
  const files = (await readdir(dir)).filter(f => f.endsWith('.yaml'));
  assert.ok(files.length >= 4);
  for (const f of files) {
    const def = Integration.parse(parse(await readFile(join(dir, f), 'utf8')));
    assert.equal(`${def.id}.yaml`, f);
  }
});

test('a definition that would break is rejected', () => {
  assert.throws(() => Integration.parse({ kind: 'http', id: 'Bad Id', name: 'x', what: 'x', auth: { type: 'none' }, base_url: 'https://a', test: { tool: 'a.b', args: {} }, tools: [] }));
});
