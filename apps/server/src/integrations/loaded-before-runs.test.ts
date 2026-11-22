import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Just after a start, the integrations are still loading. A run or an approved send then
// found every connected tool missing ("zohomail_send_mail no longer exists") and failed
// for good. Runs and approved actions wait for integrationsLoaded() first.
process.env.EAA_DATA_DIR = mkdtempSync(join(tmpdir(), 'eaa-loading-'));
const { resetDbForTests } = await import('../runner/db.js');
const { hasIntegration, integrationsLoaded, loadIntegrations } = await import('./index.js');
const { registeredToolIds } = await import('../runner/tools.js');
resetDbForTests();

test('waiting for integrationsLoaded() sees every integration and its tools, even when asked mid-load', async () => {
  const load = loadIntegrations();
  await integrationsLoaded();
  assert.ok(hasIntegration('brave-search'));
  assert.ok(registeredToolIds().has('web.web_search'));
  await load;
});

test('a load started while another is under way is waited for too', async () => {
  void loadIntegrations();
  void loadIntegrations();
  await integrationsLoaded();
  assert.ok(hasIntegration('github'));
  assert.ok(registeredToolIds().has('github.list_repos'));
});
