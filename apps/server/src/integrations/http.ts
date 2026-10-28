import { safeFetch } from '../runner/net.js';
import type { AuthDef, HttpIntegration, HttpToolDef } from './schema.js';

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
      .map((r, i) => `${i + 1}. ${Object.entries(r).map(([k, v]) => `${k}: ${typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : JSON.stringify(v)}`).join('\n   ')}`)
      .join('\n\n')
      .slice(0, MAX_CHARS);
  }
  if (def?.pick) out = at(answer, def.pick);
  const text = typeof out === 'string' ? out : JSON.stringify(out, null, 1);
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[cut off]` : text;
}

// Headers and query parameters that carry the key.
export function authParts(auth: AuthDef, key: string | undefined): { headers: Record<string, string>; query: Record<string, string> } {
  if (auth.type === 'none') return { headers: {}, query: {} };
  if (!key) throw new Error('This integration has no key saved. Connect it in Settings -> Connectors.');
  if (auth.type === 'bearer') return { headers: { authorization: `Bearer ${key}` }, query: {} };
  if (auth.query) return { headers: {}, query: { [auth.query]: key } };
  return { headers: { [auth.header ?? 'x-api-key']: `${auth.prefix ?? ''}${key}` }, query: {} };
}

export async function callHttp(integration: HttpIntegration, tool: HttpToolDef, args: Record<string, unknown>, key: string | undefined): Promise<string> {
  const { headers: authHeaders, query: authQuery } = authParts(integration.auth, key);
  const path = String(fill(tool.request.path, args) ?? tool.request.path);
  const url = new URL(integration.base_url.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`));
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
    // Never echo the key back, even if the service quotes it.
    const safe = key ? text.split(key).join('[key]') : text;
    throw new Error(`${integration.name} answered ${res.status}: ${safe.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  let answer: unknown = text;
  try {
    answer = JSON.parse(text);
  } catch {
    // not JSON: keep the text
  }
  return shape(answer, tool.response);
}
