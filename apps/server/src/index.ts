import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { BuilderError, build, interview, matchPack, profileInterview, type Build, type Context, type Pack, type Turn } from './builder.js';
import { compose, kpiLabels, listIds, readMeta, remove, save, slug, type AgentFiles } from './files.js';
import { scanFleet } from './fleet.js';
import { createAgent, deleteAgent } from './agents.js';
import { enqueue, resume } from './jobs.js';
import { allChecks, checkModel } from './models/check.js';
import { allChoices, removeChoices, setChoices } from './models/choice.js';
import * as conn from './models/connections.js';
import { ConnectError } from './models/providers.js';
import { CATALOG } from './catalog.js';
import { addNotes, addPersonNotes, loadPerson, loadProfile, savePerson, saveProfile, type PersonProfile, type Profile } from './org.js';
import { keepLinks, linkPeople } from './links.js';
import { runnerRoutes } from './runner/api.js';
import { finishIntegrationSignIn, integrationToolIds, liveEventIds } from './integrations/index.js';
import { handleMcp } from './runner/mcp.js';
import { book, startScheduler } from './runner/scheduler.js';
import { FLEET_ENGINEER } from './runner/agent.js';
import { startAgencyMcp } from './runner/agency-mcp.js';
import { startHooks } from './runner/hooks.js';
import { agencyStopped } from './runner/run.js';
import { fileRequest } from './runner/tools.js';
import { parse as parseYaml } from 'yaml';
import { forwardToHosted, HOSTED_ORG, hostingStatus, keepHostSecret, resumeHosting, startHosting, stopHosting } from './hosting.js';
import { setSetting } from './runner/db.js';
import { AccessError, accessConfig, actorFor, asActor, authorize, currentActor, personFor, recordAction, requireAdmin, setAccessConfig } from './access.js';

// The desktop app's backend. Local only; Vite proxies /api here.
const PORT = Number(process.env.PORT ?? 5175);

