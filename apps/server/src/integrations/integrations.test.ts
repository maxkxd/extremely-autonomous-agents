import '../test-data-dir.js';
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
  // HTTP Basic from a login and password, encoded by the app (nobody base64s anything).
  const basic = { type: 'fields' as const, fields: [{ name: 'login', label: 'Login', secret: false }, { name: 'password', label: 'Password', secret: true }], basic: { username: '{{login}}', password: '{{password}}' } };
  assert.deepEqual(authParts(basic, JSON.stringify({ login: 'me', password: 'pw' })), { headers: { authorization: `Basic ${Buffer.from('me:pw').toString('base64')}` }, query: {} });
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

test('web search works with nothing connected: Tavily in its free keyless mode, which a connected key replaces', async () => {
  const { resetDbForTests } = await import('../runner/db.js');
  const { integrationToolIds, integrationToolsForPrompt, listIntegrations, loadIntegrations } = await import('./index.js');
  resetDbForTests();
  await loadIntegrations();
  assert.ok(integrationToolIds().includes('web.web_search'));
  assert.match(integrationToolsForPrompt(), /web\.web_search .*\(via Tavily, free with no key\)/);
  const tavily = (await listIntegrations()).find(i => i.id === 'tavily');
  assert.equal(tavily?.free, true);
  assert.equal(tavily?.connected, false);
  // Only the keyless one serves for free: the others still need their key.
  assert.equal((await listIntegrations()).find(i => i.id === 'brave-search')?.free, false);
});

test("a draft nobody will connect - its request closed, nothing connected - is marked unused, so Settings hides it", async () => {
  const { resetDbForTests, run } = await import('../runner/db.js');
  const { discardDraft, listIntegrations, loadIntegrations, writeDraftIntegration } = await import('./index.js');
  resetDbForTests();
  await loadIntegrations();
  const open = Number(run("INSERT INTO requests (agent_id, what, why, created_at, status) VALUES ('zz', 'Set up Zz', 'x', 0, 'open')").lastInsertRowid);
  const def = (id: string) => `kind: http\nid: ${id}\nname: ${id}\nwhat: x\nauth: { type: bearer }\nbase_url: https://api.example.com\ntest: { tool: ${id}.list, args: {} }\ntools:\n  - { id: ${id}.list, tier: T0, description: x, input: { type: object }, request: { method: GET, path: /items } }\n`;
  await writeDraftIntegration(def('zz-wanted'), 'fleet', open);
  await writeDraftIntegration(def('zz-stale'), 'fleet', open + 1000);
  const list = await listIntegrations();
  assert.equal(list.find(i => i.id === 'zz-wanted')?.unused, false);
  assert.equal(list.find(i => i.id === 'zz-stale')?.unused, true);
  assert.equal(list.find(i => i.id === 'tavily')?.unused, false);
  // Built for a request that has since closed, then asked for on a request of its
  // own (Pexels): that request waits on it, so it shows.
  await writeDraftIntegration(def('zz-asked-later'), 'fleet', open + 2000);
  run("INSERT INTO requests (agent_id, what, why, created_at, status, stage, waiting_on) VALUES ('zz', 'Connect it', 'x', 0, 'open', 'waiting_you', 'zz-asked-later')");
  assert.equal((await listIntegrations()).find(i => i.id === 'zz-asked-later')?.unused, false);
  await discardDraft('zz-wanted');
  await discardDraft('zz-stale');
  await discardDraft('zz-asked-later');
});

