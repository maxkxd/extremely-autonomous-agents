import { HOSTED_ORG, type Hosting } from './hosting.js';
import { startRelay } from './relay.js';
import { getSecret } from './vault.js';

// An organization's agency in the cloud (docs/hosting-in-the-cloud.md): the same
// server in a container, registered as the organization's host. Nobody's own
// agency runs beside it to keep its relay connection, so it keeps it itself -
// with the host's key pair and secret, moved into its own vault when the
// organization moved in (scripts/move-org.ts). Members' apps reach it through
// the relay exactly as they reach an organization hosted on someone's computer.

export const CLOUD_HOST = !!process.env.EAA_CLOUD_HOST && !!HOSTED_ORG;

export async function startCloudHost() {
  if (!CLOUD_HOST || !HOSTED_ORG) return;
  const issuer = process.env.EAA_TOKEN_ISSUER ?? '';
  if (!/^https:\/\//.test(issuer)) return void console.error('[cloud] EAA_TOKEN_ISSUER is our backend’s https address: not set, so members can’t reach this agency.');
  const secret = await getSecret<string>(`hosting:${HOSTED_ORG}:secret`);
  if (!secret) return void console.error('[cloud] No host secret in the vault: move the organization in first (scripts/move-org.ts).');
  // What it asks our backend about members with (agency MCP addresses).
  process.env.EAA_HOST_SECRET ||= secret;
  const h: Hosting = { orgId: HOSTED_ORG, orgName: process.env.EAA_ORG_NAME || HOSTED_ORG, issuer };
  await startRelay(h);
}
