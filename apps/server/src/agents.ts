import { parse as parseYaml } from 'yaml';
import { currentActor, personFor } from './access.js';
import { BASELINE, CATALOG_INDEX, toolId, toolTitle, type Tier } from './catalog.js';
import { kpiLabels, readMeta, remove, save, type AgentFiles } from './files.js';
import { scanFleet } from './fleet.js';
import { integrationToolIds, liveEventIds } from './integrations/index.js';
import { enqueue } from './jobs.js';
import { removeChoices, setChoices } from './models/choice.js';
import { FLEET_ENGINEER } from './runner/agent.js';
import { all, run as exec } from './runner/db.js';
import { forgetAgentRuns } from './runner/forget.js';
import { topUpModels } from './runner/defaults.js';
import { book } from './runner/scheduler.js';
import { fileRequest, registeredToolIds, requestConnections, serviceLabel } from './runner/tools.js';
import { needAccounts } from './runner/accounts.js';
import { siteOf } from './runner/passwords.js';

// Adding and removing agents: the app's builder and packs, and the agency's
// MCP server (runner/agency-mcp.ts) for an AI IDE, all come through here.

export async function createAgent(a: { person: string; org: string | null; files: AgentFiles; setup?: { packId: string; index: number } }) {
  const { org, files, setup } = a;
  // Someone signed in from their own app: it's theirs, whatever the request says.
  const maker = currentActor();
  const person = personFor(a.person);
  await save(files, {
    name: files.name,
    department: files.department,
    output: kpiLabels(files.kpi),
    status: setup ? 'setting-up' : 'ready',
    owner: person,
    ...(maker.via === 'token' ? { ownerId: maker.id } : {}),
    org,
    setup: setup && { ...setup, person, org, attempts: 0 },
  });
  await setChoices(files.id, await topUpModels(files.models ?? []));
  if (setup) enqueue(files.id);
  // A new agent starts stopped, in setup: its connectors are built and connected
  // first (the card's setup list); the person's first resume ends setup.
  exec(
    "INSERT INTO agent_state (agent_id, ferocity, state, setup, updated_at) VALUES (?, 1, 'stopped', 1, ?) ON CONFLICT(agent_id) DO UPDATE SET state = 'stopped', setup = 1, updated_at = excluded.updated_at",
    files.id,
    Date.now(),
  );
  const filed = await requestWhatsMissing(files);
  exec("UPDATE requests SET setup = 1 WHERE agent_id = ? AND run_id IS NULL AND status = 'open' AND (what LIKE 'Connect %' OR what LIKE 'Set up %')", files.id);
  return filed;
}

