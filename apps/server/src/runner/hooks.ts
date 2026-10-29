import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { promisify } from 'node:util';
import { getSetting, setSetting } from './db.js';
import { handleHook } from './events.js';
import type { Trigger } from './run.js';

// Where services post events (docs/events.md). A server of its own, apart from
// the app's: it takes POST /hooks/<token> and nothing else, so it's the only
// thing a tunnel ever exposes - never the app's API, which controls the agency.
// The tunnel (Cloudflare's cloudflared, a quick tunnel: no account) gives it a
// public https address while it's on; the address changes each time it starts,
// so Settings shows the current one to paste into each service.

export const HOOKS_PORT = Number(process.env.HOOKS_PORT ?? 5176);
const LOCAL = `http://127.0.0.1:${HOOKS_PORT}`;
const MAX_BODY = 1_000_000;

let server: Server | null = null;

export function startHooks(book: (agentId: string, trigger: Trigger, task: string | null) => void) {
  if (server) return;
  server = createServer(async (req, res) => {
    const m = (req.url ?? '').match(/^\/hooks\/([a-f0-9]{36})\/?(?:\?.*)?$/);
    if (!m) return void res.writeHead(404).end();
    // Some services check the address with a GET first.
    if (req.method === 'GET' || req.method === 'HEAD') return void res.writeHead(200).end();
    if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_BODY) return void res.writeHead(413).end();
      chunks.push(c as Buffer);
    }
    try {
      const r = await handleHook(m[1], Buffer.concat(chunks), req.headers, book);
      res.writeHead(r.status, { 'content-type': 'text/plain' }).end(r.message);
    } catch (e) {
      console.error('Webhook failed:', (e as Error).message);
      res.writeHead(500).end();
    }
  });
  server.on('error', e => console.error(`The webhook server couldn't start on ${HOOKS_PORT}:`, e.message));
  server.listen(HOOKS_PORT, '127.0.0.1');
  if (getSetting<boolean>('webhook_tunnel', false)) void startTunnel();
}

// --- The tunnel ----------------------------------------------------------------------

export type TunnelState = { status: 'off' | 'starting' | 'on' | 'missing' | 'error'; url: string | null; error: string | null };
let tunnel: TunnelState = { status: 'off', url: null, error: null };
let child: ChildProcess | null = null;

const installed = () =>
  promisify(execFile)(process.platform === 'win32' ? 'where' : 'which', ['cloudflared']).then(
    () => true,
    () => false,
  );

async function startTunnel() {
  if (child) return;
  if (!(await installed())) {
    tunnel = { status: 'missing', url: null, error: null };
    return;
  }
  tunnel = { status: 'starting', url: null, error: null };
  const proc = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', LOCAL], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child = proc;
  let log = '';
  const read = (d: Buffer) => {
    log = (log + String(d)).slice(-4000);
    const url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(log)?.[0];
    if (url && tunnel.status !== 'on') tunnel = { status: 'on', url, error: null };
  };
  proc.stdout?.on('data', read);
  proc.stderr?.on('data', read);
  proc.on('exit', code => {
    child = null;
    if (getSetting<boolean>('webhook_tunnel', false) && tunnel.status !== 'off') {
      const why = log.split('\n').reverse().find(l => /error|failed/i.test(l))?.trim();
      tunnel = { status: 'error', url: null, error: why?.slice(0, 300) ?? `cloudflared stopped (exit ${code}).` };
    }
  });
  proc.on('error', e => {
    child = null;
    tunnel = { status: 'error', url: null, error: e.message };
  });
}

function stopTunnel() {
  tunnel = { status: 'off', url: null, error: null };
  child?.kill();
  child = null;
}

export async function setTunnel(on: boolean) {
  setSetting('webhook_tunnel', on);
  if (on) await startTunnel();
  else stopTunnel();
  return tunnelState();
}

export const tunnelState = (): TunnelState => tunnel;

// The address services post to: the tunnel's while it's up, else this computer's
// (reachable only from here - for tools on this machine, and for testing).
export const hooksBase = () => (tunnel.status === 'on' && tunnel.url ? tunnel.url : LOCAL);
