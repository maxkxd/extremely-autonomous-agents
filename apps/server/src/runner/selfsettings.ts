import { readMeta } from '../files.js';
import { getSetting, run, setSetting } from './db.js';
import { hostZone } from './clock.js';
import { LEVELS } from './ferocity.js';
import type { ToolDef } from './tools.js';

// What a person can change on an agent's card, changed by the agent when they ask
// in its chat ("slow down", "stop until Monday", "only on weekdays", "use Claude
// for this") - before, it had no way to and might say it did. Who may message an
// agent is already its maker or an admin (runner/api.ts), so asking is enough.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const RESUME_AT = 'resume_at'; // agent -> when it goes back to active
const RUN_DAYS = 'run_days'; // agent -> the weekdays its schedule runs on (0 = Sunday)

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

async function notBuiltIn(agentId: string) {
  const meta = await readMeta(agentId);
  if (meta?.builtIn || meta?.service) throw new Error('A built-in agent keeps its own settings.');
}

// Its weekday now, where the host is.
export function weekday(now: number): number {
  const name = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: hostZone() }).format(now).toLowerCase().slice(0, 3);
  return Math.max(0, DAYS.indexOf(name as (typeof DAYS)[number]));
}

// Whether its schedule runs today (a person's messages, Run now and its own
// bookings are never held back by this).
export function runsToday(agentId: string, now: number): boolean {
  const days = getSetting<Record<string, number[]>>(RUN_DAYS, {})[agentId];
  return !days?.length || days.includes(weekday(now));
}

// Paused "until Monday": back to active when that time comes (scheduler tick).
export function resumeDue(now: number): string[] {
  const all = getSetting<Record<string, number>>(RESUME_AT, {});
  const due = Object.entries(all).filter(([, at]) => at <= now).map(([id]) => id);
  if (!due.length) return [];
  for (const id of due) {
    run("UPDATE agent_state SET state = 'active', updated_at = ? WHERE agent_id = ? AND state != 'active'", now, id);
    delete all[id];
  }
  setSetting(RESUME_AT, all);
  return due;
}

// A person resuming or stopping it themselves overrides a pause it set.
export const clearResume = (agentId: string) => {
  const all = getSetting<Record<string, number>>(RESUME_AT, {});
  if (agentId in all) {
    delete all[agentId];
    setSetting(RESUME_AT, all);
  }
};

export const SELF_SETTINGS: ToolDef[] = [
  {
    id: 'ops.set_my_ferocity',
    tier: 'T1',
    description: `Change how hard you work, when your person asks ("slow down", "go flat out"): ${LEVELS.join(', ')} - slowest to fastest. Same as the slider on your card.`,
    schema: obj({ level: { type: 'string', enum: [...LEVELS] } }, ['level']),
    impl: async (a, ctx) => {
      await notBuiltIn(ctx.agent.id);
      const level = LEVELS.indexOf(String(a.level) as (typeof LEVELS)[number]);
      if (level < 0) throw new Error(`level is one of ${LEVELS.join(', ')}.`);
      run('UPDATE agent_state SET ferocity = ?, updated_at = ? WHERE agent_id = ?', level, ctx.now(), ctx.agent.id);
      return `You're on ${LEVELS[level]} now.`;
    },
  },
  {
    id: 'ops.pause_me',
    tier: 'T1',
    description:
      'Pause yourself when your person asks ("stop until Monday", "take a break"). standby: no runs of your own, but you still answer them; stop: nothing at all until resumed. until: when to start again by yourself (an ISO date-time, host time) - leave it out to wait for a person to resume you on your card.',
    schema: obj({ how: { type: 'string', enum: ['standby', 'stop'] }, until: { type: 'string', description: 'ISO date-time, e.g. 2026-11-09T09:00' } }, ['how']),
    impl: async (a, ctx) => {
      await notBuiltIn(ctx.agent.id);
      const state = a.how === 'stop' ? 'stopped' : 'draining';
      let until: number | null = null;
      if (a.until) {
        until = Date.parse(String(a.until));
        if (!Number.isFinite(until) || until <= ctx.now()) throw new Error('until is a date-time in the future, like 2026-11-09T09:00.');
      }
      run('UPDATE agent_state SET state = ?, updated_at = ? WHERE agent_id = ?', state, ctx.now(), ctx.agent.id);
      const all = getSetting<Record<string, number>>(RESUME_AT, {});
      if (until) all[ctx.agent.id] = until;
      else delete all[ctx.agent.id];
      setSetting(RESUME_AT, all);
      const how = state === 'stopped' ? 'stopped' : 'on standby';
      return until ? `You're ${how} until ${new Date(until).toLocaleString('en-AU', { timeZone: hostZone() })}, then back on by yourself.` : `You're ${how} until a person resumes you on your card.`;
    },
  },
  {
    id: 'ops.set_my_run_days',
    tier: 'T1',
    description: 'Set which days your schedule runs, when your person asks ("only on weekdays"). Messages, Run now and runs you book still happen any day. Empty: every day.',
    schema: obj({ days: { type: 'array', items: { type: 'string', enum: [...DAYS] } } }, ['days']),
    impl: async (a, ctx) => {
      await notBuiltIn(ctx.agent.id);
      const days = [...new Set((Array.isArray(a.days) ? a.days : []).map(d => DAYS.indexOf(String(d).toLowerCase().slice(0, 3) as (typeof DAYS)[number])).filter(d => d >= 0))].sort();
      const all = getSetting<Record<string, number[]>>(RUN_DAYS, {});
      if (days.length && days.length < 7) all[ctx.agent.id] = days;
      else delete all[ctx.agent.id];
      setSetting(RUN_DAYS, all);
      return days.length && days.length < 7 ? `Your schedule runs on ${days.map(d => DAYS[d]).join(', ')} only.` : 'Your schedule runs every day.';
    },
  },
  {
    id: 'ops.set_my_models',
    tier: 'T1',
    description:
      'Change the AI models you run on, when your person asks ("use Claude for this"): up to three, in order, from the connected ones (call it with no models to see them). Same as the models on your card.',
    schema: obj({ models: { type: 'array', items: obj({ connection: { type: 'string' }, model: { type: 'string' } }, ['connection', 'model']) } }),
    impl: async (a, ctx) => {
      await notBuiltIn(ctx.agent.id);
      const { availableModels } = await import('../models/connections.js');
      const { allChoices, setChoices } = await import('../models/choice.js');
      const avail = await availableModels();
      const list = avail.flatMap(c => c.models.map(m => `${c.connection} / ${m} (${c.name})`));
      const want = Array.isArray(a.models) ? (a.models as { connection?: string; model?: string }[]) : [];
      if (!want.length) return `Connected models (connection / model):\n${list.join('\n') || 'none'}`;
      const picked = want.slice(0, 3).map(w => {
        const c = avail.find(x => x.connection === w.connection);
        if (!c || !c.models.includes(String(w.model))) throw new Error(`${w.connection} / ${w.model} isn't connected. Connected:\n${list.join('\n')}`);
        return { connection: c.connection, model: String(w.model), effort: 'medium' as const };
      });
      const before = (await allChoices())[ctx.agent.id] ?? [];
      // Its effort per model stays as it was where the model is the same.
      await setChoices(ctx.agent.id, picked.map(p => ({ ...p, effort: before.find(b => b.connection === p.connection && b.model === p.model)?.effort ?? p.effort })));
      return `You run on ${picked.map(p => p.model).join(', then ')} now.`;
    },
  },
];
