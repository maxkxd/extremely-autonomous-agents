import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scrubSecrets } from './secrets.js';

test('a key pasted into a chat is taken out; ordinary text and ids stay', () => {
  const cases = [
    'here is the key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx12345',
    'stripe: sk_live_51HxYzAbCdEfGhIjKlMn',
    'token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    'my password: hunter2-correct',
    'api_key=abc123def456ghi',
    'zoho 1000.0123456789abcdef0123456789abcdef.0123456789abcdef0123456789abcdef',
  ];
  for (const c of cases) {
    const r = scrubSecrets(c);
    assert.equal(r.removed, true, c);
    assert.match(r.text, /key taken out - it wasn't saved or sent anywhere; keys go in Settings > Connectors/);
  }
  for (const ok of [
    'Use the repo maxkxd/AssetRegister and request #41.',
    'The lead is 118131000001133015 in Zoho.',
    'Ask-anything tasks for the sk team',
    'Our API key goes in Settings, right?',
    'https://github.com/maxkxd/AssetRegister/pull/1463',
  ])
    assert.equal(scrubSecrets(ok).removed, false, ok);
});
