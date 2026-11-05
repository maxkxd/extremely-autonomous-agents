import { lookup } from 'node:dns/promises';
import { resourceMetadata, serverMetadata } from './mcp-auth.js';
import type { Integration } from './schema.js';

// Before the Agency Engineer asks a person to connect something (ask_for_connection),
// the connection is checked as far as it can be without the person: the address is
// real, an MCP server answers and its sign-in can be found, and it isn't one account's
// own server copied from a web page (Zoho CRM's from Zoho's "connect to Claude" page:
// another account, another data centre - the person signed in and it failed).
// Returns what's wrong, for the Engineer to fix first, or null.

const PLACEHOLDER = /\{\{\w+\}\}/;

// One account's own server: an account number or a long code in its address.
export function accountCode(url: string): string | null {
  const u = new URL(url);
  const part = [...u.pathname.split('/'), ...u.hostname.split('.')[0].split('-')].find(
    p => /^[0-9a-f]{20,}$/i.test(p) || /^\d{9,}$/.test(p),
  );
  return part ?? null;
}

async function resolves(host: string): Promise<boolean> {
  try {
    await lookup(host);
    return true;
  } catch {
    return false;
  }
}

export async function preflight(integration: Integration): Promise<string | null> {
  if (integration.kind === 'code') return null;
  const address = integration.kind === 'http' ? integration.base_url : integration.url;
  // A server on this computer the person added, or one that runs as a command: nothing to check here.
  if (!address || (integration.kind === 'mcp' && integration.local)) return null;
  const host = new URL(address.replace(/\{\{\w+\}\}/g, 'x')).hostname;
  const hostTemplated = PLACEHOLDER.test(/^https?:\/\/([^/?#]+)/i.exec(address)?.[1] ?? '');
  if (integration.kind === 'mcp' && integration.auth.type !== 'fields') {
    const code = accountCode(address);
    if (code)
      return `${address.replace(code, '<code>')} has an account's own code in it, so it's one account's own server - not the person's, unless they gave you it themselves. Where every account makes its own server, the person copies their own address in: auth: { type: fields } with the address built from what they paste (as for Zoho Mail). If they did give you this address, keep it but make it a field they paste, so it's theirs.`;
  }
  if (hostTemplated) return null; // the host is part of what they paste (Zoho's server name)
  if (!(await resolves(host))) return `${host} doesn't exist (no such address), so connecting can only fail. Check the service's docs for the right address.`;
  if (integration.kind !== 'mcp' || PLACEHOLDER.test(address)) return null;
  if (integration.auth.type === 'mcp_oauth') {
    try {
      const rm = await resourceMetadata(address);
      const issuer = rm.authorization_servers?.[0];
      if (!issuer) return `${address} didn't say where to sign in, so the sign-in can't start.`;
      const as = await serverMetadata(issuer);
      if (!as.registration_endpoint) return `${integration.name}'s sign-in doesn't let apps register themselves, so this needs an OAuth client made by hand - not an mcp_oauth sign-in.`;
    } catch (e) {
      return `${address}: its sign-in can't be found (${(e as Error).message}).`;
    }
  }
  return null;
}
