import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { listIds } from '../files.js';
import { anyEvent, everyEvent, liveEvents, webhookSecret, type EventSource } from '../integrations/index.js';
import { at, requestJson, type Fetcher } from '../integrations/http.js';
import { loadAgent } from './agent.js';
import { all, getSetting, one, run as exec, setSetting } from './db.js';
import { agencyStopped, type Trigger } from './run.js';

// Events (docs/events.md): something happening at a service wakes the agents
// subscribed to it, like a schedule does - a new Sentry issue, a ticket, an
// alarm. An integration defines its events; an agent subscribes to them in its
// TOOLS.yaml (events: [...]), like it holds tools. Each is detected by polling
// the service's API for new items, or pushed to a webhook address, or both.
// Every item is told once: the first poll only notes what's already there.
// While the agency is stopped nothing is polled (the next poll catches up); a
// webhook post is still taken, and the run it books waits.

type Book = (agentId: string, trigger: Trigger, task: string | null) => void;
export type Item = { id: string; summary: Record<string, unknown> };

const MAX_SHOWN = 10; // items written out in one wake; the rest are counted
const MAX_SUMMARY = 600; // characters of each

// --- Items ---------------------------------------------------------------------------

// The items in an answer or a post: the list at `itemsPath` (or the whole thing,
// when it's a list or there's no path), each with its id and what the agent sees.
export function itemsFrom(body: unknown, itemsPath: string | undefined, idPath: string | undefined, fields: Record<string, string> | undefined): Item[] {
  const list = itemsPath ? at(body, itemsPath) : body;
  const raw = Array.isArray(list) ? list : itemsPath ? [] : [body];
  return raw
    .filter(x => x !== null && x !== undefined)
    .map(item => {
      const idv = idPath ? at(item, idPath) : undefined;
      const id = idv !== undefined && idv !== null && idv !== '' ? String(idv) : createHash('sha256').update(JSON.stringify(item)).digest('hex').slice(0, 24);
      const summary = fields
        ? Object.fromEntries(Object.entries(fields).map(([name, path]) => [name, at(item, path)]).filter(([, v]) => v !== undefined && v !== null && v !== ''))
        : typeof item === 'object'
          ? (item as Record<string, unknown>)
          : { value: item };
      return { id, summary };
    });
}

const line = (s: Record<string, unknown>) => {
  const text = JSON.stringify(s);
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text;
};

// --- Who's woken ---------------------------------------------------------------------

// Every agent subscribed to each event.
async function subscriptions(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const id of await listIds()) {
    const agent = await loadAgent(id);
    for (const e of agent?.events ?? []) out.set(e, [...(out.get(e) ?? []), id]);
  }
  return out;
}

// New items: noted, and each subscribed agent woken. A wake still waiting to
// run (the agent busy, stopped, on standby) takes the new items too, so a
// burst is one run, not dozens.
export async function deliver(src: EventSource, source: 'poll' | 'webhook', items: Item[], book: Book, now = Date.now(), subs?: Map<string, string[]>) {
  const fresh = items.filter(
    i => exec('INSERT OR IGNORE INTO event_items (event_id, item_id, source, summary, at) VALUES (?, ?, ?, ?, ?)', src.event.id, i.id, source, line(i.summary), now).changes > 0,
  );
  if (!fresh.length) return { fresh: 0, woke: [] as string[] };
  const agents = (subs ?? (await subscriptions())).get(src.event.id) ?? [];
  const shown = fresh.slice(0, MAX_SHOWN).map(i => `- ${line(i.summary)}`).join('\n');
  const more = fresh.length > MAX_SHOWN ? `\n(and ${fresh.length - MAX_SHOWN} more)` : '';
  const block = `${src.integration.name} - ${src.event.description} (${src.event.id}): ${fresh.length} new\n${shown}${more}`;
  for (const agentId of agents) {
    const waiting = one<{ id: number; task: string | null }>("SELECT id, task FROM bookings WHERE agent_id = ? AND trigger = 'event' ORDER BY id LIMIT 1", agentId);
    if (waiting) exec('UPDATE bookings SET task = ? WHERE id = ?', `${waiting.task ?? ''}\n\n${block}`.trim().slice(-12000), waiting.id);
    else book(agentId, 'event', block);
  }
  return { fresh: fresh.length, woke: agents };
}

