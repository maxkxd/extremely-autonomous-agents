import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BuilderError, build, interview, matchPack, type Pack, type Turn } from './builder.js';
import { compose, save, slug, type AgentFiles } from './files.js';

// The desktop app's backend. Local only; Vite proxies /api here.
const PORT = Number(process.env.PORT ?? 5175);

async function body<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as T;
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
  'POST /api/builder/match': async req => {
    const { description, packs } = await body<{ description: string; packs: Pack[] }>(req);
    return matchPack(description, packs);
  },
  'POST /api/builder/turn': async req => {
    const { turns, declinedPack } = await body<{ turns: Turn[]; declinedPack: string | null }>(req);
    const out = await interview(turns, declinedPack);
    return { ...out, confidence: Math.max(0, Math.min(100, Math.round(out.confidence))) };
  },
  // The files stay hidden: the app gets the card's details and an opaque
  // bundle it hands back on accept.
  'POST /api/builder/build': async req => {
    const { turns, takenIds } = await body<{ turns: Turn[]; takenIds: string[] }>(req);
    const b = await build(turns);
    let id = slug(b.name);
    for (let n = 2; takenIds.includes(id); n++) id = `${slug(b.name)}-${n}`;
    const files = compose(b, id);
    return {
      agent: { id, name: b.name, department: b.department, output: b.kpi.map(k => k.label) },
      files,
    };
  },
  'POST /api/agents': async req => {
    const files = await body<AgentFiles>(req);
    await save(files);
    return { ok: true };
  },
};

createServer(async (req, res) => {
  const route = routes[`${req.method} ${req.url?.split('?')[0]}`];
  if (!route) return send(res, 404, { error: 'Not found' });
  try {
    send(res, 200, await route(req));
  } catch (e) {
    if (e instanceof BuilderError) return send(res, 502, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong on the server.' });
  }
}).listen(PORT, () => console.log(`eaa server on http://localhost:${PORT}`));
