import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Signing in with our own Google client (shared-clients.ts), against a
// throwaway data folder - never the real vault and its sign-ins.
process.env.EAA_DATA_DIR = mkdtempSync(join(tmpdir(), 'eaa-shared-'));
process.env.EAA_GOOGLE_CLIENT_ID = 'ours.apps.googleusercontent.com';
process.env.EAA_GOOGLE_CLIENT_SECRET = 'ours-secret';
const { resetDbForTests } = await import('../runner/db.js');
const { addIntegration, disconnectIntegration, listIntegrations, loadIntegrations, startIntegrationSignIn } = await import('./index.js');
const { clientParams, oauthSecret } = await import('./oauth.js');
resetDbForTests();
await loadIntegrations();

const clientIn = (url: string) => new URL(url).searchParams.get('client_id');

test('Gmail signs in with our client when the person has none: nothing to make, and its secret stays out of the vault', async () => {
  assert.equal((await listIntegrations()).find(i => i.id === 'gmail')?.signIn?.hasClient, true);
  assert.equal(clientIn((await startIntegrationSignIn('gmail', {})).url), 'ours.apps.googleusercontent.com');
  const saved = (await oauthSecret('gmail'))!;
  assert.equal(saved.shared, 'google');
  assert.equal(saved.clientSecret, undefined);
  assert.deepEqual(clientParams(saved), { client_id: 'ours.apps.googleusercontent.com', client_secret: 'ours-secret' });
  // A later build with another client: the old sign-in isn't sent our new secret.
  assert.deepEqual(clientParams({ ...saved, clientId: 'old.apps.googleusercontent.com' }), { client_id: 'old.apps.googleusercontent.com' });
});

test('Drive signs in with our client too, and each asks only for the scopes registered on it', async () => {
  const scopes = async (id: string) => new URL((await startIntegrationSignIn(id, {})).url).searchParams.get('scope')?.split(' ');
  assert.equal((await listIntegrations()).find(i => i.id === 'drive')?.signIn?.hasClient, true);
  assert.equal(clientIn((await startIntegrationSignIn('drive', {})).url), 'ours.apps.googleusercontent.com');
  assert.deepEqual(await scopes('drive'), ['https://www.googleapis.com/auth/drive']);
  assert.deepEqual(await scopes('gmail'), ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.settings.basic']);
  await disconnectIntegration('drive');
});

test('a Google connection someone wrote never gets our client, even once Gmail signed in with it', async () => {
  await addIntegration({
    kind: 'http',
    id: 'zz-calendar',
    name: 'Calendar',
    what: 'x',
    auth: { type: 'oauth2', shared: 'google', authorize_url: 'https://accounts.google.com/o/oauth2/v2/auth', token_url: 'https://oauth2.googleapis.com/token', scopes: ['https://www.googleapis.com/auth/calendar.events'] },
    base_url: 'https://www.googleapis.com/calendar/v3',
    test: { tool: 'zz-calendar.list', args: {} },
    tools: [{ id: 'zz-calendar.list', tier: 'T0', description: 'x', input: { type: 'object' }, request: { method: 'GET', path: '/events' } }],
  });
  assert.equal((await listIntegrations()).find(i => i.id === 'zz-calendar')?.signIn?.hasClient, false);
  await assert.rejects(startIntegrationSignIn('zz-calendar', {}), /Paste your OAuth client ID first/);
});

test('signing out of our client keeps nothing of it: the next sign-in uses whichever the app has then', async () => {
  await disconnectIntegration('gmail');
  assert.equal(await oauthSecret('gmail'), null);
  assert.equal(clientIn((await startIntegrationSignIn('gmail', {})).url), 'ours.apps.googleusercontent.com');
});

test('your own client replaces ours, and is kept through a sign-out as before', async () => {
  assert.equal(clientIn((await startIntegrationSignIn('gmail', { clientId: 'mine.apps.googleusercontent.com', clientSecret: 'mine' })).url), 'mine.apps.googleusercontent.com');
  const mine = (await oauthSecret('gmail'))!;
  assert.equal(mine.shared, undefined);
  assert.deepEqual(clientParams(mine), { client_id: 'mine.apps.googleusercontent.com', client_secret: 'mine' });
  await disconnectIntegration('gmail');
  assert.equal(clientIn((await startIntegrationSignIn('gmail', {})).url), 'mine.apps.googleusercontent.com');
});
