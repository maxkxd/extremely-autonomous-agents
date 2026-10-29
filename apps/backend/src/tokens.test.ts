import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalJWKSet, exportPKCS8, generateKeyPair, jwtVerify } from 'jose';
import { createAuth } from './tokens.js';

test('a key from npm run keygen (one line, \\n escaped) signs tokens with a stable key id', async () => {
  const { privateKey } = await generateKeyPair('EdDSA', { extractable: true });
  const oneLine = (await exportPKCS8(privateKey)).trim().replace(/\n/g, '\\n');
  const a = await createAuth({ privateKeyPem: oneLine, issuer: 'http://b.test' });
  const b = await createAuth({ privateKeyPem: oneLine, issuer: 'http://b.test' });
  assert.equal((await a.jwks()).keys[0].kid, (await b.jwks()).keys[0].kid, 'restarting keeps the same key');
  const { token } = await a.orgToken({ sub: 'u', org: 'o', role: 'member', name: 'U', kind: 'team' });
  await jwtVerify(token, createLocalJWKSet(await b.jwks()), { issuer: 'http://b.test', audience: 'eaa-host' });
});

test('production refuses to start without a signing key', async () => {
  const was = process.env.NODE_ENV;
  const key = process.env.ORG_TOKEN_PRIVATE_KEY;
  process.env.NODE_ENV = 'production';
  delete process.env.ORG_TOKEN_PRIVATE_KEY;
  try {
    await assert.rejects(createAuth(), /ORG_TOKEN_PRIVATE_KEY/);
  } finally {
    process.env.NODE_ENV = was;
    if (key !== undefined) process.env.ORG_TOKEN_PRIVATE_KEY = key;
  }
});