// Tools and events it needs that nothing provides yet go to the Agency Engineer:
// the ones its builder invented, and fleet tools it reuses that another agent
// invented and nobody has built. Each once while a request for it is open (a
// pack agent asks again after its tailoring; one remade under an old id asks
// afresh). Answers with what it asked for.
export async function requestWhatsMissing(files: Pick<AgentFiles, 'id' | 'name' | 'tools'>): Promise<string[]> {
  const yaml = parseYaml(files.tools) as {
    tool_tiers?: Record<string, string>;
    new_tools?: { id: string; description: string; input_schema: unknown }[];
    new_events?: { id: string; description: string; how?: string }[];
    accounts?: { site?: string; purpose?: string; how_many?: number }[];
  };
  const asked = new Set(all<{ what: string }>("SELECT what FROM requests WHERE agent_id = ? AND status = 'open'", files.id).map(r => r.what));
  const filed: string[] = [];
  const ask = (what: string, why: string, evidence: string | null, service?: string) => {
    if (asked.has(what)) return;
    asked.add(what);
    fileRequest(files.id, null, { what, why, evidence, service }, Date.now(), (agent, trigger, task) => book(agent, trigger as 'request', task), true);
    filed.push(what);
  };
  // Services its catalogue tools need that aren't connected, one request each.
  for (const what of requestConnections(files.id, files.name, (yaml.tool_tiers ?? {}) as Record<string, Tier>, Date.now(), (agent, trigger, task) => book(agent, trigger as 'request', task))) {
    asked.add(what);
    filed.push(what);
  }
  // Tools nothing provides yet - its builder's inventions, and another agent's
  // nobody has built - one request per service, not per tool: one job for the
  // Agency Engineer. None when that service already has a request open (it
  // sees every tool the agent is missing with it).
  const live = new Set(integrationToolIds());
  const own = new Map((yaml.new_tools ?? []).map(t => [t.id, t]));
  const fleet = await scanFleet(files.id);
  const registered = registeredToolIds();
  const missing = new Map<string, { id: string; does: string; input?: unknown; usedBy?: string[] }[]>();
  for (const id of new Set([...own.keys(), ...Object.keys(yaml.tool_tiers ?? {})])) {
    if (live.has(id)) continue;
    const mine = own.get(id);
    if (!mine && (registered.has(id) || CATALOG_INDEX.has(id) || BASELINE.some(b => toolId(b.server, b.tool.name) === id))) continue;
    const t = fleet.tools.find(x => x.id === id);
    const server = id.split('.')[0];
    // Its own reason for its own tools; for one it shares with another agent, the tool's
    // plain name - that agent's description says what *it* uses it for ("to find which
    // bike they ride" turned up on Workshop Overstays' request).
    missing.set(server, [...(missing.get(server) ?? []), { id, does: mine?.description ?? toolTitle(id), input: mine?.input_schema, usedBy: t?.usedBy }]);
  }
  // Events nothing provides yet: with that service's tools when it has some to
  // build (one job, one connection - Infrastructure SRE filed 13 requests), else
  // one request per service.
  const events = new Set(liveEventIds());
  const wanted = new Map<string, { id: string; description: string; how?: string }[]>();
  for (const e of (yaml.new_events ?? []).filter(e => !events.has(e.id))) wanted.set(e.id.split('.')[0], [...(wanted.get(e.id.split('.')[0]) ?? []), e]);
  const eventLines = (list: { id: string; description: string }[]) => list.map(e => `- ${e.id}: ${e.description}`).join('\n');
  const eventHow = (list: { id: string; how?: string }[]) => list.filter(e => e.how).map(e => `${e.id} - how the service tells it: ${e.how}`);
  for (const [server, tools] of missing) {
    const label = serviceLabel(server, files.id);
    if (asked.has(`Set up ${label}`) || asked.has(`Connect ${label}`)) continue;
    const others = [...new Set(tools.flatMap(t => t.usedBy ?? []))];
    const evs = wanted.get(server) ?? [];
    wanted.delete(server);
    // In the agent's own words; the tool ids and their inputs are for the engineer.
    ask(
      `Set up ${label}`,
      `I need ${label} to do my job, and nothing here connects to it yet. I'd use it to:\n${tools.map(t => `- ${t.does || t.id}`).join('\n')}${evs.length ? `\n\nAnd I'd like to be woken when:\n${evs.map(e => `- ${e.description}`).join('\n')}` : ''}`,
      [`Tools: ${tools.map(t => t.id).join(', ')}`, ...(evs.length ? [`Events: ${evs.map(e => e.id).join(', ')}`] : []), ...tools.filter(t => t.input).map(t => `${t.id} expects: ${JSON.stringify(t.input)}`), ...eventHow(evs), ...(others.length ? [`Also used by ${others.join(', ')}.`] : [])].join('\n') || null,
      server,
    );
  }
  for (const [server, list] of wanted) {
    const label = serviceLabel(server, files.id);
    // A connection already asked for (Set up Stripe): its events go on that request.
    const open = [`Set up ${label}`, `Connect ${label}`].find(w => asked.has(w));
    if (open) {
      exec(
        "UPDATE requests SET why = why || ?, evidence = TRIM(COALESCE(evidence, '') || ?) WHERE agent_id = ? AND what = ? AND status = 'open'",
        `\n\nAnd should wake when these happen:\n${eventLines(list)}`,
        eventHow(list).length ? `\n${eventHow(list).join('\n')}` : '',
        files.id,
        open,
      );
      continue;
    }
    ask(`Set up ${label} events`, `I'd like to be woken when:\n${list.map(e => `- ${e.description}`).join('\n')}`, [`Events: ${list.map(e => e.id).join(', ')}`, ...eventHow(list)].join('\n') || null, server);
  }
  for (const what of setupAccounts(files, yaml.accounts ?? [], asked)) filed.push(what);
  // GitHub connected already: the files its instructions name are checked now.
  void import('./runner/engineer.js').then(m => m.checkCharterFiles(files.id)).catch(() => {});
  return filed;
}

