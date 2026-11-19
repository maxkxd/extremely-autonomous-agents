import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Plus } from 'lucide-react';
import { Skel } from './Skeleton';

// An agent's goals on its card (docs/runner.md, "Goals"): an output in plain words and
// how many a day. Nobody sets how hard the agent works - the agency paces it to its
// goals - so the card shows the goal, how far today has got, and how hard it is being
// pushed. Clicking the goal slides the column over the pies, as the model picker
// does, and lists every goal it has.

export type AgentGoal = { label: string; perDay: number; done: number; waiting: number };
export type AgentPace = { status: string; parallel: number };

const count = (n: number) => n.toLocaleString();
const MAX = 1_000_000;
const digits = (text: string) => Math.min(MAX, parseInt(text.replace(/\D/g, ''), 10) || 0);
const said = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// A number someone is typing: theirs until the server's catches up, saved a moment
// after they stop (a save per keystroke restarted the pace on "1", "10", "100").
function useGoalNumber(value: number, save: (n: number) => void) {
  const [text, setText] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (text !== null && digits(text) === value) setText(null);
  }, [value]);
  const type = (next: string) => {
    setText(next.replace(/\D/g, '').slice(0, 7));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(digits(next)), 500);
  };
  const leave = () => {
    if (text === null) return;
    clearTimeout(timer.current);
    save(digits(text));
  };
  return { shown: text ?? (value ? String(value) : ''), typed: text !== null ? digits(text) : value, type, leave };
}

// The pace in a word, and the runs going at once as dots.
function statusOf(goal: AgentGoal | undefined, pace: AgentPace | null | undefined, stopped: boolean) {
  if (stopped) return 'Stopped';
  if (!goal || !goal.perDay) return 'No goal';
  if (goal.done >= goal.perDay) return 'Goal hit';
  // A number just raised past today's count: the runner hasn't re-paced it yet.
  return said(!pace || pace.status === 'goal hit' ? 'on pace' : pace.status);
}

