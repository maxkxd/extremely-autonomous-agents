import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSetting, setSetting } from './db.js';
import type { Rpc } from './mcp.js';

// A teammate's AI assistant, for an organization hosted on someone else's
// computer (docs/requests.md, "Your AI assistant"). Claude Desktop or Cursor
// talks to an address here, on the teammate's own computer; each message waits
// here until their app (open, signed in) picks it up, sends it to the
// organization's host the way the app sends everything (the relay, end to end
// encrypted, with their org token: POST /api/agency-mcp/rpc), and hands back
// the answer. So it acts as them, with what their role allows, and needs nothing
// stored here but which organization each address is for.

const PORT = Number(process.env.PORT ?? 5175);
const KEY = 'remote_mcp'; // { [token]: orgId }
// A message nobody picks up this long: the app isn't open.
const PICKUP_MS = 20_000;
const ANSWER_MS = 10 * 60_000;
const APP_CLOSED = "Can't reach your organization's agency: open the Extremely Autonomous Agents app on this computer and sign in, then try again.";

type Waiting = { id: number; orgId: string; msg: Rpc; picked: boolean; done: (reply: object) => void };
const waiting = new Map<number, Waiting>();
let next = 1;
let wake: (() => void)[] = [];

const tokens = () => getSetting<Record<string, string>>(KEY, {});

// The address for an organization: the same one each time (it's what the AI assistant was given).
export function remoteMcpUrl(orgId: string): string {
  const all = tokens();
  let token = Object.keys(all).find(t => all[t] === orgId);
  if (!token) {
    token = randomBytes(24).toString('hex');
    setSetting(KEY, { ...all, [token]: orgId });
  }
  return `http://127.0.0.1:${PORT}/mcp/${token}`;
}

// Whether an address is one of these (so it can be connected like the agency's own).
export const isRemoteMcpUrl = (url: string) => Object.keys(tokens()).some(t => url === `http://127.0.0.1:${PORT}/mcp/${t}`);

const errorFor = (msg: Rpc, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } });

// Handles /mcp/<token> for these addresses. Returns false when it isn't one.
export async function handleRemoteMcp(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  const m = path.match(/^\/mcp\/([a-f0-9]{48})$/);
  const orgId = m && tokens()[m[1]];
  if (!orgId) return false;
  if (req.method !== 'POST') return void res.writeHead(405, { allow: 'POST' }).end(), true;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  let msg: Rpc;
  try {
    msg = JSON.parse(raw);
  } catch {
    return void res.writeHead(400).end(), true;
  }
  // Notifications: nothing comes back, and the host needs none of them.
  if (msg.id === undefined) return void res.writeHead(202).end(), true;
  const reply = await new Promise<object>(done => {
    const w: Waiting = { id: next++, orgId, msg, picked: false, done };
    waiting.set(w.id, w);
    setTimeout(() => !w.picked && finish(w.id, errorFor(msg, APP_CLOSED)), PICKUP_MS).unref();
    setTimeout(() => finish(w.id, errorFor(msg, "Your organization's agency didn't answer in time.")), ANSWER_MS).unref();
    for (const f of wake.splice(0)) f();
  });
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
  return true;
}

function finish(id: number, reply: object) {
  const w = waiting.get(id);
  if (!w) return;
  waiting.delete(id);
  w.done(reply);
}

// For the app: the messages waiting to go (waits up to `waitMs` for one).
export async function takeRemoteMcp(waitMs: number): Promise<{ id: number; orgId: string; msg: Rpc }[]> {
  const ready = () => [...waiting.values()].filter(w => !w.picked);
  if (!ready().length && waitMs > 0) await new Promise<void>(r => (wake.push(r), setTimeout(r, Math.min(waitMs, 30_000)).unref()));
  return ready().map(w => ((w.picked = true), { id: w.id, orgId: w.orgId, msg: w.msg }));
}

// For the app: the host's answer to one (or why it couldn't be sent).
export function answerRemoteMcp(id: number, reply: object | null, error?: string) {
  const w = waiting.get(id);
  if (!w) return;
  finish(id, reply ?? errorFor(w.msg, error || APP_CLOSED));
}
