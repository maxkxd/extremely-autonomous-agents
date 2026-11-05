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
const backendUrl = () => {
  if (backend !== undefined) return backend;
  try {
    const url = (JSON.parse(readFileSync(FILE, 'utf8')) as { url?: string }).url ?? '';
    backend = /^https:\/\//.test(url) ? url.replace(/\/$/, '') : null;
  } catch {
    backend = null;
  }
  return backend;
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
  const url = backendUrl();
  if (!url) return;
  const body = { service: clean(f.service, 40), kind: clean(f.kind, 10), auth: clean(f.auth, 12), how: clean(f.how, 10), error: errorKind(f.message) };
  void fetch(`${url}/reports/connection-failure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});
}