test("a Connect that fails goes to the Agency Engineer, and the row says it's on it until it works", async () => {
  const { resetDbForTests } = await import('../runner/db.js');
  const { connectIntegration, discardDraft, listIntegrations, loadIntegrations, whenConnectFailed, writeDraftIntegration } = await import('./index.js');
  resetDbForTests();
  await loadIntegrations();
  const told: string[] = [];
  whenConnectFailed((id, how, message) => void told.push(`${id} ${how} ${message}`));
  // An address that can't be reached (.invalid never resolves).
  const def = `kind: http\nid: zz-broken\nname: Broken\nwhat: x\nauth: { type: bearer }\nbase_url: https://api.zz-broken.invalid\ntest: { tool: zz-broken.list, args: {} }\ntools:\n  - { id: zz-broken.list, tier: T0, description: x, input: { type: object }, request: { method: GET, path: /items } }\n`;
  await writeDraftIntegration(def, 'fleet', 1);
  await assert.rejects(connectIntegration('zz-broken', 'k-123'));
  assert.equal(told.length, 1);
  assert.match(told[0], /^zz-broken connect /);
  assert.equal((await listIntegrations()).find(i => i.id === 'zz-broken')?.repairing, true);
  // Pasting nothing isn't a fault to fix: no one is told.
  await assert.rejects(connectIntegration('zz-broken', ''));
  assert.equal(told.length, 1);
  await discardDraft('zz-broken');
});

