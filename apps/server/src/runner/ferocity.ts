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

// Levels as of 18 Nov 2026 (Max: "make Steady the default everywhere"; "Chill ... basically not run
// unless told to"): Steady is what Chill used to be - the default, a sensible schedule, stop when
// the job is done. Chill has no schedule at all: it runs only when given work (a task, a request
// answered, another agent's hand-off, a person's message, an event), does that work fully - booking
// follow-ups to finish it - and starts nothing new of its own. The old Steady is gone. The built-in
// agents have no level of their own and keep their schedules.
// every_hours keeps four slots, one per level up to Relentless: slot 0 is the job's sensible pace,
// which Steady runs at (Chill has none); slot 1, the old Steady's, is no longer used.
export const DEFAULT_LEVEL = STEADY;
const PACE_SLOT = [null, 0, 2, 3] as const; // Chill, Steady, Driven, Relentless

// Parallel runs (Max, 18 Nov 2026: "agents should be able to spin up concurrent sessions and do it
// viciously on relentless and apocalyptic"; "on every level it should be able to but at that level
// its instructed to use it more"). An agent with several independent pieces of work (five launch
// films, one per business) starts a run of itself for each piece (ops.start_parallel_run) instead
// of doing them one after another. They're its own runs: same tools, files, memory, cost and
// output. Every level can; the higher the level, the harder it's told to. How many at once besides
// its main run is the machine's bound, not a pace (the memory brake still holds new runs back when
// memory is nearly full).
export const PARALLEL_RUNS = 7;
export const parallelSlots = (_level: number) => PARALLEL_RUNS;
const HOW_PARALLEL = `Start one with ops.start_parallel_run for each piece - up to ${PARALLEL_RUNS} at once beside this run. They're you: same tools, files, cost and output. Give each one piece and its own folder or record, never two runs on the same thing.`;
const GENTLE_PARALLEL = `You can work on several things at once: when a big job splits into independent pieces that would otherwise wait their turn, run them side by side. ${HOW_PARALLEL}`;
const PARALLEL = [
  GENTLE_PARALLEL,
  GENTLE_PARALLEL,
  `Work on several things at once: whenever you have two or more independent pieces of work (one per business, account or batch), run them side by side. ${HOW_PARALLEL}`,
  `Split your work: when you have several independent pieces (one film, account or lead batch per business, say), never do them one after another - run them all at once. ${HOW_PARALLEL} Then carry on with what's left here.`,
  `Split everything you can: every independent piece of work (one film, account or lead batch per business, say) gets its own parallel run, all at once, as many as you have pieces. ${HOW_PARALLEL} Then carry on with what's left here.`,
];

// How readily it asks for things (docs/requests.md, "Ferocity and requests").
const MAKE_DO = 'Make do with the tools you have. Only file a request when you are genuinely blocked and cannot do the work at all any other way.';
const REQUEST_STANCE = [
  MAKE_DO,
  MAKE_DO,
  'Actively look for tools, access and data that would increase your output, and request the ones with a clear payoff.',
  'Treat every limit on your output as something to remove. Request any tool, channel or access that would let you do more or go faster.',
  'Maximise output by any means available. Think of every possible way to get more of your work done and request whatever it takes - new channels, new tools, more access. You can only ask: everything you request still needs a human or the Agency Engineer to grant it.',
];

// Looking for better ways to do the job: every run, from Driven up.
const IMPROVE = `Every run, besides the work itself, look for ways to do your job better: better sources, a tool you don't have yet, a wider scope that still serves your mission, a smarter way to do what you already do. File a request for anything that would help. A run that never looks up from the routine is not doing your job.`;

// The floor for this run, if its level has one, and what counts toward it.
// callable: the tools this run can use. None of what it counts among them (Billing
// Ops before Stripe and Xero are connected) and there's no target - pushed to one,
// it made 81 Google Drive documents nobody needed.
// Workspace files count only beside its real output: alone, they're no target
// (Tier 1 Support, with no Desk, was nudged four times toward 12 files).
export const canCount = (agent: AgentDef, callable?: Set<string>) => {
  if (!callable) return true;
  const real = agent.ferocity.counts.filter(c => !c.startsWith('files.'));
  return (real.length ? real : agent.ferocity.counts).some(c => callable.has(c) || (c.endsWith('*') && [...callable].some(x => x.startsWith(c.slice(0, -1)))));
};

export function floorFor(agent: AgentDef, level: number, callable?: Set<string>): { floor: number; nudges: number; soft: boolean } | null {
  const plan = agent.ferocity;
  if (!plan.counts.length) return null; // nothing to count
  if (!canCount(agent, callable)) return null;
  if (level === DRIVEN) return { floor: plan.soft_floor, nudges: 1, soft: true };
  if (level === RELENTLESS) return { floor: plan.floor, nudges: MAX_NUDGES, soft: false };
  if (level === APOCALYPTIC) return { floor: plan.apocalyptic_floor, nudges: MAX_NUDGES, soft: false };
  return null;
}

