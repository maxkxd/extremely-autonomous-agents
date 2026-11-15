import { rm } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './paths.js';
import { getSetting, setSetting } from './runner/db.js';
import { deleteSecret, getSecret, setSecret } from './vault.js';
import { HERE_HEADER } from './access.js';
import { relayState, startRelay, stopRelay } from './relay.js';
import { connectionBaseUrl, list as listConnections } from './models/connections.js';

// Hosting an organization (docs/architecture.md, "Accounts and organizations").
// The person's own agency is this server. The organization they own runs as a
// second agency beside it: the same server in its own process, with its own
// folder, ports and runner, listening only on this computer. The app reaches
// it through here (/hosted/...); members elsewhere will through the relay
// (phase 4). One organization owned each, so at most one.

// self: a self-hosted organization (selfhost.ts) - its own accounts and tokens, reached at its own address, never through us.
export type Hosting = { orgId: string; orgName: string; issuer: string; self?: boolean };
export const HOSTED_PORT = Number(process.env.EAA_HOSTED_PORT ?? 5185);
const HOSTED_HOOKS_PORT = HOSTED_PORT + 1;
// This process is itself an organization's agency (started below).
export const HOSTED_ORG = process.env.EAA_HOSTED_ORG ?? null;

export const hosting = () => getSetting<Hosting | null>('hosting', null);
export const hostedDir = (orgId: string) => join(DATA_DIR, 'hosted', orgId.replace(/[^a-zA-Z0-9-]/g, ''));

let child: ChildProcess | null = null;
let stopping = false;
let restarts = 0;
let up = false;

