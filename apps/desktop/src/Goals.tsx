import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Plus } from 'lucide-react';
import { Skel } from './Skeleton';

// An agent's goal on its card (docs/runner.md, "Goals"): an output in plain words and
// how many per hour, day, week, month or year. Every agent has one. Nobody sets how hard
// the agent works - the agency paces it to its goals - so the card shows the goal and how
// far this period has got. The row reads like the Model row; clicking it sends the rest of
// the column up and out of the card, and the goal's settings rise in its place: the
// number, the period, and a wheel of every goal the agent has.

export type Period = 'hour' | 'day' | 'week' | 'month' | 'year';
export type AgentGoal = { label: string; amount: number; period: Period; done: number; waiting: number };
export type AgentPace = { status: string; parallel: number; runsPerDay?: number };

const PERIODS: { id: Period; short: string; now: string }[] = [
  { id: 'hour', short: 'hr', now: 'in the last hour' },
  { id: 'day', short: 'day', now: 'in the last 24 hours' },
  { id: 'week', short: 'wk', now: 'in the last 7 days' },
  { id: 'month', short: 'mo', now: 'in the last 30 days' },
  { id: 'year', short: 'yr', now: 'in the last 365 days' },
];
const nowWord = (p: Period) => PERIODS.find(x => x.id === p)?.now ?? 'today';
const count = (n: number) => n.toLocaleString();
const MAX = 1_000_000;
const digits = (text: string) => Math.min(MAX, parseInt(text.replace(/\D/g, ''), 10) || 0);
const said = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function statusOf(goal: AgentGoal | undefined, pace: AgentPace | null | undefined, stopped: boolean) {
  if (!goal || !goal.amount) return 'No goal';
  if (stopped) return 'Stopped';
  if (goal.done >= goal.amount) return 'Goal hit';
  // A number just raised past this period's count: the runner hasn't re-paced it yet.
  return said(!pace || pace.status === 'goal hit' ? 'on pace' : pace.status);
}

