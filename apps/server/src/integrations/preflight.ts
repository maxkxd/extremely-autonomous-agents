import { lookup } from 'node:dns/promises';
import { safeFetch } from '../runner/net.js';
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

// Whether an MCP server is at that address: its answer to "initialize" (a sign-in
// asked for is an answer too). "gone": not found there; unknown when it can't be reached.
export type Status = (url: string) => Promise<number>;
const initialize: Status = async url => {
  const { res } = await safeFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Extremely Autonomous Agents', version: '1.0.0' } } }),
    timeoutMs: 15_000,
  });
  await res.body?.cancel().catch(() => {});
  return res.status;
};
async function answers(url: string, status: Status): Promise<'yes' | 'gone' | 'unknown'> {
  try {
    return [404, 405, 410].includes(await status(url)) ? 'gone' : 'yes';
  } catch {
    return 'unknown';
  }
}

async function resolves(host: string): Promise<boolean> {
  try {
    await lookup(host);
    return true;
  } catch {
    return false;
  }
}

// net: how a host resolves and an address answers - the network, or a test's stand-ins.
export async function preflight(integration: Integration, net: { status?: Status; resolve?: (host: string) => Promise<boolean> } = {}): Promise<string | null> {
  const status = net.status ?? initialize;
  const resolve = net.resolve ?? resolves;
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
  if (!(await resolve(host))) return `${host} doesn't exist (no such address), so connecting can only fail. Check the service's docs for the right address.`;
  if (integration.kind !== 'mcp' || PLACEHOLDER.test(address)) return null;
  // Something must be there: a wrong path still finds the server's sign-in at its
  // root (Notion's at /wrong did), so the person signs in and every tool then fails.
  // An old .../sse address is fine when .../mcp beside it answers (the client moves there).
  const answer = await answers(address, status);
  if (answer === 'gone') {
    const moved = /\/sse\/?$/.test(new URL(address).pathname) ? address.replace(/\/sse\/?$/, '/mcp') : null;
    if (!moved || (await answers(moved, status)) === 'gone')
      return `Nothing answers at ${address} (not found) - the path is wrong. A remote MCP server's address is usually the one its docs give, often ending in /mcp.`;
  }
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
