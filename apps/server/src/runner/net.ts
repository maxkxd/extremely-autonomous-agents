import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch, type Response } from 'undici';

// Fetching for agents (docs/integrations.md). An agent can ask for any web
// address, so it must never reach this machine or its network: not this app's
// own server (its connection keys), not Ollama, not the router. Every
// connection is checked against the address it actually connects to - after
// DNS - so a public name that resolves to a private address is refused too.

export class BlockedAddress extends Error {}

// Private, local, link-local, carrier-grade NAT and other non-public ranges.
export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  const mapped = v6.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIp(mapped[1]);
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v6);
}

const BLOCKED_HOSTS = /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i;

// A web address an agent may use: http(s) on a public host.
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedAddress(`"${raw}" isn't a web address.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedAddress('Only http and https addresses can be used.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTS.test(host) || (isIP(host) && isPrivateIp(host)))
    throw new BlockedAddress(`${url.hostname} is on this computer or its local network, which agents can't reach.`);
  return url;
}

// DNS that refuses private answers, so the check holds at connect time.
function guardedLookup(hostname: string, options: object, callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    const bad = list.find(a => isPrivateIp(a.address));
    if (bad) return callback(new BlockedAddress(`${hostname} points to a private address (${bad.address}), which agents can't reach.`), []);
    const all = (options as { all?: boolean }).all;
    if (all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

const agent = new Agent({ connect: { lookup: guardedLookup as never }, headersTimeout: 30_000, bodyTimeout: 60_000 });

export type SafeFetchInit = { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; maxRedirects?: number };

// fetch() for agent-supplied addresses: public hosts only, every redirect
// checked again, nothing sent to a private address.
export async function safeFetch(raw: string, init: SafeFetchInit = {}): Promise<{ res: Response; url: string }> {
  let url = checkUrl(raw).toString();
  for (let hop = 0; hop <= (init.maxRedirects ?? 5); hop++) {
    let res: Response;
    try {
      res = await undiciFetch(url, {
        method: init.method ?? 'GET',
        headers: init.headers,
        body: init.body,
        redirect: 'manual',
        dispatcher: agent,
        signal: AbortSignal.timeout(init.timeoutMs ?? 30_000),
      });
    } catch (e) {
      const cause = (e as { cause?: unknown }).cause;
      if (cause instanceof BlockedAddress) throw cause;
      throw new Error(`Couldn't reach ${new URL(url).host}: ${(cause as Error)?.message ?? (e as Error).message}`);
    }
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = checkUrl(new URL(location, url).toString()).toString();
      continue;
    }
    return { res, url };
  }
  throw new Error('Too many redirects.');
}