export function GoalBlock({
  goals,
  pace,
  selected,
  open,
  onOpen,
  onSet,
  disabled = false,
  why,
  stopped = false,
}: {
  goals: AgentGoal[];
  pace?: AgentPace | null;
  selected: string | null;
  open: boolean;
  onOpen: () => void;
  onSet: (label: string, perDay: number) => void;
  disabled?: boolean; // someone else's agent: shown, not changed
  why?: string | null; // greyed out for a reason (the host is offline): said on hover
  stopped?: boolean;
}) {
  const goal = goals.find(g => g.label === selected) ?? goals[0];
  const n = useGoalNumber(goal?.perDay ?? 0, v => goal && onSet(goal.label, v));
  // Each change of the number gives it a small bump (two names, so it replays).
  const [bump, setBump] = useState(0);
  const locked = disabled || !!why || !goal;
  const perDay = n.typed;
  const hit = !!goal && perDay > 0 && goal.done >= perDay;
  const pct = goal && perDay ? Math.min(100, (goal.done / perDay) * 100) : 0;
  const parallel = !stopped && !hit && perDay ? (pace?.parallel ?? 1) : 1;
  return (
    <div className={`goal${hit ? ' hit' : ''}`} title={why ?? undefined}>
      <div className="goal-head">
        <span className="stat-label">Goal</span>
        <span className="goal-status">
          {hit && !stopped && <Check size={14} strokeWidth={3} />}
          {statusOf(goal && { ...goal, perDay }, pace, stopped)}
        </span>
      </div>
      <div className="goal-line">
        <input
          className={`goal-num${bump ? (bump % 2 ? ' bump-a' : ' bump-b') : ''}`}
          value={n.shown}
          placeholder="0"
          inputMode="numeric"
          disabled={locked}
          // As wide as its digits, so the goal's name beside it keeps the room.
          style={{ width: `${Math.max(2, n.shown.length) + 0.3}ch` }}
          aria-label={goal ? `${goal.label} a day` : 'Goal a day'}
          title={why ?? (disabled ? undefined : 'How many a day. The agency speeds the agent up or eases it off to reach it')}
          onChange={e => {
            n.type(e.target.value);
            setBump(b => b + 1);
          }}
          onBlur={n.leave}
          onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <button className={`goal-pick${open ? ' open' : ''}`} onClick={onOpen} disabled={!goal || !!why} title={why ?? (goal ? `${said(goal.label)} a day - see every goal` : 'No goals yet')}>
          <span>{goal ? `${goal.label} / day` : 'No goals yet'}</span>
          <ChevronRight size={14} />
        </button>
      </div>
      <div className="goal-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="goal-foot">
        <span title={goal?.waiting ? `${count(goal.waiting)} of them wait for approval. A rejected one comes off again` : undefined}>
          <b>{count(goal?.done ?? 0)}</b>
          {perDay ? ` of ${count(perDay)} today` : ' today'}
        </span>
        {parallel > 1 && (
          <span className="goal-dots" title={`${parallel} runs at once`}>
            {Array.from({ length: Math.min(parallel, 20) }, (_, i) => (
              <i key={i} style={{ animationDelay: `${i * 40}ms` }} />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

// The goal block's shape while its numbers aren't known yet.
export function GoalSkeleton() {
  return (
    <div className="goal">
      <div className="goal-head">
        <span className="stat-label">Goal</span>
        <Skel w={56} h={14} />
      </div>
      <span className="skel skel-model" style={{ margin: 0, height: 34 }} />
      <span className="skel skel-slider" />
    </div>
  );
}

function GoalRow({ goal, index, active, locked, onPick, onSet }: { goal: AgentGoal; index: number; active: boolean; locked: boolean; onPick: () => void; onSet: (perDay: number) => void }) {
  const n = useGoalNumber(goal.perDay, onSet);
  const perDay = n.typed;
  return (
    <div className={`goal-row${active ? ' active' : ''}`} style={{ animationDelay: `${index * 60}ms` }}>
      <button className="goal-row-name" onClick={onPick} title="Show this goal on the card">
        {said(goal.label)}
      </button>
      <div className="goal-bar">
        <i style={{ width: `${perDay ? Math.min(100, (goal.done / perDay) * 100) : 0}%` }} />
      </div>
      <span className="goal-row-done">{perDay ? `${count(goal.done)} of ${count(perDay)}` : `${count(goal.done)} today`}</span>
      <input
        className="goal-row-num"
        value={n.shown}
        placeholder="0"
        inputMode="numeric"
        disabled={locked}
        aria-label={`${goal.label} a day`}
        onChange={e => n.type(e.target.value)}
        onBlur={n.leave}
        onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      />
      <span className="goal-row-per">/ day</span>
    </div>
  );
}

// The slide-out: every goal with its own number, and the way to a new one.
export function GoalPanel({
  goals,
  selected,
  onPick,
  onSet,
  onNew,
  locked = false,
}: {
  goals: AgentGoal[];
  selected: string | null;
  onPick: (label: string) => void;
  onSet: (label: string, perDay: number) => void;
  onNew?: () => void; // ask the Agency Engineer for a goal it doesn't have yet
  locked?: boolean;
}) {
  const shown = goals.find(g => g.label === selected)?.label ?? goals[0]?.label;
  return (
    <div className="model-panel goal-panel" onPointerDown={e => e.stopPropagation()}>
      <span className="goal-panel-title">Goals · per day</span>
      <div className="goal-rows">
        {goals.map((g, i) => (
          <GoalRow key={g.label} goal={g} index={i} active={g.label === shown} locked={locked} onPick={() => onPick(g.label)} onSet={v => onSet(g.label, v)} />
        ))}
        {onNew && (
          <button className="goal-new" style={{ animationDelay: `${goals.length * 60}ms` }} onClick={onNew}>
            <Plus size={15} />
            New goal
            <em>Ask the Agency Engineer</em>
          </button>
        )}
      </div>
    </div>
  );
}
