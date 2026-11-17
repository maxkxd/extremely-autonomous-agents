import { FLEET_ENGINEER } from './agent.js';
import { all, one, run as exec } from './db.js';
import type { Trigger } from './run.js';

// Waking an agent, debounced (docs/runner.md). Agents woke each other one event at a
// time: a week of usage had ~60% of its cost in runs started by a single handoff, a
// single request done, one request each for the Agency Engineer (385 runs) - each run
// paying again to read its instructions, memory and tools. Now every event-driven wake
// waits a moment after the latest event and joins the one already waiting, so a burst
// is one run that hears everything.

// The events that wake an agent and are debounced. Not 'run now' (a person pressed it:
// this minute), nor its schedule, Apocalyptic or a run it booked itself (they're its pace).
export const DEBOUNCED = [
  'handoff',
  'request',
  'request reply',
  'request done',
  'turned down',
  'task done',
  'approval',
  'event',
  'connected',
  'connection failed',
  'your message',
] as const satisfies readonly Trigger[];
export type Debounced = (typeof DEBOUNCED)[number];
export const isDebounced = (t: string): t is Debounced => (DEBOUNCED as readonly string[]).includes(t);

// A wake is due settleMs after the latest event, but never later than maxMs after the
// first: a steady stream is still heard. Mutable so tests can shorten them.
export type WakeWindow = { settleMs: number; maxMs: number };
export const WAKE_WINDOWS: Record<Debounced, WakeWindow> = {
  // Agents' own traffic (handoffs, requests, results, events): a minute's quiet gathers a
  // burst - a fleet handing work round, the Conductor routing 50 requests - into one run;
  // five minutes at most, so nothing handed over sits for long.
  ...(Object.fromEntries(DEBOUNCED.map(t => [t, { settleMs: 60_000, maxMs: 5 * 60_000 }])) as Record<Debounced, WakeWindow>),
  // A person deciding approvals: 50 in a minute wake it once, not 50 times (or 10: a
  // run on the first few, another for the ones decided meanwhile...).
  approval: { settleMs: 45_000, maxMs: 10 * 60_000 },
  // A person's DM: they're waiting on the reply, so only a few seconds - enough that
  // three quick messages in a row are answered in one run.
  'your message': { settleMs: 8_000, maxMs: 30_000 },
};

// A wake's text is capped: past this, a pointer to where the rest is listed.
export const MAX_WAKE_CHARS = 12_000;

// --- Several events in one booking ------------------------------------------------
//
// A booking that has gathered several events keeps them in its task as one text, each
// under its own heading ("— Handoff:", "— Request #12 done:"), so the run, the app (a
// queued run's task) and a run a person stopped (booked again with the same text) all
// see the same thing, and the parts can be taken apart again (dropStaleRequestRuns).

export const MERGED_INTRO = 'Several things came in for you together. Each is below under its own heading:';
export type Part = { trigger: Debounced | 'more'; text: string };

const LABELS: Record<Debounced, string> = {
  handoff: 'Handoff',
  request: 'New request',
  'request reply': 'Reply on request',
  'request done': 'Request done',
  'turned down': 'Turned down',
  'task done': 'Task done',
  approval: 'Approval',
  event: 'Event',
  connected: 'Connected',
  'connection failed': 'Connection failed',
  'your message': 'Message',
};
const BY_LABEL = new Map<string, Part['trigger']>([...Object.entries(LABELS).map(([t, l]) => [l, t as Debounced] as const), ['More', 'more']]);