// The host's key pair, for the end-to-end encrypted sessions members open
// through the relay (phase 4): X25519, its public half published in our directory.
async function hostKey(orgId: string) {
  const id = `hosting:${orgId}:key`;
  const had = await getSecret<{ publicKey: string; privateKey: string }>(id);
  if (had) return had.publicKey;
  const pair = generateKeyPairSync('x25519');
  const publicKey = (pair.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  await setSecret(id, { publicKey, privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() });
  return publicKey;
}

// A new organization starts with the AI its owner already connected here (decided
// 2026-11-02) - it used to start with none, every card saying "No model" right
// after they'd connected their Claude plan. Once, when its agency first comes up:
// the Claude plan (the same sign-in on this computer), keys from this vault, and
// models on this computer. ChatGPT and Copilot sign-ins are connected there again.
// Changed in the organization's Connectors after that, never copied again.
async function shareAi(orgId: string) {
  const pending = `hosting:${orgId}:share_ai`; // set when it was first hosted here (startHosting)
  if (!getSetting<boolean>(pending, false)) return;
  const post = (path: string, body: unknown) =>
    new Promise<number>((resolve, reject) => {
      const out = request({ host: '127.0.0.1', port: HOSTED_PORT, method: 'POST', path, headers: { 'content-type': 'application/json' } }, r => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      out.on('error', reject);
      out.end(JSON.stringify(body));
    });
  for (const c of (await listConnections()).filter(c => c.connected)) {
    if (c.id === 'claude-code') await post('/api/connections/claude-code/check', {});
    else if (c.kind === 'key' || c.kind === 'local') {
      const key = c.kind === 'key' ? (await getSecret<{ key: string }>(c.id))?.key : '';
      if (c.kind === 'key' && !key) continue;
      await post('/api/connections/key', { id: c.id, key, baseUrl: await connectionBaseUrl(c.id) });
    }
  }
  setSetting(pending, false);
}

async function launch(h: Hosting) {
  const hostSecret = (await getSecret<string>(`hosting:${h.orgId}:secret`)) ?? '';
  const server = fileURLToPath(new URL('./index.ts', import.meta.url));
  child = spawn(process.execPath, ['--import', 'tsx', server], {
    env: {
      ...process.env,
      PORT: String(HOSTED_PORT),
      EAA_CALLBACK_PORT: String(process.env.PORT ?? 5175), // sign-ins come back to the app's port (oauth.ts)
      HOOKS_PORT: String(HOSTED_HOOKS_PORT),
      EAA_DATA_DIR: hostedDir(h.orgId),
      EAA_VAULT_KEY: '', // its own vault, with its own key - not this agency's
      EAA_HOSTED_ORG: h.orgId,
      EAA_TOKEN_ISSUER: h.issuer,
      EAA_SELF_HOSTED: h.self ? '1' : '',
      EAA_HOST_PERSON: getSetting<string | null>('host_person', null) ?? '',
      EAA_PARENT_PID: String(process.pid),
      EAA_HOST_SECRET: hostSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const tag = (d: Buffer) => String(d).replace(/^(?=.)/gm, `[${h.orgName}] `);
  child.stdout?.on('data', d => {
    if (/eaa server on/.test(String(d))) {
      up = true;
      restarts = 0;
      void shareAi(h.orgId).catch(e => console.error(`[${h.orgName}] sharing your AI connections failed:`, (e as Error).message));
    }
    process.stdout.write(tag(d));
  });
  child.stderr?.on('data', d => process.stderr.write(tag(d)));
  child.on('exit', code => {
    child = null;
    up = false;
    if (stopping || !hosting()) return;
    // It fell over: start it again, waiting longer each time.
    const wait = Math.min(60_000, 1000 * 2 ** restarts++);
    console.error(`[${h.orgName}] stopped (${code}); starting again in ${wait / 1000}s.`);
    setTimeout(() => hosting() && !child && void launch(hosting()!), wait);
  });
}

export async function startHosting(h: Hosting) {
  if (HOSTED_ORG) throw new Error('An organization’s agency doesn’t host another.');
  const was = hosting();
  if (was && was.orgId !== h.orgId) throw new Error(`This computer already hosts ${was.orgName}.`);
  if (!was) setSetting(`hosting:${h.orgId}:share_ai`, true);
  setSetting('hosting', h);
  const publicKey = await hostKey(h.orgId);
  if (!child) {
    stopping = false;
    await launch(h);
  }
  // Registered before (started again): reachable by members straight away. Self-hosted: at its own address.
  if (!h.self) void startRelay(h);
  return { publicKey };
}

// The secret the host signs in to the relay with (phase 4), from registering it.
export async function keepHostSecret(orgId: string, secret: string) {
  await setSecret(`hosting:${orgId}:secret`, secret);
  // The organization's agency asks our backend about members with it (agency MCP addresses).
  const out = request({ host: '127.0.0.1', port: HOSTED_PORT, method: 'POST', path: '/api/settings/host-secret', headers: { 'content-type': 'application/json' } });
  out.on('error', () => {}); // not up yet: it gets it when it starts
  out.end(JSON.stringify({ secret }));
  // Registered: members elsewhere can reach it now, through our relay.
  const h = hosting();
  if (h?.orgId === orgId) void startRelay(h);
}

// Moved to another computer: its agency stops. Its folder stays, in case.
// Resolves once it has exited (or after 10 seconds).
export async function stopHosting() {
  setSetting('hosting', null);
  stopping = true;
  stopRelay();
  const was = child;
  if (!was) return;
  await new Promise<void>(done => {
    const t = setTimeout(done, 10_000);
    was.once('exit', () => (clearTimeout(t), done()));
    was.kill();
  });
}

// The organization was deleted: its agency stops, and nothing of it stays on
// this computer - its folder (agents, runs, messages, memories, connections and
// their keys) and its host keys.
export async function deleteHosting(orgId: string) {
  if (hosting()?.orgId === orgId) await stopHosting();
  await rm(hostedDir(orgId), { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  await deleteSecret(`hosting:${orgId}:key`);
  await deleteSecret(`hosting:${orgId}:secret`);
}

export const hostingStatus = () => {
  const h = hosting();
  return h ? { ...h, running: up, relay: relayState() } : null;
};

// On start: carry on hosting.
export function resumeHosting() {
  const h = hosting();
  if (h && !HOSTED_ORG && !child) void launch(h);
  if (h && !HOSTED_ORG && !h.self) void startRelay(h);
}
process.on('exit', () => child?.kill());

// The organization's agency goes when the person's own does, however that ends
// (a restart can skip 'exit'), so it never holds its port with nobody to reach it.
const parent = Number(process.env.EAA_PARENT_PID);
if (HOSTED_ORG && parent)
  setInterval(() => {
    try {
      process.kill(parent, 0);
    } catch {
      process.exit(0);
    }
  }, 2000).unref();

// The desktop app's agency (apps/electron) goes when the app does, however
// that ends - a crash would otherwise leave it holding the ports the next
// launch needs. (An organization's agency it hosts inherits this too.)
const desktop = Number(process.env.EAA_APP_PID);
if (desktop)
  setInterval(() => {
    try {
      process.kill(desktop, 0);
    } catch {
      process.exit(0);
    }
  }, 2000).unref();

// The app's requests for the organization's agency, passed on as they are. The
// agency checks them itself: a token, or this computer.
// The organization is hosted right here, so the app never says it "isn't answering"
// because of how it's passed on: a request that comes while it's starting (the app
// just opened, or it's starting again after falling over) waits for it instead of
// failing; each goes on its own connection (a reused one the agency had just closed
// failed as "isn't answering"); and one that never reached it is tried again.
// Only a read is retried after it may have reached the agency: an approval or a
// message is never sent twice.
export function forwardToHosted(req: IncomingMessage, res: ServerResponse, path: string) {
  return forward(req, res, path, { port: HOSTED_PORT, isUp: () => up, hosted: () => !!hosting() }).catch(
    () => res.headersSent || res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The organization’s agency isn’t answering.' })),
  );
}

const START_WAIT_MS = 90_000;
const TRIES = 4;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function forward(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  o: { port: number; isUp: () => boolean; hosted: () => boolean; startWaitMs?: number; retryMs?: number },
) {
  const fail = (status: number, error: string) => res.headersSent || res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error }));
  // Whether it came from this computer: only we say so, never the request itself.
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${o.port}` };
  delete headers[HERE_HEADER];
  if (/^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket.remoteAddress ?? '')) headers[HERE_HEADER] = '1';
  // Kept whole, so it can be sent again; a connection of its own each time.
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks);
  for (const h of ['connection', 'keep-alive', 'transfer-encoding', 'content-length']) delete headers[h];
  if (body.length || !['GET', 'HEAD'].includes(req.method ?? 'GET')) headers['content-length'] = String(body.length);
  const read = ['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? 'GET');
  for (let attempt = 1; ; attempt++) {
    const until = Date.now() + (o.startWaitMs ?? START_WAIT_MS);
    while (!o.isUp()) {
      if (!o.hosted()) return fail(503, 'This computer no longer hosts the organization.');
      if (Date.now() > until) return fail(503, 'The organization’s agency didn’t start. Restart the app; if it keeps happening, its log says why.');
      await sleep(200);
    }
    const outcome = await new Promise<'done' | { reached: boolean }>(done => {
      const out = request({ host: '127.0.0.1', port: o.port, method: req.method, path, headers, agent: false }, r => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        r.on('end', () => done('done'));
        r.on('error', () => done('done'));
      });
      // Refused: nothing reached it (it's starting again), so sending again is safe.
      out.on('error', e => done({ reached: (e as NodeJS.ErrnoException).code !== 'ECONNREFUSED' }));
      out.end(body);
    });
    if (outcome === 'done') return;
    if (res.headersSent || attempt >= TRIES || (outcome.reached && !read)) return fail(502, 'The organization’s agency isn’t answering.');
    await sleep(o.retryMs ?? 500);
  }
}
