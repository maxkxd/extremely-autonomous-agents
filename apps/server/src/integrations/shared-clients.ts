import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Sign-ins we registered once, for everyone (docs/shared-sign-ins.md): our own
// OAuth client per provider, so the person only signs in and approves. Put in at
// build time from the release environment - shared-clients.json beside
// package.json, written by apps/electron/scripts/stage.cjs - or, in development,
// the environment (apps/server/.env). Never in git. A desktop client's secret
// isn't secret (Google treats desktop apps as public clients; PKCE protects the
// sign-in), which is why it can ship in the app at all.
//
// Only built-in definitions use one: our client is verified for the scopes we
// registered with Google, and a definition someone wrote could ask for others.

export type SharedProvider = 'google';
export type SharedClient = { clientId: string; clientSecret?: string };

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared-clients.json');
const ENV: Record<SharedProvider, { id: string; secret: string }> = {
  google: { id: 'EAA_GOOGLE_CLIENT_ID', secret: 'EAA_GOOGLE_CLIENT_SECRET' },
};

let built: Partial<Record<SharedProvider, SharedClient>> | null = null;
const fromBuild = () => {
  try {
    built ??= JSON.parse(readFileSync(FILE, 'utf8')) as Partial<Record<SharedProvider, SharedClient>>;
  } catch {
    built = {};
  }
  return built;
};

// Our client for that provider, or none in a build that wasn't given one.
export function sharedClient(provider: SharedProvider): SharedClient | undefined {
  const env = ENV[provider];
  const clientId = process.env[env.id]?.trim();
  if (clientId) return { clientId, clientSecret: process.env[env.secret]?.trim() || undefined };
  const b = fromBuild()[provider];
  return b?.clientId ? b : undefined;
}