test("before a person is asked to connect: an account's own server from a web page, an address that doesn't exist, are caught", async () => {
  const { accountCode, preflight } = await import('./preflight.js');
  const mcp = (url: string, auth: object) => Integration.parse({ kind: 'mcp', id: 'zz-pre', name: 'Pre', what: 'x', auth, url });
  // Zoho CRM's from Zoho's "connect to Claude" page: someone else's server.
  const zohoPage = 'https://zoho-crm-data-operations-12345678901.zohomcp.in/mcp/0123456789abcdef0123456789abcdef/message';
  assert.ok(accountCode(zohoPage));
  assert.match((await preflight(mcp(zohoPage, { type: 'mcp_oauth' }))) ?? '', /one account's own server/);
  // The same kind of address built from what the person pastes is theirs: fine (nothing to look up).
  const fields = { type: 'fields', fields: [{ name: 'server', label: 'Server' }, { name: 'api_key', label: 'Key' }] };
  assert.equal(await preflight(mcp('https://{{server}}.zohomcp.com/mcp/{{api_key}}/message', fields)), null);
  // A shared server's address has no code in it.
  assert.equal(accountCode('https://mcp.notion.com/mcp'), null);
  assert.equal(accountCode('https://mcp.zapier.com/api/mcp/mcp'), null);
  // An address that doesn't exist.
  assert.match((await preflight(mcp('https://mcp.zz-nothing.invalid/mcp', { type: 'bearer' }))) ?? '', /doesn't exist/);
});

test('a failure reported to us is its kind only: no key, address, email or name gets through', async () => {
  const { errorKind } = await import('./report.js');
  assert.equal(errorKind('Gmail answered 400: Precondition check failed.'), '400 gmail answered precondition check failed');
  assert.equal(errorKind("Couldn't reach {{server}}.zohomcp.com: getaddrinfo ENOTFOUND {{server}}.zohomcp.com"), 'ENOTFOUND reach getaddrinfo');
  const leaky = errorKind('Zoho answered 401: user Max Smith (max@example.com) not found for key sk-abc123 abcdefghijklmnopqrstuvwx at https://x.example.com/a');
  for (const bit of ['max', 'smith', 'example', 'sk-', 'abcdefghijklmnop', 'https']) assert.ok(!leaky.includes(bit), `${bit} got through: ${leaky}`);
});

test("before a person is asked: an MCP address with nothing at it (a wrong path) is caught, an old /sse one with /mcp beside it isn't", async () => {
  const { preflight } = await import('./preflight.js');
  const mcp = (url: string) => Integration.parse({ kind: 'mcp', id: 'zz-pre', name: 'Pre', what: 'x', auth: { type: 'bearer' }, url });
  // A made-up service: /mcp answers (asks for a sign-in), anything else is not found.
  const net = { resolve: async () => true, status: async (url: string) => (url.endsWith('/mcp') ? 401 : 404) };
  assert.equal(await preflight(mcp('https://mcp.example.com/mcp'), net), null);
  assert.match((await preflight(mcp('https://mcp.example.com/wrong'), net)) ?? '', /Nothing answers at .*the path is wrong/);
  assert.equal(await preflight(mcp('https://mcp.example.com/sse'), net), null);
  // Can't be reached right now isn't proof it's wrong: not refused.
  assert.equal(await preflight(mcp('https://mcp.example.com/other'), { resolve: async () => true, status: async () => { throw new Error('timeout'); } }), null);
});

test("an MCP tool that only reads goes silent by its name however it's written; anything that writes waits for a person", async () => {
  const { readsByName } = await import('./index.js');
  for (const n of ['read_wiki_contents', 'notion-search', 'query-docs', 'domain_search', 'email_finder', 'emailFinder', 'whoami', 'retrieve_records', 'get_profile', 'list_issues'])
    assert.equal(readsByName(n), true, n);
  for (const n of ['create_issue', 'search_and_replace', 'send_email', 'update-page', 'delete_record', 'run_query', 'post_message', 'enrich', 'do_thing', 'checkout'])
    assert.equal(readsByName(n), false, n);
});

test("a Google sign-in with a permission unticked is caught at sign-in, by name; other services and full grants pass", async () => {
  const { missingGoogleScopes } = await import('./oauth.js');
  const google = { type: 'oauth2', authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth', token_url: 'https://oauth2.googleapis.com/token', scopes: ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.settings.basic'] } as never;
  assert.deepEqual(missingGoogleScopes(google, 'https://www.googleapis.com/auth/gmail.settings.basic'), ['gmail.modify']);
  assert.deepEqual(missingGoogleScopes(google, 'https://www.googleapis.com/auth/gmail.settings.basic https://www.googleapis.com/auth/gmail.modify openid'), []);
  assert.deepEqual(missingGoogleScopes(google, undefined), []);
  // An MCP server's own sign-in may grant less than everything it lists: not Google, not checked.
  const other = { type: 'oauth2', authorize_url: 'https://auth.example.com/a', token_url: 'https://auth.example.com/t', scopes: ['a', 'b'] } as never;
  assert.deepEqual(missingGoogleScopes(other, 'a'), []);
});

test("an address a person pastes themselves may carry their account's code; a wrong path is still caught", async () => {
  const { preflight } = await import('./preflight.js');
  const net = { resolve: async () => true, status: async (url: string) => (url.endsWith('/message') ? 401 : 404), own: true };
  const mine = Integration.parse({ kind: 'mcp', id: 'zz-own', name: 'Own', what: 'x', auth: { type: 'none' }, url: 'https://agency-1234567890.zohomcp.com/mcp/0123456789abcdef0123456789abcdef/message' });
  assert.equal(await preflight(mine, net), null);
  const wrong = Integration.parse({ kind: 'mcp', id: 'zz-own', name: 'Own', what: 'x', auth: { type: 'none' }, url: 'https://agency-1234567890.zohomcp.com/mcp/0123456789abcdef0123456789abcdef/wrong' });
  assert.match((await preflight(wrong, net)) ?? '', /Nothing answers/);
});

test('a sign-in renewed by several agents at once is renewed once, and they all get its token', async () => {
  const { once } = await import('./oauth.js');
  const going = new Map<string, Promise<string>>();
  let renewals = 0;
  const renew = async () => {
    renewals++;
    await new Promise(r => setTimeout(r, 20));
    return `token-${renewals}`;
  };
  const tokens = await Promise.all([1, 2, 3, 4, 5].map(() => once(going, 'zz-signin', renew)));
  assert.equal(renewals, 1);
  assert.deepEqual(new Set(tokens), new Set(['token-1']));
  // Finished: the next renewal is a new one.
  assert.equal(await once(going, 'zz-signin', renew), 'token-2');
  // A failed renewal isn't stuck: the next call tries again.
  await assert.rejects(once(going, 'zz-fail', async () => { throw new Error('nope'); }));
  assert.equal(await once(going, 'zz-fail', async () => 'ok'), 'ok');
});

test("a field in an MCP address's host: under a fixed domain it may be any name (a region with dots too); ending the host it needs a fixed list", async () => {
  const { filledUrl } = await import('./mcp-client.js');
  const { discardDraft, loadIntegrations, writeDraftIntegration } = await import('./index.js');
  const { resetDbForTests } = await import('../runner/db.js');
  resetDbForTests();
  await loadIntegrations();
  const server = 'https://{{server}}.mcp.example.com/mcp/{{key}}/message';
  assert.equal(filledUrl(server, 'https://agency-1.mcp.example.com/mcp/k/message').host, 'agency-1.mcp.example.com');
  const region = 'https://mcp.example.{{region}}/mcp';
  assert.equal(filledUrl(region, 'https://mcp.example.com.au/mcp').host, 'mcp.example.com.au');
  assert.throws(() => filledUrl(server, 'https://evil.com/x?.mcp.example.com/mcp/k/message'), /valid address/);
  const fields = (extra: object = {}) => ({ type: 'fields', fields: [{ name: 'server', label: 'Server', optional: true }, { name: 'key', label: 'Key', optional: true }, { name: 'region', label: 'Region', secret: false, optional: true, ...extra }] });
  const write = (id: string, auth: object, url: string) => writeDraftIntegration(JSON.stringify({ kind: 'mcp', id, name: id, what: 'x', auth, url }), 'fleet');
  // Under a fixed domain: fine as it is (the Engineer writes these).
  await write('zz-under', fields(), server);
  // Ending the host with no list of values: refused - "evil.com" would take the key there.
  await assert.rejects(write('zz-end', fields(), region), /give it options/);
  await write('zz-end', fields({ options: ['com', 'com.au', 'eu'] }), region);
  await discardDraft('zz-under');
  await discardDraft('zz-end');
});

test('every "Settings > ..." place the app tells people or agents about is a real section of Settings', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  // Settings' sections (apps/desktop/src/Settings.tsx SECTIONS).
  const sections = new Set(['Account', 'Organization', 'Usage', 'Connectors', 'Tools']);
  const src = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.isDirectory()) await walk(join(dir, e.name));
      else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) files.push(join(dir, e.name));
    }
  };
  await walk(src);
  const wrong: string[] = [];
  for (const f of files)
    for (const m of (await readFile(f, "utf8")).matchAll(/(-> )?Settings > ([A-Z][A-Za-z]+)/g)) if (!m[1] && !sections.has(m[2])) wrong.push(`${f.slice(src.length)}: Settings > ${m[2]}`);
  assert.deepEqual(wrong, []);
});

