import { appHandshake, fromB64, toB64, type Session } from './relay-crypto';

// Reaching an organisation's host on someone else's computer: through our relay
// (the backend's /relay/app), signed in as you, then an end-to-end encrypted
// session with the host itself (relay-crypto.ts) - the relay passes on only
// ciphertext. Each request is sealed, sent, and answered on the same session.

export class HostOffline extends Error {}
// Whoever answered isn't the organisation's host: never just "offline".
export class NotTheHost extends Error {}

type Answer = { id: number; status: number; body: string; type: string };

export class RelayLink {
  private ws: WebSocket | null = null;
  private session: Session | null = null;
  private next = 1;
  private pending = new Map<number, { resolve: (a: Answer) => void; reject: (e: Error) => void }>();
  private inbox: Promise<unknown> = Promise.resolve();
  private outbox: Promise<unknown> = Promise.resolve();
  private opening: Promise<void> | null = null;

  constructor(
    private backend: string,
    private orgId: string,
    private hostKey: string,
    private sessionToken: () => Promise<string | null>,
  ) {}

  // Connected and through the handshake (once; again after it drops).
  open(): Promise<void> {
    this.opening ??= this.connect().catch(e => {
      this.opening = null;
      throw e;
    });
    return this.opening;
  }

  private async connect() {
    const token = await this.sessionToken();
    if (!token) throw new Error('Sign in first.');
    const url = new URL('/relay/app', this.backend);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url);
    const hs = await appHandshake(this.orgId, this.hostKey);
    await new Promise<void>((resolve, reject) => {
      let step: 'auth' | 'hello' = 'auth';
      ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token, org: this.orgId }));
      ws.onclose = e => {
        const why = e.code === 4004 ? new HostOffline(e.reason || 'The host is offline.') : new Error(e.reason || 'The connection to the host closed.');
        this.drop(why);
        reject(why);
      };
      ws.onmessage = e => {
        const m = JSON.parse(String(e.data)) as { t: string; d?: string };
        if (step === 'auth' && m.t === 'ready') {
          step = 'hello';
          return ws.send(JSON.stringify({ t: 'data', d: toB64(hs.hello) }));
        }
        if (m.t !== 'data' || !m.d) return;
        const d = fromB64(m.d);
        if (!this.session) {
          // The host's reply: only the real host can make one that opens.
          hs.finish(d).then(s => ((this.session = s), resolve()), err => (ws.close(), reject(new NotTheHost((err as Error).message))));
          return;
        }
        // Answers, opened in the order they came.
        this.inbox = this.inbox
          .then(async () => JSON.parse(new TextDecoder().decode(await this.session!.open(d))) as Answer)
          .then(a => {
            this.pending.get(a.id)?.resolve(a);
            this.pending.delete(a.id);
          })
          .catch(() => ws.close());
      };
    });
    this.ws = ws;
  }

  private drop(why: Error) {
    this.ws = null;
    this.session = null;
    this.opening = null;
    // What was waiting won't be answered: the host dropped (offline, for the app).
    for (const p of this.pending.values()) p.reject(why instanceof HostOffline ? why : new HostOffline(why.message));
    this.pending.clear();
  }

  // Throws HostOffline when the host can't be reached, or drops before answering.
  async request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
    await this.open().catch(e => {
      throw e instanceof HostOffline || e instanceof NotTheHost ? e : new HostOffline((e as Error).message);
    });
    const id = this.next++;
    const answer = new Promise<Answer>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    const msg = new TextEncoder().encode(JSON.stringify({ id, method: init.method ?? 'GET', path, headers: init.headers ?? {}, body: init.body }));
    // Sealed and sent in order: each takes the next counter.
    this.outbox = this.outbox.then(async () => this.ws?.send(JSON.stringify({ t: 'data', d: toB64(await this.session!.seal(msg)) })));
    const a = await answer;
    return new Response(a.body, { status: a.status, headers: { 'content-type': a.type } });
  }
}
