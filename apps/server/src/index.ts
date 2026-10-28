import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BuilderError, build, interview, matchPack, profileInterview, type Build, type Context, type Pack, type Turn } from './builder.js';
import { compose, kpiLabels, listIds, readMeta, remove, save, slug, type AgentFiles } from './files.js';
import { scanFleet } from './fleet.js';
import { enqueue, resume } from './jobs.js';
import { addNotes, loadProfile, saveProfile, type Profile } from './org.js';

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

// Who the agents work for, and what the fleet already has.
const context = async (org: string): Promise<Context> => ({ profile: await loadProfile(org), fleet: await scanFleet() });

// An agent as the app sees it: the card's details, plus the hidden files as an
// opaque bundle it hands back on accept. The id is unique among takenIds.
function forApp(b: Build, takenIds: string[], fleetIds?: Set<string>) {
  let id = slug(b.name);
  for (let n = 2; takenIds.includes(id); n++) id = `${slug(b.name)}-${n}`;
  const files = compose(b, id, fleetIds);
  return { agent: { id, name: b.name, department: b.department, output: b.kpi.map(k => k.label) }, files };
}

// Pre-built pack agents (scripts/build-packs.ts), reviewed and committed.
const PACKS = new URL('../packs/', import.meta.url);

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

type Route = (req: IncomingMessage, query: URLSearchParams) => Promise<unknown>;
const routes: Record<string, Route> = {
  // --- The organisation profile ---
  'GET /api/org': async (_req, q) => ({ profile: await loadProfile(q.get('name') ?? '') }),
  'POST /api/org/turn': async req => {
    const { org, turns } = await body<{ org: string; turns: Turn[] }>(req);
    const out = await profileInterview(org, turns);
    return { ...out, confidence: clamp(out.confidence) };
  },
  'POST /api/org': async req => {
    const { org, profile } = await body<{ org: string; profile: Profile }>(req);
    await saveProfile(org, profile);
    return { ok: true };
  },

  // --- Building an agent ---
  'POST /api/builder/match': async req => {
    const { description, packs } = await body<{ description: string; packs: Pack[] }>(req);
    return matchPack(description, packs);
  },
  'POST /api/builder/turn': async req => {
    const { org, turns, declinedPack } = await body<{ org: string; turns: Turn[]; declinedPack: string | null }>(req);
    const out = await interview(await context(org), turns, declinedPack);
    return { ...out, confidence: clamp(out.confidence) };
  },
  // The files stay hidden: the app gets the card's details and an opaque
  // bundle it hands back on accept.
  'POST /api/builder/build': async req => {
    const { org, turns, takenIds } = await body<{ org: string; turns: Turn[]; takenIds: string[] }>(req);
    const ctx = await context(org);
    const b = await build(ctx, turns);
    await addNotes(org, b.profile_notes ?? []);
    return forApp(b, takenIds, new Set(ctx.fleet.tools.map(t => t.id)));
  },

  // --- Packs: generic files at once, customized in the background on accept ---
  'POST /api/packs/add': async req => {
    const { packId, takenIds } = await body<{ packId: string; takenIds: string[] }>(req);
    if (!/^[a-z0-9-]+$/.test(packId)) throw new BuilderError('Unknown pack.');
    const builds = JSON.parse(
      await readFile(new URL(`${packId}.json`, PACKS), 'utf8').catch(() => {
        throw new BuilderError('That pack is not ready yet.');
      }),
    ) as Build[];
    const taken = [...takenIds];
    return {
      agents: builds.map((b, index) => {
        const a = forApp(b, taken);
        taken.push(a.agent.id);
        return { ...a, setup: { packId, index } };
      }),
    };
  },

  // --- Agents ---
  'POST /api/agents': async req => {
    const { org, files, setup } = await body<{ org: string; files: AgentFiles; setup?: { packId: string; index: number } }>(req);
    await save(files, {
      name: files.name,
      department: files.department,
      output: kpiLabels(files.kpi),
      status: setup ? 'setting-up' : 'ready',
      setup: setup && { ...setup, org, attempts: 0 },
    });
    if (setup) enqueue(files.id);
    return { ok: true };
  },
  // Every saved agent's set-up state and card details.
  'GET /api/agents/status': async () => {
    const out: Record<string, unknown> = {};
    for (const id of await listIds()) {
      const m = await readMeta(id);
      if (m) out[id] = { status: m.status, name: m.name, department: m.department, output: m.output };
    }
    return out;
  },
  'POST /api/agents/delete': async req => {
    const { id } = await body<{ id: string }>(req);
    await remove(id);
    return { ok: true };
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = routes[`${req.method} ${url.pathname}`];
  if (!route) return send(res, 404, { error: 'Not found' });
  try {
    send(res, 200, await route(req, url.searchParams));
  } catch (e) {
    if (e instanceof BuilderError) return send(res, 502, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong on the server.' });
  }
}).listen(PORT, () => {
  console.log(`eaa server on http://localhost:${PORT}`);
  resume();
});