// --- Polling -------------------------------------------------------------------------

type PollState = { last?: number; baselined?: boolean; error?: string | null; found?: number };
const POLLS = 'event_polls';
const polls = () => getSetting<Record<string, PollState>>(POLLS, {});
const putPoll = (id: string, s: PollState) => setSetting(POLLS, { ...polls(), [id]: s });

async function pollOnce(src: EventSource, fetcher?: Fetcher): Promise<Item[]> {
  const p = src.event.poll!;
  const base = p.base_url ?? (src.integration.kind === 'http' ? src.integration.base_url : undefined);
  if (!base) throw new Error(`${src.event.id} polls without a base_url, and ${src.integration.name} has none.`);
  const body = await requestJson(base, p.request, src.integration.auth, await src.key(), src.integration.name, fetcher);
  if (p.items && !Array.isArray(at(body, p.items))) throw new Error(`The answer has no list at "${p.items}".`);
  if (!p.items && !Array.isArray(body)) throw new Error('The answer isn\'t a list: give "items", the path to it.');
  return itemsFrom(body, p.items, p.id, p.fields);
}

// Every event that's due and has someone listening. Run each tick.
let polling = false;
export async function pollEvents(book: Book, now = Date.now(), fetcher?: Fetcher, sources: EventSource[] = liveEvents()) {
  if (polling || agencyStopped()) return;
  polling = true;
  try {
    const subs = await subscriptions();
    for (const src of sources) {
      const p = src.event.poll;
      if (!p || !subs.get(src.event.id)?.length) continue;
      const st = polls()[src.event.id] ?? {};
      if (st.last !== undefined && now - st.last < p.every_minutes * 60_000) continue;
      try {
        const items = await pollOnce(src, fetcher);
        if (!st.baselined) {
          // The first poll: what's there already isn't news.
          for (const i of items) exec("INSERT OR IGNORE INTO event_items (event_id, item_id, source, summary, at) VALUES (?, ?, 'baseline', ?, ?)", src.event.id, i.id, line(i.summary), now);
          putPoll(src.event.id, { last: now, baselined: true, error: null, found: 0 });
        } else {
          const r = await deliver(src, 'poll', items, book, now, subs);
          putPoll(src.event.id, { last: now, baselined: true, error: null, found: (st.found ?? 0) + r.fresh });
        }
      } catch (e) {
        putPoll(src.event.id, { ...st, last: now, error: (e as Error).message.slice(0, 300) });
      }
    }
  } finally {
    polling = false;
  }
}

// --- Webhooks ------------------------------------------------------------------------

const HOOKS = 'event_hooks'; // token -> event id
export function hookToken(eventId: string): string {
  const hooks = getSetting<Record<string, string>>(HOOKS, {});
  const found = Object.entries(hooks).find(([, e]) => e === eventId)?.[0];
  if (found) return found;
  const token = randomBytes(18).toString('hex');
  setSetting(HOOKS, { ...hooks, [token]: eventId });
  return token;
}

