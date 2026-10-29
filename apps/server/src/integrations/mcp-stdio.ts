import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

// An MCP server that runs on this computer as a program (the stdio transport):
// started by the app, spoken to with newline-separated JSON-RPC on its stdin
// and stdout. One process per integration, kept running and reused; started
// again if it exits. Only a person adds these (Settings): it runs with their
// permissions, which is why the Agency Engineer can't.

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

class StdioServer {
  private child: ChildProcess | null = null;
  private seq = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<void> | null = null;
  private stderr = '';

  constructor(
    private name: string,
    private command: string[],
    private env: Record<string, string>,
  ) {}

  private start() {
    const [cmd, ...args] = this.command;
    const opts = { env: { ...process.env, ...this.env }, stdio: ['pipe', 'pipe', 'pipe'] as ('pipe')[], windowsHide: true };
    // On Windows through the shell (npx, uvx and the like are .cmd scripts
    // there), as one command line with each part quoted - the shell would split
    // a path like "C:\My Notes" otherwise.
    const quote = (a: string) => (/[\s"&|<>^()%!]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
    const child = process.platform === 'win32' ? spawn([cmd, ...args].map(quote).join(' '), { ...opts, shell: true }) : spawn(cmd, args, opts);
    this.child = child;
    this.stderr = '';
    child.stderr?.on('data', d => (this.stderr = (this.stderr + String(d)).slice(-1500)));
    createInterface({ input: child.stdout! }).on('line', line => {
      let msg: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        msg = JSON.parse(line);
      } catch {
        return; // a server's own logging on stdout
      }
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id!);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`${this.name}: ${msg.error.message ?? 'error'}`));
      else p.resolve(msg.result);
    });
    child.on('exit', code => {
      // The line that says what went wrong, not Node's trailing version line.
      const lines = this.stderr.trim().split('\n').map(l => l.trim()).filter(Boolean);
      const why = lines.find(l => /error|cannot|not found|denied|invalid/i.test(l)) ?? lines.pop() ?? '';
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(`${this.name} stopped (exit ${code})${why ? `: ${why.slice(0, 300)}` : ''}.`));
      }
      this.pending.clear();
      this.child = null;
      this.ready = null;
    });
    child.on('error', e => {
      for (const p of this.pending.values()) p.reject(new Error(`${this.name} couldn't start: ${e.message}`));
      this.pending.clear();
    });
  }

  private send(body: object) {
    this.child?.stdin?.write(`${JSON.stringify(body)}\n`);
  }

  request(method: string, params: object = {}, timeoutMs = 120_000): Promise<unknown> {
    const id = this.seq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name} didn't answer within ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  // Started and initialized once; again after it exits.
  open(): Promise<void> {
    if (this.ready && this.child) return this.ready;
    this.start();
    this.ready = (async () => {
      await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Extremely Autonomous Agents', version: '1.0.0' } }, 60_000);
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    })();
    this.ready.catch(() => (this.ready = null));
    return this.ready;
  }

  stop() {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }
}

const servers = new Map<string, StdioServer>();

export function stdioServer(id: string, name: string, command: string[], env: Record<string, string> = {}) {
  const key = `${id}\u0000${JSON.stringify(command)}\u0000${JSON.stringify(env)}`;
  let s = servers.get(key);
  if (!s) {
    for (const [k, old] of servers) if (k.startsWith(`${id}\u0000`)) (old.stop(), servers.delete(k)); // its command changed
    s = new StdioServer(name, command, env);
    servers.set(key, s);
  }
  return s;
}

export function stopStdioServer(id: string) {
  for (const [k, s] of servers) if (k.startsWith(`${id}\u0000`)) (s.stop(), servers.delete(k));
}
