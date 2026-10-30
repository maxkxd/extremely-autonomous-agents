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

// Hosting an organisation (docs/architecture.md, "Accounts and organisations").
// The person's own agency is this server. The organisation they own runs as a
// second agency beside it: the same server in its own process, with its own
// folder, ports and runner, listening only on this computer. The app reaches
// it through here (/hosted/...); members elsewhere will through the relay
// (phase 4). One organisation owned each, so at most one.

// self: a self-hosted organisation (selfhost.ts) - its own accounts and tokens, reached at its own address, never through us.
export type Hosting = { orgId: string; orgName: string; issuer: string; self?: boolean };
export const HOSTED_PORT = Number(process.env.EAA_HOSTED_PORT ?? 5185);
const HOSTED_HOOKS_PORT = HOSTED_PORT + 1;
// This process is itself an organisation's agency (started below).
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

async function launch(h: Hosting) {
  const hostSecret = (await getSecret<string>(`hosting:${h.orgId}:secret`)) ?? '';
  const server = fileURLToPath(new URL('./index.ts', import.meta.url));
  child = spawn(process.execPath, ['--import', 'tsx', server], {
    env: {
      ...process.env,
      PORT: String(HOSTED_PORT),
      HOOKS_PORT: String(HOSTED_HOOKS_PORT),
      EAA_DATA_DIR: hostedDir(h.orgId),
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
    if (/eaa server on/.test(String(d))) (up = true), (restarts = 0);
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
  if (HOSTED_ORG) throw new Error('An organisation’s agency doesn’t host another.');
  const was = hosting();
  if (was && was.orgId !== h.orgId) throw new Error(`This computer already hosts ${was.orgName}.`);
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
  // The organisation's agency asks our backend about members with it (agency MCP addresses).
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

// The organisation was deleted: its agency stops, and nothing of it stays on
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

// The organisation's agency goes when the person's own does, however that ends
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

// The app's requests for the organisation's agency, passed on as they are. The
// agency checks them itself: a token, or this computer.
export function forwardToHosted(req: IncomingMessage, res: ServerResponse, path: string) {
  if (!up) return res.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The organisation’s agency is starting.' }));
  // Whether it came from this computer: only we say so, never the request itself.
  const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: `127.0.0.1:${HOSTED_PORT}` };
  delete headers[HERE_HEADER];
  if (/^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket.remoteAddress ?? '')) headers[HERE_HEADER] = '1';
  const out = request({ host: '127.0.0.1', port: HOSTED_PORT, method: req.method, path, headers }, r => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  out.on('error', () => res.headersSent || res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'The organisation’s agency isn’t answering.' })));
  req.pipe(out);
}
