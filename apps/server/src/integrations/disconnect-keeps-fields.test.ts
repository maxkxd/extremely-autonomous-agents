import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Disconnecting a fields sign-in, against a throwaway data folder.
process.env.EAA_DATA_DIR = mkdtempSync(join(tmpdir(), 'eaa-disconnect-'));
const { resetDbForTests } = await import('../runner/db.js');
const { addIntegration, connectIntegration, disconnectIntegration, listIntegrations, loadIntegrations } = await import('./index.js');
const { getSecret, setSecret } = await import('../vault.js');
resetDbForTests();
await loadIntegrations();

test('Disconnect keeps the server name and region, drops the key, and reconnecting asks only for the key', async () => {
  await addIntegration(`kind: http
id: regional-crm
name: Regional CRM
what: A made-up CRM with a region and a key
auth:
  type: fields
  fields:
    - { name: region, label: Region, secret: false, options: [eu, us] }
    - { name: server, label: Server name, secret: false }
    - { name: key, label: API key }
  headers: { authorization: "Bearer {{key}}", x-server: "{{server}}" }
base_url: https://api.{{region}}.crm.invalid
test: { tool: crm.ping, args: {} }
tools:
  - id: crm.ping
    tier: T0
    description: Ping
    input: { type: object, properties: {} }
    request: { path: /ping }
`);
  await setSecret('integration:regional-crm', { fields: { region: 'eu', server: 'acme-test', key: 'made-up-key' } });

  await disconnectIntegration('regional-crm');

  assert.deepEqual(await getSecret('integration:regional-crm'), { fields: { region: 'eu', server: 'acme-test' } });
  const fields = (await listIntegrations()).find(i => i.id === 'regional-crm')!.fields!;
  assert.deepEqual(fields.map(f => [f.name, f.value, f.saved]), [['region', 'eu', true], ['server', 'acme-test', true], ['key', null, false]]);
  await assert.rejects(connectIntegration('regional-crm'), /Fill in API key/);
});