// What the agent is told about how hard to work, by level.
export function ferocityInstructions(agent: AgentDef, level: number, callable?: Set<string>): string {
  const plan = agent.ferocity;
  const counted = plan.counts.join(', ');
  const f = floorFor(agent, level, callable);
  const lines = [`## How hard you work: ${LEVELS[level]}`];
  if (level > STEADY && plan.counts.length && !canCount(agent, callable))
    lines.push(
      `None of the tools your output is counted by (${counted}) is connected yet, so this run has no target. Do the useful work you can with what you have, then stop - don't make work (documents, notes, reports) to fill the run.`,
    );
  switch (level) {
    case CHILL:
      lines.push(
        "You have no schedule: you run only when you're given work - a task, an answered request, another agent's hand-off, a person's message, something you watch for. Do that work fully and properly.",
        "If what you were given isn't finished by the end of this run, book your next run (ops.book_next_run) naming what's left, and keep going until it's done. Once it is, stop: don't start new work of your own or book runs for it - you'll be woken when there's more.",
      );
      break;
    case STEADY:
      lines.push(
        'Do your job properly and stop when it is done. Your next scheduled run is coming, so leave anything that can wait for it.',
        'You may book an extra run (ops.book_next_run) only when real work is left that cannot wait. Once your work is done, do not book one.',
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
        'Woken by an event (an alert, a ticket, a new record): follow it to the bottom - the real cause, anything else it touches, anything like it elsewhere - and book a follow-up run (ops.book_next_run) for each lead you can\'t finish now.',
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
  lines.push(PARALLEL[level]);
  if (level > STEADY) lines.push(`What extra effort means for your job: ${plan.extra_effort}`);
  lines.push(`Requests: ${REQUEST_STANCE[level]}`);
  return lines.filter(Boolean).join('\n\n');
}

// The parts of a level's instructions that hold whatever sets the pace (goals.ts): working
// in parallel, what extra effort means for this job, and how readily it asks for things.
// managed: the agency is already starting its parallel runs for it (a goal that needs them).
export function stanceLines(agent: AgentDef, level: number, managed = false): string[] {
  return [
    managed ? 'The agency is starting your parallel runs for you while you are behind: do not start more yourself (ops.start_parallel_run) - take your own slice of the work and leave the rest to them.' : PARALLEL[level],
    level > STEADY ? `What extra effort means for your job: ${agent.ferocity.extra_effort}` : '',
    `Requests: ${REQUEST_STANCE[level]}`,
  ].filter(Boolean);
}

// The message sent when a run would end below its floor (WAR's output floor).
export function nudgeText(agent: AgentDef, acts: number, floor: number, n: number, of: number, soft: boolean): string {
  if (soft)
    return `Before you finish: this run has made ${acts} output action(s), and a good run at your level makes at least ${floor}. If there is more you can usefully do, carry on: ${agent.ferocity.hint} If there genuinely isn't, write your summary.`;
  return [
    `Not finished. This run has made ${acts} output action(s); the floor for every run is ${floor}. Carry on now:`,
    agent.ferocity.hint,
    `Keep going until you reach ${floor}, then write your summary. But if a limit in your instructions is reached, or there is genuinely no real work left, stop and say so - never make other work to fill the number. (Continuation ${n} of ${of}.)`,
  ].join('\n');
}

// --- When the next run is due -------------------------------------------------

export const HOUR = 3_600_000;
export const APOCALYPTIC_GAP_MS = 20_000; // a breath between back-to-back runs

// When its schedule next wants a run (null: no schedule - Chill, which runs only when given
// work, and Apocalyptic, which runs back to back). builtIn: the built-in agents have no level
// and always keep their own schedule.
export const paceHours = (agent: AgentDef, level: number): number | null => {
  const slot = PACE_SLOT[level as 0 | 1 | 2 | 3];
  return slot == null ? null : agent.ferocity.every_hours[slot];
};
export function scheduledDue(agent: AgentDef, level: number, lastScheduledAt: number | null, now: number, builtIn = false): number | null {
  if (level === APOCALYPTIC) return null;
  const hours = builtIn ? agent.ferocity.every_hours[0] : paceHours(agent, level);
  if (hours == null) return null;
  const every = hours * HOUR;
  // Never run on its schedule yet: start now.
  return lastScheduledAt == null ? now : lastScheduledAt + every;
}

// The runaway backstop: never the pace (docs/runner.md). 1,000 runs a day up to
// Driven - far above anything those levels do on purpose - and none at Relentless
// and Apocalyptic, which are meant to go as hard as the work allows.
export function backstop(level: number): number {
  return level >= RELENTLESS ? Infinity : 1000;
}

// Apocalyptic after runs that fell short of its target, in a row: it waits a little
// longer each time - 20 seconds after one, growing - until, after about 20, it's
// at Relentless's pace. One run that reaches its target and it's back to back again.
export const SHORT_RUNS_TO_RELENTLESS = 20;
export function apocalypticWait(agent: AgentDef, shortInARow: number): number {
  const relentless = agent.ferocity.every_hours[RELENTLESS] * HOUR;
  if (shortInARow <= 0) return APOCALYPTIC_GAP_MS;
  const grow = (relentless / APOCALYPTIC_GAP_MS) ** (1 / SHORT_RUNS_TO_RELENTLESS);
  return Math.min(relentless, APOCALYPTIC_GAP_MS * grow ** shortInARow);
}

// Failure backoff: 1, 2, 4... minutes, an hour at most.
export const backoffMs = (failStreak: number) => (failStreak <= 0 ? 0 : Math.min(60, 2 ** (failStreak - 1)) * 60_000);
