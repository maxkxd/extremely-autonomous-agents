import { safeFetch } from '../runner/net.js';
import type { AuthDef, HttpIntegration, HttpToolDef, RequestDef } from './schema.js';

// Calling an HTTP integration's tool (docs/integrations.md): fill the request
// from the agent's inputs, add the key the way the service wants it, send it
// through the safe fetcher, and keep only what the definition says.

const MAX_CHARS = 20_000;

// "{{query}}" -> the input's value, keeping its type when it's the whole
// string; "{{count:10}}" -> a default. A missing input with no default makes
// the whole value undefined, so optional fields are simply left out.
export function fill(template: unknown, args: Record<string, unknown>): unknown {
  if (typeof template === 'string') {
    const whole = template.match(/^\{\{(\w+)(?::([^}]*))?\}\}$/);
    if (whole) {
      const v = args[whole[1]];
      if (v !== undefined && v !== null && v !== '') return v;
      if (whole[2] === undefined) return undefined;
      const n = Number(whole[2]);
      return whole[2] !== '' && Number.isFinite(n) ? n : whole[2];
    }
    let missing = false;
    const out = template.replace(/\{\{(\w+)(?::([^}]*))?\}\}/g, (_m, name: string, def?: string) => {
      const v = args[name];
      if (v !== undefined && v !== null && v !== '') return String(v);
      if (def !== undefined) return def;
      missing = true;
      return '';
    });
    return missing ? undefined : out;
  }
  if (Array.isArray(template)) return template.map(t => fill(t, args)).filter(v => v !== undefined);
  if (template && typeof template === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template)) {
      const f = fill(v, args);
      if (f !== undefined) out[k] = f;
    }
    return out;
  }
  return template;
}

export function at(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), obj);
}

// Services put highlighting markup in snippets (<strong>, &amp;); agents get plain text.
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–' };
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
  );
export const plainText = (s: string) =>
  decodeEntities(s.replace(/<\/?[a-z][^>]*>/gi, ''))
    .replace(/\s+/g, ' ')
    .trim();

// A service's error, as its own message rather than the whole JSON body.
export function errorText(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    for (const p of ['error.detail', 'error.message', 'detail', 'message', 'error_description', 'error'])
      if (typeof at(j, p) === 'string' && at(j, p)) return at(j, p) as string;
  } catch {
    // not JSON
  }
  return text.replace(/\s+/g, ' ').slice(0, 300);
}

