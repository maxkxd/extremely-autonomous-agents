import { createServer, STATUS_CODES, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

// The browser link (runner/browser-link.ts, docs/browser-extension.md) through a
// forwarding hop: the person's own agency passing /hosted/api/browser-link on to the
// organization it hosts, or a cloud container's public front passing
// /api/browser-link on to the agency, which listens inside the container only.
//
// The hop ends the person's WebSocket here and opens its own to the agency, then
// passes frames both ways. Only WebSocket frames ever reach the agency: never a raw
// HTTP request, which it would take as coming from this computer. The link checks
// the pairing code or token itself, and the Origin is passed on so its check of the
// extension's origin still holds; the hop adds no sign-in of its own.

export const LINK_PATH = '/api/browser-link';
// As the link's own limit (EAA.downloadFile sends up to 50 MB as base64).
const MAX_FRAME = 80 * 1024 * 1024;
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });

const refuse = (socket: Duplex, status: number) => {
  if (!socket.writable) return void socket.destroy();
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
};

// A close code that may be sent on: 1005/1006/1015 are only ever reported, never sent.
const sendable = (code: number) => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);

function closeWith(ws: WebSocket, code: number, reason: Buffer) {
  if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
  try {
    ws.close(sendable(code) ? code : 1000, reason.length <= 123 ? reason : undefined);
  } catch {
    ws.terminate();
  }
}

// Passes this upgrade on to the agency on 127.0.0.1:port, at the link's own path.
export function forwardLinkUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, port: number) {
  socket.on('error', () => {}); // the person's side dropped: the agency side closes below
  const search = new URL(req.url ?? '/', 'http://x').search;
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
  const up = new WebSocket(`ws://127.0.0.1:${port}${LINK_PATH}${search}`, { ...(origin ? { origin } : {}), maxPayload: MAX_FRAME, perMessageDeflate: false });
  let down: WebSocket | null = null;
  let answered = false; // the person's side has had its HTTP answer (a refusal)
  const early: { data: RawData; binary: boolean }[] = [];
  const gone = () => !down && up.terminate();
  socket.once('close', gone);

  up.on('unexpected-response', (r, res) => {
    // The agency refused it (an origin that isn't the extension's...): the same answer.
    res.resume();
    socket.off('close', gone);
    if (!answered) refuse(socket, res.statusCode ?? 502);
    answered = true;
    r.destroy();
  });
  up.on('error', () => {
    if (down) return void down.terminate();
    socket.off('close', gone);
    if (!answered) refuse(socket, 502); // not up: starting, or starting again
    answered = true;
  });
  up.on('message', (data, binary) => {
    if (down?.readyState === WebSocket.OPEN) down.send(data, { binary });
    else early.push({ data, binary });
  });
  up.on('open', () => {
    socket.off('close', gone);
    if (socket.destroyed) return void up.terminate();
    wss.handleUpgrade(req, socket, head, ws => {
      down = ws;
      for (const m of early.splice(0)) ws.send(m.data, { binary: m.binary });
      ws.on('message', (data, binary) => up.readyState === WebSocket.OPEN && up.send(data, { binary }));
      ws.on('close', (code, reason) => closeWith(up, code, reason));
      ws.on('error', () => up.terminate());
      up.on('close', (code, reason) => closeWith(ws, code, reason));
      if (up.readyState !== WebSocket.OPEN) closeWith(ws, 1001, Buffer.alloc(0));
    });
  });
}

// A cloud container's only public listener (scripts/cloud-host.ts): the browser
// link, passed on to the agency inside. Anything else gets a 404 and nothing more.
export function startLinkFront(port: number, agencyPort: number, host = '0.0.0.0'): Promise<Server> {
  const server = createServer((_req, res) => res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"Not found."}'));
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname === LINK_PATH) return forwardLinkUpgrade(req, socket, head, agencyPort);
    socket.on('error', () => {});
    refuse(socket, 404);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => (server.off('error', reject), resolve(server)));
  });
}
