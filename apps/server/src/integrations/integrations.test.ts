import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { authParts, baseFor, callHttp, fill, plainText, redact, shape } from './http.js';
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

test('snippet markup and entities become plain text', () => {
  assert.equal(plainText('The <strong>best</strong> caf&eacute; &amp; bar&#39;s &#x2014; ok'), "The best caf&eacute; & bar's — ok");
  assert.equal(shape({ r: [{ s: 'a <b>bold</b>\n move' }] }, { items: 'r', fields: { snippet: 's' } }), '1. snippet: a bold move');
});

test('a required input left out is refused before anything is sent', async () => {
  const integration = Integration.parse({ kind: 'http', id: 't', name: 'T', what: 'x', auth: { type: 'none' }, base_url: 'https://example.com', test: { tool: 'web.web_search', args: { query: 'x' } }, tools: [{ id: 'web.web_search', tier: 'T0', description: 'd', input: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, request: { method: 'GET', path: '/s' } }] });
  if (integration.kind !== 'http') throw new Error('kind');
  for (const args of [{}, { query: '' }, { query: '   ' }]) await assert.rejects(callHttp(integration, integration.tools[0], args, undefined), /Missing query/);
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

test("a fields sign-in: whatever the service takes, put where it wants it, and never echoed back", () => {
  const zoho = Integration.parse(
    parse(`kind: http
id: zoho-crm
name: Zoho CRM
what: CRM
auth:
  type: fields
  fields:
    - { name: client_id, label: Client ID, secret: false }
    - { name: client_secret, label: Client secret }
    - { name: refresh_token, label: Refresh token }
    - { name: region, label: Data center, secret: false, default: com }
  token:
    url: https://accounts.zoho.{{region}}/oauth/v2/token
    form: { grant_type: refresh_token, client_id: "{{client_id}}", client_secret: "{{client_secret}}", refresh_token: "{{refresh_token}}" }
    expires_in: expires_in
  headers: { authorization: "Zoho-oauthtoken {{token}}" }
base_url: https://www.zohoapis.{{region}}
test: { tool: crm.search_records, args: {} }
tools:
  - id: crm.search_records
    tier: T0
    description: Search
    input: { type: object, properties: {} }
    request: { path: /crm/v8/Leads }
`),
  );
  assert.equal(zoho.auth.type, 'fields');
  const key = JSON.stringify({ client_id: '1000.ABC', client_secret: 'shh-secret-value', refresh_token: '1000.refresh-xyz', region: 'com.au', token: 'tok-123456' });
  assert.deepEqual(authParts(zoho.auth, key), { headers: { authorization: 'Zoho-oauthtoken tok-123456' }, query: {} });
  assert.equal(baseFor(zoho.kind === 'http' ? zoho.base_url : '', zoho.auth, key), 'https://www.zohoapis.com.au');
  assert.equal(redact('bad token tok-123456 for shh-secret-value', zoho.auth, key), 'bad token [key] for [key]');
  assert.throws(() => authParts(zoho.auth, undefined), /no key saved/);
});