// The answer, trimmed to what the agent needs, as readable text.
export function shape(answer: unknown, def: HttpToolDef['response']): string {
  let out: unknown = answer;
  if (def?.items) {
    const list = at(answer, def.items);
    const items = Array.isArray(list) ? list.slice(0, def.max_items ?? 20) : [];
    if (!items.length) return 'No results.';
    out = items.map(item =>
      def.fields ? Object.fromEntries(Object.entries(def.fields).map(([name, path]) => [name, at(item, path)]).filter(([, v]) => v !== undefined && v !== '')) : item,
    );
    // Results as numbered blocks of "name: value" lines.
    return (out as Record<string, unknown>[])
      .map((r, i) => `${i + 1}. ${Object.entries(r).map(([k, v]) => `${k}: ${typeof v === 'string' ? plainText(v) : JSON.stringify(v)}`).join('\n   ')}`)
      .join('\n\n')
      .slice(0, MAX_CHARS);
  }
  if (def?.pick) out = at(answer, def.pick);
  const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[cut off]` : text;
}

// A fields sign-in's "key" is its fields (and the token they got) as JSON.
const credsOf = (auth: AuthDef, key: string | undefined): Record<string, string> | null => {
  if (auth.type !== 'fields' || !key) return null;
  try {
    return JSON.parse(key) as Record<string, string>;
  } catch {
    return null;
  }
};
export const putFields = (template: string, creds: Record<string, string>) => template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => creds[k] ?? '');
// The base address with the fields it holds filled in (a region).
export const baseFor = (baseUrl: string, auth: AuthDef, key: string | undefined) => {
  const c = credsOf(auth, key);
  return c ? putFields(baseUrl, c) : baseUrl;
};
// Never echo a key - or any field of a fields sign-in - back, even if the service quotes it.
export const redact = (text: string, auth: AuthDef, key: string | undefined) => {
  const c = credsOf(auth, key);
  const secrets = c ? Object.values(c).filter(v => typeof v === 'string' && v.length >= 6) : key ? [key] : [];
  return secrets.reduce((t, v) => t.split(v).join('[key]'), text);
};

// Headers and query parameters that carry the key.
export function authParts(auth: AuthDef, key: string | undefined): { headers: Record<string, string>; query: Record<string, string> } {
  if (auth.type === 'none') return { headers: {}, query: {} };
  if (!key) throw new Error('This integration has no key saved. Connect it in Settings -> Connectors.');
  if (auth.type === 'fields') {
    const c = credsOf(auth, key) ?? {};
    const each = (r?: Record<string, string>) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, putFields(v, c)]));
    return { headers: each(auth.headers), query: each(auth.query) };
  }
  // A signed-in (OAuth) service gets its current access token the same way.
  if (auth.type === 'bearer' || auth.type === 'oauth2' || auth.type === 'mcp_oauth') return { headers: { authorization: `Bearer ${key}` }, query: {} };
  if (auth.query) return { headers: {}, query: { [auth.query]: key } };
  return { headers: { [auth.header ?? 'x-api-key']: `${auth.prefix ?? ''}${key}` }, query: {} };
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

// A request's whole answer as JSON (an event's poll): the key added the way
// the service wants it, through the safe fetcher (or the one given, in tests).
export async function requestJson(
  baseUrl: string,
  request: RequestDef,
  auth: AuthDef,
  key: string | undefined,
  name: string,
  fetcher: Fetcher = async (url, init) => (await safeFetch(url, init as never)).res,
): Promise<unknown> {
  const { headers: authHeaders, query: authQuery } = authParts(auth, key);
  const url = new URL(baseFor(baseUrl, auth, key).replace(/\/+$/, '') + (request.path.startsWith('/') ? request.path : `/${request.path}`));
  for (const [k, v] of Object.entries({ ...(request.query ?? {}), ...authQuery })) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const body = request.body === undefined ? undefined : JSON.stringify(request.body);
  const res = await fetcher(url.toString(), {
    method: request.method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(request.headers ?? {}), ...authHeaders },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${name} answered ${res.status}: ${errorText(redact(text, auth, key)).slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${name} didn't answer with JSON.`);
  }
}

export async function callHttp(integration: HttpIntegration, tool: HttpToolDef, args: Record<string, unknown>, key: string | undefined): Promise<string> {
  // A required input left out or empty is the agent's mistake: say so, don't send it.
  const required = ((tool.input as { required?: string[] }).required ?? []).filter(r => args[r] === undefined || args[r] === null || String(args[r]).trim() === '');
  if (required.length) throw new Error(`Missing ${required.join(', ')}: give ${required.length === 1 ? 'it' : 'them'} and call again.`);
  const { headers: authHeaders, query: authQuery } = authParts(integration.auth, key);
  const path = String(fill(tool.request.path, args) ?? tool.request.path);
  const url = new URL(baseFor(integration.base_url, integration.auth, key).replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`));
  const query = (fill(tool.request.query ?? {}, args) ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries({ ...query, ...authQuery })) url.searchParams.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  const body = tool.request.body === undefined ? undefined : JSON.stringify(fill(tool.request.body, args));
  const { res } = await safeFetch(url.toString(), {
    method: tool.request.method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(tool.request.headers ?? {}), ...authHeaders },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${integration.name} answered ${res.status}: ${errorText(redact(text, integration.auth, key)).slice(0, 300)}`);
  }
  let answer: unknown = text;
  try {
    answer = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  return shape(answer, tool.response);
}
