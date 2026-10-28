import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CircleCheckBig, GripVertical, Inbox, Pause, Play, Square, User } from 'lucide-react';
import { ACCOUNT, AGENTS, FEROCITY, rangeLabel, scaleTo, type Agent, type Slice, type TimeRange } from './data';
import { DEPARTMENT_ICON, type View } from './Sidebar';

// Slice colours come from --slice-0..4 on the card (styles.css): blue-to-gray
// normally, red at Apocalyptic, grays when the agent is stopped.
const SLICES = 5;
const sliceVar = (i: number) => `var(--slice-${i % SLICES})`;

type RunState = 'active' | 'draining' | 'stopped';

const SIZE = 220;
const R = 82;
const C = 2 * Math.PI * R;
// Surface-coloured gap between slices so neighbours never touch.
const GAP = 3;

// No legend: hovering a slice highlights it and shows its label, value and share.
function Donut({ caption, slices, format }: { caption: string; slices: Slice[]; format: (n: number) => string }) {
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const total = slices.reduce((n, s) => n + s.value, 0);
  let offset = 0;

  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      {/* Effect layers behind the pie: always mounted so they can fade in/out. */}
      <span className="chart-glow" aria-hidden />
      <span className="chart-sonar" aria-hidden />
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="donut"
        role="img"
        aria-label={`${caption}: ${format(total)}`}
      >
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          {/* Track only for an empty chart - otherwise it would fill the slice gaps. */}
          {total <= 0 && <circle cx={SIZE / 2} cy={SIZE / 2} r={R} className="donut-track" />}
          {slices.map((s, i) => {
            if (s.value <= 0 || total <= 0) return null;
            const len = (s.value / total) * C;
            const visible = slices.filter(x => x.value > 0).length > 1 ? Math.max(len - GAP, 0.5) : len;
            const seg = (
              <circle
                key={s.label}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={R}
                stroke={sliceVar(i)}
                strokeDasharray={`${visible} ${C - visible}`}
                strokeDashoffset={-offset}
                className={`donut-seg${hover ? (hover.i === i ? ' hot' : ' dim') : ''}`}
                onMouseMove={e => {
                  const box = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
                  setHover({ i, x: e.clientX - box.left, y: e.clientY - box.top });
                }}
              />
            );
            offset += len;
            return seg;
          })}
        </g>
        <text x={SIZE / 2} y={SIZE / 2 - 9} className="donut-total">{format(total)}</text>
        <text x={SIZE / 2} y={SIZE / 2 + 20} className="donut-caption">{caption}</text>
      </svg>
      {hover && (
        <div className="chart-tip" style={{ left: hover.x, top: hover.y }}>
          <span className="swatch" style={{ background: sliceVar(hover.i) }} />
          <span className="tip-label">{slices[hover.i].label}</span>
          <span className="tip-value">
            {format(slices[hover.i].value)} · {Math.round((slices[hover.i].value / total) * 100)}%
          </span>
        </div>
      )}
    </div>
  );
}