export function verifySignature(raw: Buffer, given: string | undefined, secret: string, sig: { algorithm: 'sha256' | 'sha1'; prefix?: string; encoding: 'hex' | 'base64' }): boolean {
  if (!given) return false;
  const value = sig.prefix && given.startsWith(sig.prefix) ? given.slice(sig.prefix.length) : given;
  const want = createHmac(sig.algorithm, secret).update(raw).digest(sig.encoding);
  const a = Buffer.from(value.trim());
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// A post to /hooks/<token>. Answers with an HTTP status and a short message.
export async function handleHook(token: string, raw: Buffer, headers: Record<string, string | string[] | undefined>, book: Book, now = Date.now(), sources: EventSource[] = liveEvents()) {
  const eventId = getSetting<Record<string, string>>(HOOKS, {})[token];
  const live = eventId ? sources.find(s => s.event.id === eventId && s.event.webhook) : undefined;
  // Not live yet (the Fleet Engineer is still building it): taken and kept, so it
  // can see what the service sends, but nobody is woken.
  const draft = !live && eventId ? everyEvent().find(s => s.event.id === eventId && s.event.webhook) : undefined;
  const src = live ?? draft;
  if (!src) return { status: 404, message: 'No such event.' };
  const hook = src.event.webhook!;
  if (hook.signature) {
    const secret = await webhookSecret(src.integration.id);
    if (!secret) return { status: 401, message: 'No signing secret saved for it in Settings.' };
    const given = headers[hook.signature.header.toLowerCase()];
    if (!verifySignature(raw, Array.isArray(given) ? given[0] : given, secret, hook.signature)) return { status: 401, message: 'Bad signature.' };
  }
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    // Not JSON (some services post form data): the text is the item.
    body = { body: raw.toString('utf8').slice(0, 4000) };
  }
  const items = itemsFrom(body, hook.items, hook.id, hook.fields);
  if (draft) {
    for (const i of items) exec("INSERT OR IGNORE INTO event_items (event_id, item_id, source, summary, at) VALUES (?, ?, 'draft', ?, ?)", src.event.id, i.id, line(i.summary), now);
    return { status: 202, message: 'Not live yet: kept, nobody woken.' };
  }
  const r = await deliver(src, 'webhook', items, book, now);
  return { status: 200, message: `${r.fresh} new` };
}

// --- For the engineer, the person and the app ---------------------------------------

// Tries an event without telling anyone: a poll, and where its webhook goes.
export async function checkEvent(integrationId: string, eventId: string, hooksBase: string, fetcher?: Fetcher): Promise<string> {
  const src = anyEvent(integrationId, eventId);
  if (!src) throw new Error(`${integrationId} has no event "${eventId}" (engineer.read_integration shows its definition).`);
  const out: string[] = [];
  if (src.event.poll) {
    const items = await pollOnce(src, fetcher);
    out.push(
      `Polling works: ${items.length} item${items.length === 1 ? '' : 's'} there now${items.length ? `, e.g. ${line(items[0].summary)} (id ${items[0].id})` : ''}. Once live, it checks every ${src.event.poll.every_minutes} minutes; what's there when it starts isn't news, only what comes after.`,
    );
  }
  if (src.event.webhook) {
    const posts = all<{ summary: string }>("SELECT summary FROM event_items WHERE event_id = ? AND source IN ('draft', 'webhook') ORDER BY at DESC LIMIT 3", eventId);
    if (posts.length) out.push(`Posts received so far, as the agent would see them (newest first):\n${posts.map(p => `- ${p.summary}`).join('\n')}`);
  }
  if (src.event.webhook)
    out.push(
      `Webhook address: ${hooksBase}/hooks/${hookToken(eventId)}${src.event.webhook.signature ? ` (posts are checked against the signing secret ${src.integration.name} gives, saved in Settings -> Connectors)` : ''}. The person pastes it into ${src.integration.name}${src.event.setup_help ? `: ${src.event.setup_help}` : ''}.`,
    );
  return out.join('\n');
}

// Every event agents can subscribe to: who listens, how it's doing, its webhook address.
export async function eventOverview(hooksBase: string) {
  const subs = await subscriptions();
  const st = polls();
  return everyEvent().map(({ integration, event, live }) => ({
    id: event.id,
    integration: integration.id,
    live,
    description: event.description,
    agents: subs.get(event.id) ?? [],
    poll: event.poll ? { everyMinutes: event.poll.every_minutes, last: st[event.id]?.last ?? null, error: st[event.id]?.error ?? null } : null,
    webhook: event.webhook ? `${hooksBase}/hooks/${hookToken(event.id)}` : null,
    told: one<{ n: number }>("SELECT COUNT(*) AS n FROM event_items WHERE event_id = ? AND source IN ('poll', 'webhook')", event.id)?.n ?? 0,
  }));
}

export const recentEventItems = (eventId: string, limit = 20) =>
  all<{ item_id: string; source: string; summary: string; at: number }>('SELECT item_id, source, summary, at FROM event_items WHERE event_id = ? ORDER BY at DESC LIMIT ?', eventId, limit);
