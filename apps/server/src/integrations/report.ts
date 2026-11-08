import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Connection failures, as kinds only, to our backend - so we see which services
// and sign-ins break for everyone, not only for whoever tells us. Never a key,
// a token, an address, an account or anything the person typed: the service's
// id, the kind of connection and sign-in, how it failed, and the error's kind
// with every word that could identify anything taken out (errorKind).
//
// Only a build we made reports: backend.json beside package.json, written by
// apps/electron/scripts/stage.cjs from the backend address the app is built with.
// A development copy has none and sends nothing.

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend.json');
let backend: string | null | undefined;
// A container hosting an organization (docs/hosting-in-the-cloud.md) has no
// backend.json - it's built from the repository - but it's given our backend's
// address for its relay and tokens (EAA_TOKEN_ISSUER), and reports there. Without
// this its app-gap reports were kept and never sent.
export function reportBackend(file: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  const https = (u: string | undefined) => (u && /^https:\/\//.test(u) ? u.replace(/\/$/, '') : null);
  let url: string | undefined;
  try {
    url = file ? (JSON.parse(file) as { url?: string }).url : undefined;
  } catch {}
  return https(url) ?? https(env.EAA_REPORT_URL) ?? (env.EAA_CLOUD_HOST ? https(env.EAA_TOKEN_ISSUER) : null);
}
const backendUrl = () => {
  if (backend !== undefined) return backend;
  let file: string | null = null;
  try {
    file = readFileSync(FILE, 'utf8');
  } catch {}
  return (backend = reportBackend(file));
};

// "Gmail answered 400: Precondition check failed." -> "400 gmail answered precondition check failed".
// Gone: words with digits, dots, slashes, @ or quotes (hosts, keys, ids, emails), long
// runs of letters (a key), and a capital mid-sentence (a name); at most ten words.
export function errorKind(message: string): string {
  // The status a service answered, or the system's error code (ENOTFOUND), first.
  const lead = /answered (\d{3})/.exec(message)?.[1] ?? /\b(E[A-Z]{4,})\b/.exec(message)?.[1] ?? '';
  const raw = message.replace(/https?:\/\/\S+/g, ' ').split(/\s+/).filter(Boolean);
  const words = raw
    .map((w, i) => {
      const word = w.replace(/[,:;!?().]+$/g, '').replace(/^[(]+/, '');
      // A capital is a sentence's start (first word, or after ":" or "."), else a name.
      const starts = i === 0 || /[:.]$/.test(raw[i - 1]);
      const ok = word && word !== lead && /^[a-z_-]+$/i.test(word) && word.length <= 15 && (starts || !/^[A-Z]/.test(word));
      return ok ? word.toLowerCase() : '';
    })
    .filter(Boolean);
  return [lead, ...words].filter(Boolean).slice(0, 10).join(' ').slice(0, 100);
}

const clean = (s: string, max: number) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, max);

export function reportFailure(f: { service: string; kind: string; auth: string; how: string; message: string }) {
  const body = { service: clean(f.service, 40), kind: clean(f.kind, 10), auth: clean(f.auth, 12), how: clean(f.how, 10), error: errorKind(f.message) };
  void sendReport('/reports/connection-failure', body);
}

// One report to our backend; false when this copy has none (a development copy)
// or it didn't arrive. Callers send only what they've already made safe.
// to: a test's stand-in for the backend.
export async function sendReport(path: string, body: Record<string, unknown>, to: string | null = backendUrl()): Promise<boolean> {
  if (!to) return false;
  try {
    const r = await fetch(`${to}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  } catch {
    return false;
  }
}