// The request an event is about ("Request #4 from ...", "... replied on request #4: ...").
export const requestOf = (text: string | null) => Number(/request #(\d+)/i.exec(text ?? '')?.[1]) || null;

export function wakeLabel(p: Part): string {
  if (p.trigger === 'more') return 'More';
  const n = ['request', 'request reply', 'request done'].includes(p.trigger) ? requestOf(p.text) : null;
  if (!n) return LABELS[p.trigger];
  return p.trigger === 'request done' ? `Request #${n} done` : `${LABELS[p.trigger]} #${n}`;
}

export const isMerged = (task: string | null) => !!task?.startsWith(MERGED_INTRO);

export function formatWake(parts: Part[]): string {
  if (parts.length === 1 && parts[0].trigger !== 'more') return parts[0].text;
  return MERGED_INTRO + parts.map(p => `\n\n— ${wakeLabel(p)}:\n${p.text}`).join('');
}

const HEADING = /\n\n— ([^\n]{1,80}):\n/;
export function parseWake(trigger: string, task: string | null): Part[] {
  if (!isMerged(task)) return [{ trigger: trigger as Debounced, text: task ?? '' }];
  const chunks = task!.slice(MERGED_INTRO.length).split(new RegExp(HEADING.source, 'g'));
  const parts: Part[] = [];
  for (let i = 1; i < chunks.length; i += 2) {
    const label = chunks[i];
    const t = BY_LABEL.get(label.replace(/ #\d+/, ''));
    // A heading-like line inside an event's own text: part of the one before.
    if (!t && parts.length) parts[parts.length - 1].text += `\n\n— ${label}:\n${chunks[i + 1]}`;
    else parts.push({ trigger: t ?? (trigger as Debounced), text: chunks[i + 1] ?? '' });
  }
  return parts.length ? parts : [{ trigger: trigger as Debounced, text: task ?? '' }];
}

// The trigger a booking of these parts runs as: its first event's - except a person's
// message anywhere in it, which makes it a person's message (answered first, and its
// reply posted to them).
export function triggerFor(parts: Part[], fallback: Trigger): Trigger {
  if (parts.some(p => p.trigger === 'your message')) return 'your message';
  return parts.find(p => p.trigger !== 'more')?.trigger as Trigger | undefined ?? fallback;
}

const morePointer = (agentId: string) =>
  agentId === FLEET_ENGINEER
    ? "More came in after these than fits here. engineer.list_requests has every open request and its replies; approvals.queue_mine how your approvals went."
    : 'More came in after these than fits here. tasks.list_my_tasks lists the work handed to you, approvals.queue_mine how your approvals went (with recent failures), and answers to your requests are under "Since your last run".';

type Waiting = { id: number; trigger: string; task: string | null; due_at: number; created_at: number };

// Books a wake: joins the one already waiting for this agent, or starts one.
//   A person's message joins only that person's waiting messages (one chat per person
//   with the Agency Engineer), as plain text: it's quoted to the agent as what they wrote.
//   Anything else joins the agent's waiting event wake, whatever its kind - one run hears
//   a handoff, two requests done and an approval together - and never a person's message
//   (their reply is posted to them, and they shouldn't wait on a handoff's work).
// at: when the event happened (now, but for tests).
export function bookWake(agentId: string, trigger: Debounced, task: string | null, at: number, person: string | null) {
  const w = WAKE_WINDOWS[trigger];
  const dm = trigger === 'your message';
  const others = DEBOUNCED.filter(t => t !== 'your message');
  const waiting = dm
    ? one<Waiting>("SELECT id, trigger, task, due_at, created_at FROM bookings WHERE agent_id = ? AND trigger = 'your message' AND person_id IS ? ORDER BY id LIMIT 1", agentId, person)
    : one<Waiting>(`SELECT id, trigger, task, due_at, created_at FROM bookings WHERE agent_id = ? AND person_id IS NULL AND trigger IN (${others.map(() => '?').join(', ')}) ORDER BY id LIMIT 1`, agentId, ...others);
  if (!waiting) {
    exec('INSERT INTO bookings (agent_id, trigger, task, due_at, created_at, person_id) VALUES (?, ?, ?, ?, ?, ?)', agentId, trigger, task, at + w.settleMs, at, person);
    return;
  }
  // Due a settle after this event, but no later than the max after the first.
  const due = Math.min(waiting.created_at + w.maxMs, Math.max(waiting.due_at, at + w.settleMs));
  let text: string | null;
  let as = waiting.trigger;
  if (dm) {
    const more = '\n\n(More messages came after these: the rest are in your DM channel.)';
    const joined = `${waiting.task ?? ''}\n\n${task ?? ''}`;
    text = joined.length <= MAX_WAKE_CHARS ? joined : waiting.task?.endsWith(more) ? waiting.task : `${waiting.task ?? ''}${more}`;
  } else {
    const parts = parseWake(waiting.trigger, waiting.task);
    const added = [...parts, { trigger, text: task ?? '' }];
    if (formatWake(added).length <= MAX_WAKE_CHARS && parts[parts.length - 1].trigger !== 'more') {
      text = formatWake(added);
      as = triggerFor(added, waiting.trigger as Trigger);
    } else text = parts[parts.length - 1].trigger === 'more' ? waiting.task : formatWake([...parts, { trigger: 'more', text: morePointer(agentId) }]);
  }
  exec('UPDATE bookings SET task = ?, trigger = ?, due_at = ? WHERE id = ?', text, as, due, waiting.id);
}

// Takes the parts that no longer need a run out of an agent's waiting wakes (work it's
// already been told about, a request since closed): the rest still run; a booking with
// nothing left goes.
export function dropWakeParts(agentId: string, stale: (p: Part, b: { created_at: number }) => boolean) {
  const rows = all<{ id: number; trigger: string; task: string | null; created_at: number }>('SELECT id, trigger, task, created_at FROM bookings WHERE agent_id = ?', agentId);
  for (const b of rows) {
    if (!isDebounced(b.trigger)) continue;
    const parts = parseWake(b.trigger, b.task);
    const keep = parts.filter(p => p.trigger === 'more' || !stale(p, b));
    if (keep.length === parts.length) continue;
    if (!keep.some(p => p.trigger !== 'more')) exec('DELETE FROM bookings WHERE id = ?', b.id);
    else exec('UPDATE bookings SET task = ?, trigger = ? WHERE id = ?', formatWake(keep), triggerFor(keep, b.trigger as Trigger), b.id);
  }
}