function timeAgo(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} d ago`;
}

const count = (n: number) => n.toLocaleString();
const dollars = (n: number) => `$${n.toFixed(2)}`;

// Target output and ferocity. Ferocity picks a FEROCITY level (schedule +
// self-booking); the estimate is this agent's output per run times that level's
// expected runs, so you can see whether a level would hit the target.
function Tuning({ agent, level, setLevel }: { agent: Agent; level: number; setLevel: (l: number) => void }) {
  const [target, setTarget] = useState(agent.targetOutput);
  const perRun = agent.output.reduce((n, s) => n + s.value, 0) / Math.max(agent.runs, 1);
  const estWeek = Math.round(perRun * FEROCITY[level].runsPerDay * 7);
  const onTarget = estWeek >= target;

  return (
    <div className="tuning">
      <label className="tune-row">
        <span className="stat-label">Target output / week</span>
        <input
          className="target-input"
          type="number"
          min={0}
          value={target}
          onChange={e => setTarget(Math.max(0, Number(e.target.value) || 0))}
        />
      </label>

      <div className="ferocity">
        <div className="ferocity-head">
          <span className="stat-label">Ferocity</span>
          <span className={`ferocity-name level-${level}`}>{FEROCITY[level].name}</span>
        </div>
        <input
          className={`ferocity-slider level-${level}`}
          type="range"
          min={0}
          max={FEROCITY.length - 1}
          step={1}
          value={level}
          onChange={e => setLevel(Number(e.target.value))}
          aria-label="Ferocity"
          aria-valuetext={FEROCITY[level].name}
          style={{ '--fill': `${(level / (FEROCITY.length - 1)) * 100}%` } as React.CSSProperties}
        />
        <div className="ferocity-ends">
          <span>Chill</span>
          <span>Apocalyptic</span>
        </div>
        <div className="ferocity-est" title={`${FEROCITY[level].cadence} (placeholder schedule)`}>
          <span className={`est-value${onTarget ? ' on-target' : ''}`}>~{count(estWeek)} / week</span>
          <span className="muted">{FEROCITY[level].cadence}</span>
        </div>
      </div>
    </div>
  );
}

function AgentCard({
  agent,
  range,
  state,
  setState,
  onNavigate,
  dragging,
  onGripDown,
}: {
  agent: Agent;
  range: TimeRange;
  state: RunState;
  setState: (s: RunState) => void;
  onNavigate: (v: View) => void;
  dragging: boolean;
  onGripDown: (e: React.PointerEvent) => void;
}) {
  const DeptIcon = DEPARTMENT_ICON[agent.department];
  // Ferocity lives on the card because each level restyles the whole card
  // (fero-0..4 in styles.css). How a change looks depends on its direction:
  //   up into Steady/Driven  - effects fade in gently
  //   up into Relentless     - abrupt, with a small side-to-side shake
  //   up into Apocalyptic    - abrupt, with a hard shake
  //   any step down          - everything eases back slowly
  // The fade speed (--tx) must change in the SAME render as the level: CSS
  // transitions use the duration in effect when the styles change, so setting
  // it afterwards (e.g. in an effect) applies the previous change's speed.
  const [level, setLevelState] = useState(agent.ferocity);
  const [tx, setTx] = useState('0.9s');
  const [kick, setKick] = useState<'soft' | 'hard' | null>(null);
  const setLevel = (next: number) => {
    if (next === level) return;
    const up = next > level;
    setTx(!up ? '1.6s' : next >= 3 ? '0s' : '0.9s');
    setKick(up && next >= 3 ? (next === 4 ? 'hard' : 'soft') : null);
    setLevelState(next);
  };
  useEffect(() => {
    if (!kick) return;
    const t = setTimeout(() => setKick(null), 500);
    return () => clearTimeout(t);
  }, [kick, level]);
  // Stopping halts an in-flight run; draining lets it finish.
  const outcome = state === 'stopped' && agent.lastRun.outcome === 'running' ? 'stopped' : agent.lastRun.outcome;
  const output = agent.output.map(s => ({ ...s, value: scaleTo(range, s.value) }));
  const cost = agent.cost.map(s => ({ ...s, value: scaleTo(range, s.value, false) }));

  return (
    <article
      className={`agent-card fero-${level} is-${state}${kick ? ` kick-${kick}` : ''}${dragging ? ' dragging' : ''}`}
      style={{ '--tx': tx } as React.CSSProperties}
    >
      <div className="card-main">
        <header className="card-head">
          <div className="card-name">
            <button className="drag-grip" title="Drag to reorder" aria-label="Drag to reorder" onPointerDown={onGripDown}>
              <GripVertical size={16} />
            </button>
            <DeptIcon size={18} strokeWidth={1.75} className="dept-icon" />
            <h2>{agent.name}</h2>
            {state !== 'active' && <span className="state-pill">{state === 'draining' ? 'Draining' : 'Stopped'}</span>}
            <span className="head-counts">
              <a
                className={`head-count${agent.openRequests ? ' has' : ''}`}
                title={`${agent.openRequests} open requests`}
                onClick={() => onNavigate('requests')}
              >
                <Inbox size={14} strokeWidth={1.75} />
                {agent.openRequests}
              </a>
              <a
                className={`head-count${agent.openApprovals ? ' has' : ''}`}
                title={`${agent.openApprovals} open approvals`}
                onClick={() => onNavigate('approvals')}
              >
                <CircleCheckBig size={14} strokeWidth={1.75} />
                {agent.openApprovals}
              </a>
            </span>
          </div>
          {/* Owners only exist inside an organization. */}
          {ACCOUNT.org && (
            <div className="card-owner" title="Owner">
              <User size={13} strokeWidth={1.75} />
              {agent.owner}
            </div>
          )}
        </header>
        <div className="card-charts">
          <Donut caption="output" slices={output} format={count} />
          <Donut caption="cost" slices={cost} format={dollars} />
        </div>
      </div>

      <aside className="card-side">
        <div className="stats">
          <div className="stat">
            <span className="stat-label">Runs · {rangeLabel(range).toLowerCase()}</span>
            <span className="stat-value">{count(scaleTo(range, agent.runs))}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Last run</span>
            <span className="stat-value small">
              <span className={`outcome ${outcome}`} />
              {timeAgo(agent.lastRun.minutesAgo)}
              <span className="muted"> · {outcome}</span>
            </span>
          </div>
        </div>

        {/* Drain = start nothing new, finish what's in flight. Stop = halt now.
            Neutral, not red: Stop is the solid light button, the way a stop control
            reads in a dark UI; Resume takes the attention blue. */}
        <div className="controls">
          <button
            className={`ctl-btn${state === 'draining' ? ' resume' : ''}`}
            disabled={state === 'stopped'}
            onClick={() => setState(state === 'draining' ? 'active' : 'draining')}
          >
            {state === 'draining' ? <Play size={15} /> : <Pause size={15} />}
            {state === 'draining' ? 'Resume' : 'Drain'}
          </button>
          <button
            className={`ctl-btn ${state === 'stopped' ? 'resume' : 'stop'}`}
            onClick={() => setState(state === 'stopped' ? 'active' : 'stopped')}
          >
            {state === 'stopped' ? <Play size={15} /> : <Square size={13} fill="currentColor" />}
            {state === 'stopped' ? 'Resume' : 'Stop'}
          </button>
        </div>

        <Tuning agent={agent} level={level} setLevel={setLevel} />
      </aside>
    </article>
  );
}

const ORDER_KEY = 'eaa.dashboardOrder';

// Saved order, with any agents not in it (newly added) appended at the end.
function loadOrder(): string[] {
  const ids = AGENTS.map(a => a.id);
  try {
    const saved = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as string[];
    const kept = saved.filter(id => ids.includes(id));
    return [...kept, ...ids.filter(id => !kept.includes(id))];
  } catch {
    return ids;
  }
}

export function Dashboard({ range, onNavigate }: { range: TimeRange; onNavigate: (v: View) => void }) {
  const [states, setStates] = useState<Record<string, RunState>>({});
  const [order, setOrder] = useState(loadOrder);
  const [dragId, setDragId] = useState<string | null>(null);
  // Each card sits in a slot; drag-follow and slide animations transform the
  // slot, never the card, so they don't fight the card's own ferocity animations.
  const slots = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<{ id: string; grabOffset: number; pointerY: number; translate: number } | null>(null);
  // Visual tops captured just before a reorder, for the slide (FLIP) animation.
  const prevTops = useRef<Map<string, number> | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    } catch {
      // Storage unavailable - order just won't persist.
    }
  }, [order]);

  // Keep the dragged card's top edge exactly where the pointer is holding it.
  const followPointer = () => {
    const d = drag.current;
    const el = d && slots.current.get(d.id);
    if (!d || !el) return;
    const naturalTop = el.getBoundingClientRect().top - d.translate;
    d.translate = d.pointerY - d.grabOffset - naturalTop;
    el.style.transform = `translateY(${d.translate}px)`;
  };

  // After a reorder, slide every other card from where it was to its new slot.
  useLayoutEffect(() => {
    const prev = prevTops.current;
    prevTops.current = null;
    if (prev) {
      for (const [id, el] of slots.current) {
        if (id === drag.current?.id) continue;
        const before = prev.get(id);
        if (before === undefined) continue;
        el.style.transition = 'none';
        el.style.transform = '';
        const delta = before - el.getBoundingClientRect().top;
        if (!delta) continue;
        el.style.transform = `translateY(${delta}px)`;
        el.getBoundingClientRect(); // commit the start position before animating
        el.style.transition = 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)';
        el.style.transform = '';
      }
    }
    followPointer();
  }, [order]);

  const startDrag = useCallback((id: string, e: React.PointerEvent) => {
    e.preventDefault();
    const el = slots.current.get(id);
    if (!el) return;
    el.style.transition = 'none';
    drag.current = { id, grabOffset: e.clientY - el.getBoundingClientRect().top, pointerY: e.clientY, translate: 0 };
    setDragId(id);
    document.body.classList.add('dragging-card');
    const scroller = el.closest('.main-body');

    const onMove = (ev: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      d.pointerY = ev.clientY;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        if (ev.clientY < box.top + 60) scroller.scrollBy(0, -14);
        else if (ev.clientY > box.bottom - 60) scroller.scrollBy(0, 14);
      }
      followPointer();

      // The dragged card takes the slot before the first other card whose
      // midpoint is below the dragged card's own centre (layout coordinates,
      // so in-flight slide animations don't confuse it).
      const centre = el.offsetTop + d.translate + el.offsetHeight / 2;
      setOrder(prev => {
        const others = prev.filter(x => x !== id);
        let at = others.length;
        for (let i = 0; i < others.length; i++) {
          const o = slots.current.get(others[i]);
          if (o && centre < o.offsetTop + o.offsetHeight / 2) {
            at = i;
            break;
          }
        }
        const next = [...others.slice(0, at), id, ...others.slice(at)];
        if (next.every((x, i) => x === prev[i])) return prev;
        prevTops.current = new Map([...slots.current].map(([k, s]) => [k, s.getBoundingClientRect().top]));
        return next;
      });
    };
    const onUp = () => {
      // Drop: glide the card from wherever it is into its slot.
      el.style.transition = 'transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)';
      el.style.transform = '';
      drag.current = null;
      setDragId(null);
      document.body.classList.remove('dragging-card');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  return (
    <div className="dashboard">
      {order.map(id => {
        const a = AGENTS.find(x => x.id === id)!;
        return (
          <div
            key={a.id}
            className={`card-slot${dragId === a.id ? ' lifted' : ''}`}
            ref={el => (el ? slots.current.set(a.id, el) : slots.current.delete(a.id))}
          >
            <AgentCard
              agent={a}
              range={range}
              state={states[a.id] ?? 'active'}
              setState={s => setStates(prev => ({ ...prev, [a.id]: s }))}
              onNavigate={onNavigate}
              dragging={dragId === a.id}
              onGripDown={e => startDrag(a.id, e)}
            />
          </div>
        );
      })}
    </div>
  );
}