test("a sign-in stays open long enough for a person (30 minutes), and isn't reported as lost while it is", async () => {
  const { SIGN_IN_LIFE_MS } = await import('./oauth.js');
  const src = await readFile(join(dirname(fileURLToPath(import.meta.url)), 'index.ts'), 'utf8');
  assert.ok(SIGN_IN_LIFE_MS >= 30 * 60_000);
  // The "never came back" report waits for the sign-in itself to have lapsed.
  assert.match(src, /const SIGN_IN_WAIT_MS = SIGN_IN_LIFE_MS \+/);
});

test("an MCP sign-in's registration is reused only for the address it was made for", async () => {
  const { resetDbForTests } = await import('../runner/db.js');
  const { setSecret } = await import('../vault.js');
  const { addIntegration, loadIntegrations, removeIntegration, startIntegrationSignIn } = await import('./index.js');
  const { OAUTH_REDIRECT } = await import('./oauth.js');
  resetDbForTests();
  await loadIntegrations();
  const at = (url: string) => addIntegration({ kind: 'mcp', id: 'zz-reg', name: 'Reg', what: 'x', auth: { type: 'mcp_oauth' }, url });
  await at('https://mcp.zz-first.invalid/mcp');
  const discovered = { type: 'oauth2', authorize_url: 'https://auth.zz-first.invalid/authorize', token_url: 'https://auth.zz-first.invalid/token', scopes: ['all'] };
  await setSecret('integration:zz-reg', { clientId: 'client-1', discovered, registeredFor: `https://mcp.zz-first.invalid/mcp ${OAUTH_REDIRECT}` });
  // Same address: the saved registration (nothing to look up).
  assert.match((await startIntegrationSignIn('zz-reg', {})).url, /^https:\/\/auth\.zz-first\.invalid\/authorize\?/);
  // The address changed (another server): found and registered afresh - here it can't be reached, so it fails rather than using the old server's page.
  await removeIntegration('zz-reg');
  await at('https://mcp.zz-second.invalid/mcp');
  await setSecret('integration:zz-reg', { clientId: 'client-1', discovered, registeredFor: `https://mcp.zz-first.invalid/mcp ${OAUTH_REDIRECT}` });
  await assert.rejects(startIntegrationSignIn('zz-reg', {}));
  await removeIntegration('zz-reg');
});