// The collapsed row, and under it how far this period has got.
export function GoalRow({
  goal,
  pace,
  open,
  onOpen,
  why,
  stopped = false,
}: {
  goal?: AgentGoal;
  pace?: AgentPace | null;
  open: boolean;
  onOpen: () => void;
  why?: string | null; // greyed out for a reason (the host is offline): said on hover
  stopped?: boolean;
}) {
  const has = !!goal && goal.amount > 0;
  const hit = has && goal.done >= goal.amount;
  const parallel = !stopped && !hit && has ? (pace?.parallel ?? 1) : 1;
  return (
    <div className={`goal${hit ? ' hit' : ''}${has ? '' : ' none'}`}>
      <button className={`goal-row${open ? ' open' : ''}`} onClick={onOpen} disabled={!!why || !goal} title={why ?? (has ? `${count(goal.amount)} ${goal.label} a ${goal.period} - change the goal` : 'This agent has no goal, so it does not run')}>
        <span className="stat-label">Goal</span>
        <span className="goal-row-value">
          {has ? (
            <>
              <span className="goal-row-name">
                {count(goal.amount)} {goal.label}
              </span>
              <span className="goal-row-per">/ {goal.period}</span>
            </>
          ) : (
            <span className="goal-row-name">Set a goal</span>
          )}
          <ChevronDown size={14} className="goal-row-chev" />
        </span>
      </button>
      {goal && (
        <>
          <div className="goal-bar">
            <i style={{ width: `${has ? Math.min(100, (goal.done / goal.amount) * 100) : 0}%` }} />
          </div>
          <div className="goal-foot">
            <span title={goal.waiting ? `${count(goal.waiting)} of them wait for approval. A rejected one comes off again` : undefined}>
              <b>{count(goal.done)}</b>
              {has ? ` of ${count(goal.amount)} ${nowWord(goal.period)}` : ` ${nowWord(goal.period)}`}
            </span>
            <span className="goal-status" title={parallel > 1 ? `${parallel} runs at once` : undefined}>
              {statusOf(goal, pace, stopped)}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

// The row's shape while its numbers aren't known yet.
export function GoalSkeleton() {
  return (
    <div className="goal">
      <span className="skel skel-model" style={{ margin: 0 }} />
      <span className="skel skel-slider" style={{ margin: '2px 0' }} />
      <Skel w={96} h={12} />
    </div>
  );
}

// What rises in the column's place: the number, the period, and every goal on a wheel.
export function GoalSettings({
  goals,
  selected,
  open,
  onPick,
  onSet,
  onNew,
  locked = false,
}: {
  goals: AgentGoal[];
  selected: string | null;
  open: boolean;
  onPick: (label: string) => void;
  onSet: (label: string, amount: number, period: Period) => void;
  onNew?: () => void; // open the agent's DM, to tell it a goal it doesn't have yet
  locked?: boolean; // someone else's agent: shown, not changed
}) {
  const goal = goals.find(g => g.label === selected) ?? goals[0];
  // The number being typed is theirs until they stop; it is saved a moment later
  // (a save per keystroke re-paced the agent on "1", "10", "100").
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => setText(null), [goal?.label]);
  useEffect(() => {
    if (text !== null && goal && digits(text) === goal.amount) setText(null);
  }, [goal?.amount]);
  // A goal is never left blank: the last one with a number keeps it.
  const mustKeep = !!goal && !goals.some(g => g.label !== goal.label && g.amount > 0);
  const save = (n: number) => {
    if (!goal) return;
    if (n < 1 && mustKeep) return setText(null);
    onSet(goal.label, n, goal.period);
  };
  const type = (next: string) => {
    setText(next.replace(/\D/g, '').slice(0, 7));
    clearTimeout(timer.current);
    const n = digits(next);
    if (n >= 1) timer.current = setTimeout(() => save(n), 500);
  };
  const leave = () => {
    if (text === null) return;
    clearTimeout(timer.current);
    save(digits(text));
  };

  // The wheel: three rows tall, the goal in the middle is the one chosen. With three or
  // more goals it wraps, so scrolling past the last lands on the first and keeps going.
  // One or two sit in the same viewport without a fake wrap that would show the same
  // name twice. "+ New goal" lives under the wheel, not in the wrapping list.
  const ROW = 36;
  const looping = goals.length >= 3;
  const copies = looping ? 3 : 1;
  const wheel = useRef<HTMLDivElement>(null);
  const settle = useRef<ReturnType<typeof setTimeout>>();
  const jumping = useRef(false);
  const goalRef = useRef(goal);
  goalRef.current = goal;
  const pickRef = useRef(onPick);
  pickRef.current = onPick;
  const nearest = (w: HTMLDivElement, label?: string, copy?: string) => {
    const sel = label
      ? `[data-goal="${CSS.escape(label)}"]${copy != null ? `[data-copy="${copy}"]` : ''}`
      : '[data-goal]';
    const nodes = [...w.querySelectorAll<HTMLElement>(sel)];
    if (!nodes.length) return null;
    const mid = w.scrollTop + w.clientHeight / 2;
    return nodes.reduce((best, el) => {
      const d = Math.abs(el.offsetTop + el.offsetHeight / 2 - mid);
      return !best || d < Math.abs(best.offsetTop + best.offsetHeight / 2 - mid) ? el : best;
    });
  };
  const centre = (label: string, smooth: boolean, midCopy = false) => {
    const w = wheel.current;
    if (!w) return;
    const el = nearest(w, label, midCopy && looping ? '1' : undefined);
    if (el) w.scrollTo({ top: el.offsetTop - ROW, behavior: smooth ? 'smooth' : 'auto' });
  };
  useLayoutEffect(() => {
    if (open && goal) centre(goal.label, false, true);
  }, [open, looping]);
  const onScroll = () => {
    const w = wheel.current;
    if (!w || jumping.current) return;
    if (looping) {
      const copyH = goals.length * ROW;
      if (w.scrollTop < copyH - ROW) {
        jumping.current = true;
        w.scrollTop += copyH;
        jumping.current = false;
      } else if (w.scrollTop >= 2 * copyH - ROW) {
        jumping.current = true;
        w.scrollTop -= copyH;
        jumping.current = false;
      }
    }
    clearTimeout(settle.current);
    // Once it comes to rest, whichever goal sits in the middle is chosen.
    settle.current = setTimeout(() => {
      const w = wheel.current;
      if (!w) return;
      const el = nearest(w);
      const label = el?.dataset.goal;
      if (label && label !== goalRef.current?.label) pickRef.current(label);
    }, 120);
  };
  useEffect(() => () => clearTimeout(settle.current), []);

  const at = Math.max(0, PERIODS.findIndex(p => p.id === goal?.period));
  return (
    <div className="goal-set" aria-hidden={!open} {...(open ? {} : { inert: '' })}>
      <input
        className="goal-big"
        value={text ?? (goal?.amount ? String(goal.amount) : '')}
        placeholder="0"
        inputMode="numeric"
        disabled={locked || !goal}
        aria-label={goal ? `${goal.label} a ${goal.period}` : 'Goal'}
        onChange={e => type(e.target.value)}
        onBlur={leave}
        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <div className="goal-sentence">{goal ? <><b>{said(goal.label)}</b> / {goal.period}</> : 'No goals yet'}</div>
      <div className="goal-periods" role="radiogroup" aria-label="Per">
        <i style={{ left: `calc(2px + ${at} * (100% - 4px) / ${PERIODS.length})` }} />
        {PERIODS.map(p => (
          <button key={p.id} role="radio" aria-checked={goal?.period === p.id} className={goal?.period === p.id ? 'on' : ''} disabled={locked || !goal} title={`Per ${p.id}`} onClick={() => goal && onSet(goal.label, text !== null && digits(text) >= 1 ? digits(text) : goal.amount, p.id)}>
            {p.short}
          </button>
        ))}
      </div>
      <div className="goal-wheel-block">
      <div className="goal-wheel-wrap">
        <div className={`goal-wheel${looping ? ' loop' : ''}`} ref={wheel} onScroll={onScroll}>
          {Array.from({ length: copies }, (_, copy) =>
            goals.map(g => (
              <button
                key={`${copy}:${g.label}`}
                data-goal={g.label}
                data-copy={copy}
                className={g.label === goal?.label ? 'on' : ''}
                onClick={() => {
                  onPick(g.label);
                  centre(g.label, true);
                }}
              >
                {said(g.label)}
              </button>
            )),
          )}
        </div>
      </div>
      {onNew && (
        <button className="goal-new" onClick={onNew} title="Tell this agent the new goal you want it to have">
          <Plus size={14} />
          New goal
        </button>
      )}
      </div>
    </div>
  );
}