// Read once (the server does, before a route runs), so who-did-what can see what it was about.
const bodies = new WeakMap<IncomingMessage, unknown>();
async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  try {
    bodies.set(req, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
  } catch {
    throw new ConnectError('Not JSON.');
  }
}
async function body<T>(req: IncomingMessage): Promise<T> {
  if (!bodies.has(req)) await readBody(req);
  return bodies.get(req) as T;
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

// The page a provider's sign-in lands on, in the browser window it opened.
class Html {
  constructor(readonly body: string) {}
}
const escape = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function landing(ok: boolean, message: string) {
  return new Html(`<!doctype html><meta charset="utf-8"><title>${ok ? 'Connected' : 'Not connected'}</title>
<body style="margin:0;height:100vh;display:grid;place-items:center;background:#141414;color:#e6e6e6;font-family:'IBM Plex Sans','Segoe UI',system-ui,sans-serif;text-align:center">
<div><h1 style="font-size:22px;margin:0 0 8px">${ok ? 'Connected' : 'Not connected'}</h1>
<p style="color:#8a8a8a;margin:0">${escape(message)}</p></div>
<script>${ok ? 'setTimeout(() => window.close(), 1200)' : ''}</script></body>`);
}
async function callback(finish: () => Promise<void>) {
  try {
    await finish();
    return landing(true, 'You can close this window and go back to the app.');
  } catch (e) {
    return landing(false, e instanceof ConnectError ? e.message : 'Something went wrong. Try again from Settings.');
  }
}

// Who you're talking to, the organisation (null when they don't have one), and
// what the fleet already has. The builder never waits on linking key people to
// members: it uses the links as they stand and starts a check in the background
// (a no-op once everyone's been checked), so the next turn has them.
const context = async (person: string, org: string | null, members: string[] = []): Promise<Context> => {
  if (org) linkPeople(org, members).catch(e => console.error('Linking key people failed:', e));
  return {
    person: await loadPerson(person),
    profile: org ? await loadProfile(org) : null,
    fleet: await scanFleet(),
    models: await conn.availableModels(),
  };
};

// An agent as the app sees it: the card's details, plus the hidden files as an
// opaque bundle it hands back on accept. The id is unique among takenIds.
function forApp(b: Build, takenIds: string[], fleetIds?: Set<string>, available?: conn.Available[]) {
  let id = slug(b.name);
  for (let n = 2; takenIds.includes(id); n++) id = `${slug(b.name)}-${n}`;
  const files = compose(b, id, fleetIds, available, new Set(liveEventIds()));
  return { agent: { id, name: b.name, department: b.department, output: b.kpi.map(k => k.label) }, files };
}

// Pre-built pack agents (scripts/build-packs.ts), reviewed and committed.
const PACKS = new URL('../packs/', import.meta.url);

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
const notStopped = () => {
  if (agencyStopped()) throw new BuilderError('The agency is stopped. Resume it, or put it on standby, to build agents.');
};

type Route = (req: IncomingMessage, query: URLSearchParams) => Promise<unknown>;
const routes: Record<string, Route> = {
  // --- The organisation profile ---
  'GET /api/org': async (_req, q) => ({ profile: await loadProfile(q.get('name') ?? '') }),
  'POST /api/org/turn': async req => {
    const { person, org, turns } = await body<{ person: string; org: string; turns: Turn[] }>(req);
    const me = personFor(person);
    const out = await profileInterview(org, await loadPerson(me), turns);
    if (me) await addPersonNotes(me, out.person_notes ?? []);
    return { ...out, confidence: clamp(out.confidence) };
  },
  // link: check the key people against the members straight away (the profile
  // chat); Settings asks for that itself once a person's row is finished.
  'POST /api/org': async req => {
    const { org, profile, members, link } = await body<{ org: string; profile: Profile; members?: string[]; link?: boolean }>(req);
    if (await loadProfile(org)) requireAdmin(currentActor(), 'Changing the organisation profile');
    await saveProfile(org, keepLinks(await loadProfile(org), profile));
    if (link && members) linkPeople(org, members).catch(e => console.error('Linking key people failed:', e));
    return { ok: true };
  },
  'POST /api/org/links': async req => {
    const { org, members } = await body<{ org: string; members: string[] }>(req);
    const p = await linkPeople(org, members ?? []);
    return { people: (p?.people ?? []).map(({ name, role, member }) => ({ name, role, member: member ?? null })) };
  },

  // --- The person ---
  'GET /api/person': async (_req, q) => ({ person: await loadPerson(q.get('name') ?? '') }),
  'POST /api/person': async req => {
    const { profile } = await body<{ profile: PersonProfile }>(req);
    if (personFor(profile?.name) !== profile?.name) throw new AccessError(403, 'You can only change your own profile.');
    await savePerson(profile);
    return { ok: true };
  },

  // --- Who's asking, and whose tokens this host accepts (access.ts) ---
  'GET /api/access': async () => {
    const { issuer, orgId } = accessConfig();
    return { you: currentActor(), issuer, orgId };
  },
  // Set on the host computer itself, when its owner registers it (phase 3).
  'POST /api/settings/access': async req => {
    const { issuer, orgId } = await body<{ issuer?: string; orgId?: string | null }>(req);
    return setAccessConfig({ ...(typeof issuer === 'string' ? { issuer } : {}), ...(orgId !== undefined ? { orgId: typeof orgId === 'string' && orgId ? orgId : null } : {}) });
  },

  // --- An organisation this computer hosts, run beside this agency (hosting.ts) ---
  'GET /api/hosting': async () => ({ hosting: hostingStatus() }),
  'POST /api/hosting/start': async req => {
    const { orgId, orgName, issuer } = await body<{ orgId: string; orgName: string; issuer: string }>(req);
    if (typeof orgId !== 'string' || !/^[\w-]{1,64}$/.test(orgId) || typeof orgName !== 'string' || typeof issuer !== 'string' || !/^https?:\/\//.test(issuer))
      throw new ConnectError('Which organisation?');
    return startHosting({ orgId, orgName: orgName.slice(0, 80), issuer });
  },
  'POST /api/hosting/secret': async req => {
    const { orgId, hostSecret } = await body<{ orgId: string; hostSecret: string }>(req);
    if (hostingStatus()?.orgId !== orgId || typeof hostSecret !== 'string' || !hostSecret) throw new ConnectError('Not hosting that organisation.');
    await keepHostSecret(orgId, hostSecret);
    return { ok: true };
  },
  'POST /api/hosting/stop': async () => (await stopHosting(), { ok: true }),

  // --- Settings: connectors and the server's own state ---
  'GET /api/catalog': async () => CATALOG.map(s => ({ server: s.server, what: s.what, tools: s.tools.length })),
  // Whether a key is set - never the key itself.
  'GET /api/health': async () => ({ anthropicKey: !!process.env.ANTHROPIC_API_KEY }),

  // --- AI model connections (docs/model-connections.md) ---
  'GET /api/connections': async () => conn.list(),
  'POST /api/connections/key': async req => {
    const { id, key, baseUrl } = await body<{ id: string; key: string; baseUrl?: string }>(req);
    await conn.connectKey(id, key ?? '', baseUrl);
    return { ok: true };
  },
  'POST /api/connections/retry': async req => {
    const { id } = await body<{ id: string }>(req);
    await conn.retryKey(id);
    return { ok: true };
  },
  'POST /api/connections/disconnect': async req => {
    const { id } = await body<{ id: string }>(req);
    await conn.disconnect(id);
    return { ok: true };
  },
  // Returns the provider's sign-in page; the app opens it in a new window.
  'POST /api/connections/oauth/start': async req => {
    const { id } = await body<{ id: string }>(req);
    if (id === 'openrouter') return { url: conn.openRouterStart() };
    if (id === 'chatgpt') return { url: await conn.chatGptStart() };
    throw new ConnectError('That provider has no sign-in.');
  },
  'GET /api/oauth/openrouter/callback': async (_req, q) => callback(() => conn.openRouterCallback(q)),
  'GET /api/oauth/chatgpt/callback': async (_req, q) => callback(() => conn.chatGptCallback(q)),
  // An integration's sign-in (Gmail...) lands on the root (oauth.ts says why);
  // it's tested before it counts as connected.
  'GET /': async (_req, q) =>
    !q.get('state')
      ? { server: 'Extremely Autonomous Agents' }
      : callback(async () => {
      try {
        await finishIntegrationSignIn(q);
      } catch (e) {
        throw e instanceof ConnectError ? e : new ConnectError(`Signed in, but the test failed: ${(e as Error).message}`);
      }
    }),
  'POST /api/connections/copilot/start': async () => conn.copilotStart(),
  'POST /api/connections/claude-code/check': async () => {
    await conn.claudeCodeConnect();
    return { ok: true };
  },
  'POST /api/connections/claude-code/install': async () => {
    await conn.claudeCodeInstall();
    return { ok: true };
  },
  'POST /api/connections/claude-code/login': async () => {
    await conn.claudeCodeLogin();
    return { ok: true };
  },

  // --- Building an agent ---
  // Not while the whole agency is stopped (it is on standby).
  'POST /api/builder/match': async req => {
    notStopped();
    const { description, packs } = await body<{ description: string; packs: Pack[] }>(req);
    return matchPack(description, packs);
  },
  'POST /api/builder/turn': async req => {
    notStopped();
    const { person, org, members, turns, declinedPack } = await body<{ person: string; org: string | null; members: string[]; turns: Turn[]; declinedPack: string | null }>(req);
    const out = await interview(await context(personFor(person), org, members), turns, declinedPack);
    return { ...out, confidence: clamp(out.confidence) };
  },
  // The files stay hidden: the app gets the card's details and an opaque
  // bundle it hands back on accept.
  'POST /api/builder/build': async req => {
    notStopped();
    const { person, org, members, turns, takenIds } = await body<{ person: string; org: string | null; members: string[]; turns: Turn[]; takenIds: string[] }>(req);
    const me = personFor(person);
    const ctx = await context(me, org, members);
    const b = await build(ctx, turns);
    if (org) await addNotes(org, b.profile_notes ?? []);
    if (me) await addPersonNotes(me, b.person_notes ?? []);
    return forApp(b, takenIds, new Set([...ctx.fleet.tools.map(t => t.id), ...integrationToolIds()]), ctx.models);
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
    await createAgent(await body<{ person: string; org: string | null; files: AgentFiles; setup?: { packId: string; index: number } }>(req));
    return { ok: true };
  },
  // --- Which models each agent runs on (models/choice.ts) ---
  // Everything connected that an agent could be given.
  'GET /api/models': async () => conn.availableModels(),
  'GET /api/agents/models': async () => allChoices(),
  // Whether a model really works on this account (models/check.ts).
  'GET /api/models/checks': async () => allChecks(),
  'POST /api/models/check': async req => {
    const { connection, model, force } = await body<{ connection: string; model: string; force?: boolean }>(req);
    if (typeof connection !== 'string' || typeof model !== 'string' || !connection || !model) throw new ConnectError('Which model?');
    const check = await checkModel(connection, model, !!force);
    // A check can learn a model's exact effort levels (OpenAI).
    return { check, available: await conn.availableModels() };
  },
  'POST /api/agents/models': async req => {
    const { id, choices } = await body<{ id: string; choices: unknown }>(req);
    if (!/^[a-z0-9-]+$/.test(id ?? '')) throw new ConnectError('Unknown agent.');
    return { choices: await setChoices(id, choices) };
  },

  // Every saved agent's set-up state and card details.
  'GET /api/agents/status': async () => {
    const out: Record<string, unknown> = {};
    for (const id of await listIds()) {
      const m = await readMeta(id);
      if (m) out[id] = { status: m.status, name: m.name, department: m.department, output: m.output, owner: m.owner ?? null, builtIn: !!m.builtIn, service: !!m.service };
    }
    return out;
  },
  'POST /api/agents/delete': async req => {
    const { id } = await body<{ id: string }>(req);
    await deleteAgent(id).catch(e => {
      throw new ConnectError((e as Error).message);
    });
    return { ok: true };
  },
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  // A run's tools, for Claude Code (runner/mcp.ts).
  if (url.pathname.startsWith('/mcp/') && (await handleMcp(req, res, url.pathname))) return;
  // The organisation's agency this computer hosts: passed on, and it checks who's
  // asking. Only from here, or with a token: without one it would take them for
  // this computer's own person.
  if (url.pathname.startsWith('/hosted/')) {
    const fromHere = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/.test(req.socket.remoteAddress ?? '');
    if (!fromHere && !req.headers.authorization) return send(res, 401, { error: 'Sign in first.' });
    return forwardToHosted(req, res, url.pathname.slice('/hosted'.length) + url.search);
  }
  const key = `${req.method} ${url.pathname}`;
  const runnerRoute = runnerRoutes[key];
  const route = routes[key];
  if (!route && !runnerRoute) return send(res, 404, { error: 'Not found' });
  try {
    // Who's asking, and whether they may (access.ts); the route runs as them.
    const actor = await actorFor(req);
    authorize(actor, req.method ?? 'GET', url.pathname);
    if (req.method !== 'GET') await readBody(req);
    const out = await asActor(actor, () => (runnerRoute ? runnerRoute(req, url.searchParams, () => body(req)) : route(req, url.searchParams)));
    if (req.method !== 'GET') recordAction(actor, req.method ?? '', url.pathname, bodies.get(req));
    if (out instanceof Html) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(out.body);
    }
    send(res, 200, out);
  } catch (e) {
    if (e instanceof AccessError) return send(res, e.status, { error: e.message });
    if (e instanceof BuilderError) return send(res, 502, { error: e.message });
    if (e instanceof ConnectError) return send(res, 400, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'Something went wrong on the server.' });
  }
  // An organisation's agency is reached through the person's own (hosting.ts), so only from this computer.
}).listen(PORT, HOSTED_ORG ? '127.0.0.1' : undefined, () => {
  console.log(`eaa server on http://localhost:${PORT}`);
  if (HOSTED_ORG && process.env.EAA_HOST_PERSON) setSetting('host_person', process.env.EAA_HOST_PERSON);
  resumeHosting();
  resume();
  void conn.recheckCapabilities();
  startScheduler();
  startAgencyMcp(); // the agency's own MCP server, for the person's AI IDE
  startHooks(book); // where services post events (and the tunnel, if it's on)
});
