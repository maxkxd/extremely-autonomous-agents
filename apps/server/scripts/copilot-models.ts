// Debug: what the connected Copilot account can use, and one tiny test prompt.
//   npx tsx scripts/copilot-models.ts [--prompt]
import { approveAll, CopilotClient } from '@github/copilot-sdk';
import { getSecret } from '../src/vault.js';

const secret = await getSecret<{ token: string }>('copilot');
if (!secret) throw new Error('Copilot is not connected.');
const client = new CopilotClient({ gitHubToken: secret.token, useLoggedInUser: false, logLevel: 'error' });
await client.start();
console.log('auth:', JSON.stringify(await client.getAuthStatus()));
const models = await client.listModels();
console.log(`${models.length} models`);
for (const m of models) console.log(`- ${m.id} (${m.name})`);
if (process.argv.includes('--prompt')) {
  try {
    const session = await client.createSession({ onPermissionRequest: approveAll });
    const reply = await session.sendAndWait('Reply with the single word: ok', 60_000);
    console.log('reply:', JSON.stringify(reply?.data?.content ?? reply));
  } catch (e) {
    console.log('prompt failed:', (e as Error).message);
  }
}
await client.stop();
process.exit(0);
