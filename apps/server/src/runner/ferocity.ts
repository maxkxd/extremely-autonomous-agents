import type { AgentDef } from './agent.js';

// The five ferocity levels (docs/runner.md): what each one tells the agent,
// its floor and nudges, and when its next run is due. Names are final; the
// wording is the first draft to test against real agents.

export const LEVELS = ['Chill', 'Steady', 'Driven', 'Relentless', 'Apocalyptic'] as const;
export const CHILL = 0;
export const STEADY = 1;
export const DRIVEN = 2;
export const RELENTLESS = 3;
export const APOCALYPTIC = 4;

export const MAX_NUDGES = 4;

// How readily it asks for things (docs/requests.md, "Ferocity and requests").
const REQUEST_STANCE = [
  'Make do with the tools you have. Only file a request when you are genuinely blocked and cannot do the work at all any other way.',
  'File a request when a tool or resource would make you clearly more effective at your core job, not just when you are blocked.',
  'Actively look for tools, access and data that would increase your output, and request the ones with a clear payoff.',
  'Treat every limit on your output as something to remove. Request any tool, channel or access that would let you do more or go faster.',
  'Maximise output by any means available. Think of every possible way to get more of your work done and request whatever it takes - new channels, new tools, more access. You can only ask: everything you request still needs a human or the Agency Engineer to grant it.',
];

// Looking for better ways to do the job: every run, from Driven up.
const IMPROVE = `Every run, besides the work itself, look for ways to do your job better: better sources, a tool you don't have yet, a wider scope that still serves your mission, a smarter way to do what you already do. File a request for anything that would help. A run that never looks up from the routine is not doing your job.`;

// The floor for this run, if its level has one, and what counts toward it.
export function floorFor(agent: AgentDef, level: number): { floor: number; nudges: number; soft: boolean } | null {
  const plan = agent.ferocity;
  if (!plan.counts.length) return null; // nothing to count
  if (level === DRIVEN) return { floor: plan.soft_floor, nudges: 1, soft: true };
  if (level === RELENTLESS) return { floor: plan.floor, nudges: MAX_NUDGES, soft: false };
  if (level === APOCALYPTIC) return { floor: plan.apocalyptic_floor, nudges: MAX_NUDGES, soft: false };
  return null;
}

// What the agent is told about how hard to work, by level.
export function ferocityInstructions(agent: AgentDef, level: number): string {
  const plan = agent.ferocity;
  const counted = plan.counts.join(', ');
  const f = floorFor(agent, level);
  const lines = [`## How hard you work: ${LEVELS[level]}`];
  switch (level) {
    case CHILL:
      lines.push(
        'Do your job properly and stop when it is done. Your next scheduled run is coming, so leave anything that can wait for it.',
        'You may book an extra run (ops.book_next_run) only when real work is left that cannot wait. Once your work is done, do not book one.',
      );
      break;
    case STEADY:
      lines.push(
        'Do your job properly. If anything you could usefully do is still open at the end of this run, book your next run (ops.book_next_run) naming it, rather than leaving it for the schedule.',
      );
      break;
    case DRIVEN:
      lines.push(
        IMPROVE,
        'Book your next run (ops.book_next_run) whenever there is more to do.',
        f ? `A good run here makes at least ${f.floor} output actions (${counted}).` : '',
      );
      break;
    case RELENTLESS:
      lines.push(
        'Volume of finished work matters more than token efficiency. Keep going until there is genuinely nothing useful left.',
        f ? `Every run has a floor of ${f.floor} output actions (${counted}); keep working until you reach it.` : '',
        IMPROVE,
        'Before you end a run, if any work is left, book your next run (ops.book_next_run) naming it. Chaining runs is expected; do not set yourself a lower limit.',
      );
      break;
    case APOCALYPTIC:
      lines.push(
        'Maximum output. Volume of finished work matters far more than token efficiency.',
        f ? `Every run has a floor of ${f.floor} output actions (${counted}). It is set high on purpose: push as far toward it as you can.` : '',
        IMPROVE,
        'Your next run starts as soon as this one ends, so you never need to book one.',
      );
      break;
  }
  if (level > CHILL) lines.push(`What extra effort means for your job: ${plan.extra_effort}`);
  lines.push(`Requests: ${REQUEST_STANCE[level]}`);
  return lines.filter(Boolean).join('\n\n');
}

// The message sent when a run would end below its floor (WAR's output floor).
export function nudgeText(agent: AgentDef, acts: number, floor: number, n: number, of: number, soft: boolean): string {
  if (soft)
    return `Before you finish: this run has made ${acts} output action(s), and a good run at your level makes at least ${floor}. If there is more you can usefully do, carry on: ${agent.ferocity.hint} If there genuinely isn't, write your summary.`;
  return [
    `Not finished. This run has made ${acts} output action(s); the floor for every run is ${floor}. Carry on now:`,
    agent.ferocity.hint,
    `Keep going until you reach ${floor}, then write your summary. (Continuation ${n} of ${of}.)`,
  ].join('\n');
}

// --- When the next run is due -------------------------------------------------

export const HOUR = 3_600_000;
export const APOCALYPTIC_GAP_MS = 20_000; // a breath between back-to-back runs

// When its schedule next wants a run (null: no schedule, i.e. Apocalyptic).
export function scheduledDue(agent: AgentDef, level: number, lastScheduledAt: number | null, now: number): number | null {
  if (level === APOCALYPTIC) return null;
  const every = agent.ferocity.every_hours[level] * HOUR;
  // Never run on its schedule yet: start now.
  return lastScheduledAt == null ? now : lastScheduledAt + every;
}

// The runaway backstop: never the pace (docs/runner.md). Scaled with the
// level so it sits well above what each level does on purpose.
export function backstop(agent: AgentDef, level: number): number {
  if (level === APOCALYPTIC) return 1000;
  const scheduled = 24 / agent.ferocity.every_hours[level];
  return Math.max(agent.maxRunsPerDay, Math.ceil(scheduled * [2, 3, 4, 8][level]) + 10);
}

// Failure backoff: 1, 2, 4... minutes, an hour at most.
export const backoffMs = (failStreak: number) => (failStreak <= 0 ? 0 : Math.min(60, 2 ** (failStreak - 1)) * 60_000);