test("a signed-in service refusing a token that looked current: renewed once and tried again; anything else isn't retried", async () => {
  const { withKey } = await import('./index.js');
  const signedIn = Integration.parse({ kind: 'mcp', id: 'zz-tok', name: 'Tok', what: 'x', auth: { type: 'mcp_oauth' }, url: 'https://mcp.example.com/mcp' });
  const keyed = Integration.parse({ kind: 'mcp', id: 'zz-key', name: 'Key', what: 'x', auth: { type: 'bearer' }, url: 'https://mcp.example.com/mcp' });
  const getKey = async (_id: string, _d: unknown, fresh?: boolean) => (fresh ? 'new-token' : 'old-token');
  const service = async (key: string | undefined) => {
    if (key !== 'new-token') throw new Error('Tok answered 401: invalid_token');
    return 'ok';
  };
  assert.equal(await withKey(signedIn, service, getKey), 'ok');
  // A pasted key isn't renewed: it fails as it is.
  await assert.rejects(withKey(keyed, service, getKey), /401/);
  // Any other failure isn't retried.
  let calls = 0;
  await assert.rejects(withKey(signedIn, async () => { calls++; throw new Error('Tok answered 500: down'); }, getKey), /500/);
  assert.equal(calls, 1);
  // Renewed and still refused: said, not retried again.
  calls = 0;
  await assert.rejects(withKey(signedIn, async () => { calls++; throw new Error('Tok answered 401: nope'); }, getKey), /401/);
  assert.equal(calls, 2);
});

test("a token step refusing what's saved is told apart from the service being down, however it says it (Zoho: 200 with an error)", async () => {
  const { tokenRefused } = await import('./index.js');
  assert.equal(tokenRefused(200, { error: 'invalid_code' }), true);
  assert.equal(tokenRefused(400, { error: 'invalid_grant' }), true);
  assert.equal(tokenRefused(401, null), true);
  assert.equal(tokenRefused(200, { access_token: 't' }), false);
  assert.equal(tokenRefused(503, null), false);
  assert.equal(tokenRefused(200, null), false);
});

test("the Engineer can't save a connection with a field that's never sent (the person would paste a key that goes nowhere)", async () => {
  const { discardDraft, loadIntegrations, writeDraftIntegration } = await import('./index.js');
  await loadIntegrations();
  const def = (headers: string) =>
    `kind: mcp\nid: zz-unused\nname: Unused\nwhat: x\nurl: https://mcp.example.com/mcp\nauth:\n  type: fields\n  fields: [{ name: account, label: Account, secret: false }, { name: api_key, label: Key }]\n${headers}`;
  await assert.rejects(writeDraftIntegration(def('  headers: { x-account: "{{account}}" }\n'), 'fleet'), /"api_key" isn't used anywhere/);
  await writeDraftIntegration(def('  headers: { x-account: "{{account}}", authorization: "Bearer {{api_key}}" }\n'), 'fleet');
  await discardDraft('zz-unused');
});

test("after an update, a connection that failed before failures went to the Engineer is told to it once", async () => {
  const { getSetting, resetDbForTests, setSetting } = await import('../runner/db.js');
  const { discardDraft, listIntegrations, loadIntegrations, reportUnflaggedFailures, whenConnectFailed, writeDraftIntegration } = await import('./index.js');
  resetDbForTests();
  await loadIntegrations();
  const def = `kind: http\nid: zz-old\nname: Old\nwhat: x\nauth: { type: bearer }\nbase_url: https://api.example.com\ntest: { tool: zz-old.list, args: {} }\ntools:\n  - { id: zz-old.list, tier: T0, description: x, input: { type: object }, request: { method: GET, path: /items } }\n`;
  await writeDraftIntegration(def, 'fleet', 1);
  // As an older version left it: failed, nobody told.
  setSetting('integrations', { ...getSetting<Record<string, object>>('integrations', {}), 'zz-old': { draft: true, by: 'fleet', request: 1, test: { ok: false, at: 1, message: 'Old failure' } } });
  const told: string[] = [];
  whenConnectFailed((id, how, message) => void told.push(`${id} ${how} ${message}`));
  reportUnflaggedFailures();
  reportUnflaggedFailures();
  assert.deepEqual(told.filter(t => t.startsWith('zz-old')), ['zz-old connect Old failure']);
  assert.equal((await listIntegrations()).find(i => i.id === 'zz-old')?.repairing, true);
  await discardDraft('zz-old');
});

test("the built-in signed-in modules' refused-token messages are ones the renew-and-retry recognises", async () => {
  const { REFUSED_TOKEN } = await import('./index.js');
  const here = dirname(fileURLToPath(import.meta.url));
  for (const mod of ['gmail', 'drive']) {
    const src = await readFile(join(here, 'modules', `${mod}.ts`), 'utf8');
    const said = /status === 401\) throw new Error\('([^']+)'\)/.exec(src)?.[1];
    assert.ok(said, `${mod}: no 401 message found`);
    assert.match(said!, REFUSED_TOKEN, `${mod}'s 401 message isn't recognised`);
  }
});