// The new website accounts it was built to need (TOOLS.yaml accounts), written down
// as owed (runner/accounts.ts). While it's in setup they're setup items on its card,
// one per site, and the Agency Engineer makes them: a request each, closed by the app
// once it has seen that site's accounts working. Out of setup, they're simply the
// agent's own to make. Asked again (a pack agent after its tailoring), nothing is doubled.
function setupAccounts(files: Pick<AgentFiles, 'id' | 'name'>, list: { site?: string; purpose?: string; how_many?: number }[], asked: Set<string>): string[] {
  const bySite = new Map<string, { site: string; purpose: string }[]>();
  for (const a of list) {
    if (!a || typeof a.site !== 'string' || !a.site.trim()) continue;
    let site: string;
    try {
      site = siteOf(a.site);
    } catch {
      continue;
    }
    const n = Math.max(1, Math.min(20, Math.round(Number(a.how_many) || 1)));
    const purpose = String(a.purpose ?? '').trim() || `An account on ${site}`;
    for (let i = 1; i <= n; i++) bySite.set(site, [...(bySite.get(site) ?? []), { site, purpose: n > 1 ? `${purpose} (${i} of ${n})` : purpose }]);
  }
  const now = Date.now();
  const inSetup = all<{ n: number }>("SELECT 1 AS n FROM agent_state WHERE agent_id = ? AND setup = 1 AND state = 'stopped'", files.id).length > 0;
  const filed: string[] = [];
  for (const [site, accounts] of bySite) {
    if (!inSetup) {
      needAccounts(files.id, accounts, now);
      continue;
    }
    const what = accounts.length > 1 ? `Make ${accounts.length} ${site} accounts` : `Make a ${site} account`;
    let request = all<{ id: number }>("SELECT id FROM requests WHERE agent_id = ? AND what = ? AND status = 'open'", files.id, what)[0]?.id;
    if (request == null) {
      request = fileRequest(
        files.id,
        null,
        {
          what,
          why: `I can't start my job without ${accounts.length > 1 ? 'these accounts' : 'this account'} on ${site}:\n${accounts.map(a => `- ${a.purpose}`).join('\n')}`,
          evidence: `New ${accounts.length > 1 ? 'accounts' : 'account'}, signed up for by the agency in the browser. The only part for a person is a check a site insists on (a CAPTCHA, a code), asked for once, for all of them together.`,
        },
        now,
        (agent, trigger, task) => book(agent, trigger as 'request', task),
        true,
      );
      // On its card, as one item it can't start without.
      exec('UPDATE requests SET setup = 1, setup_name = ?, stars = 5 WHERE id = ?', `${site} ${accounts.length > 1 ? 'accounts' : 'account'}`, request);
      asked.add(what);
      filed.push(what);
    }
    needAccounts(files.id, accounts, now, request);
  }
  return filed;
}

export async function deleteAgent(id: string) {
  const m = await readMeta(id);
  if (id === FLEET_ENGINEER || m?.builtIn) throw new Error(`The ${m?.name ?? 'Agency Engineer'} is part of the agency; it can't be deleted.`);
  await remove(id);
  await removeChoices(id);
  await forgetAgentRuns(id);
  // What it still owed is nobody's now (accounts that work stay, in the password store).
  exec("UPDATE accounts SET state = 'cancelled', last_error = 'Its agent was deleted.', updated_at = ? WHERE agent_id = ? AND state NOT IN ('working', 'cancelled')", Date.now(), id);
}