test("an MCP sign-in asks for the scopes the server lists, and for none (not a made-up openid) when it lists none", async () => {
  const { scopesToAsk } = await import('./mcp-auth.js');
  assert.deepEqual(scopesToAsk(['read', 'write'], ['other']), ['read', 'write']);
  assert.deepEqual(scopesToAsk(undefined, ['read']), ['read']);
  // The resource lists none (an empty list) but the sign-in server does: that one.
  assert.deepEqual(scopesToAsk([], ['mcp']), ['mcp']);
  assert.deepEqual(scopesToAsk(undefined, undefined), []);
});

test('a token answer with no token in it is a failed sign-in, not a saved blank one', async () => {
  const { tokenAnswer } = await import('./oauth.js');
  assert.equal(tokenAnswer(200, { access_token: 'tok-1', expires_in: 3600 }).access_token, 'tok-1');
  // Zoho: 200 with an error for a revoked refresh token or a used code.
  assert.throws(() => tokenAnswer(200, { error: 'invalid_code' }), /expired or was revoked/);
  assert.throws(() => tokenAnswer(200, {}), /no token came back/);
  assert.throws(() => tokenAnswer(200, 'not json'), /no token came back/);
  assert.throws(() => tokenAnswer(400, { error: 'invalid_grant' }), /expired or was revoked/);
  assert.throws(() => tokenAnswer(500, {}), /Sign-in failed: 500/);
});

test('a permission left unticked on Google\'s page is named the way people know it', async () => {
  const { plainScope } = await import('./oauth.js');
  assert.equal(plainScope('gmail.modify'), 'reading, organising and sending your email');
  assert.equal(plainScope('youtube.force-ssl'), 'your YouTube account');
  assert.equal(plainScope('something.new'), 'something.new');
});

test("a field's hint is one short line (it's inside the box and cut off past that); steps go above the fields", async () => {
  const { discardDraft, loadIntegrations, writeDraftIntegration } = await import('./index.js');
  await loadIntegrations();
  const def = (help: string) =>
    `kind: mcp\nid: zz-hint\nname: Hint\nwhat: x\nkey_help: Make a server in the console, then copy its address.\nurl: https://mcp.example.com/{{server}}\nauth:\n  type: fields\n  fields: [{ name: server, label: Server, secret: false, help: "${help}" }]\n  headers: { x: "{{server}}" }\n`;
  await assert.rejects(
    writeDraftIntegration(def('In the console, open your server > Connect. The MCP URL looks like https://mcp.example.com/abc'), 'fleet'),
    /hint inside the box.*key_help/,
  );
  await writeDraftIntegration(def('Looks like abc123'), 'fleet');
  await discardDraft('zz-hint');
});
