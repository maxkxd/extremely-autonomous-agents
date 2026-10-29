import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { CircleCheckBig, Ellipsis, GripVertical, Pause, Play, Square, Trash2, User, Wrench } from 'lucide-react';
import { DeleteAgentDialog } from './DeleteAgentDialog';
import { ModelPanel, ModelRow, useModelChecks, useModelSlide, type Checks } from './ModelPicker';
import { getAgentModels, getAvailableModels, getLiveAgents, runNow, setAgentModels, setAgentRunner, type AvailableModels, type LiveAgent, type ModelChoice } from './builder';
import { useDismiss } from './useDismiss';
import { FlashCount } from './FlashCount';
import { ACCOUNT, AGENTS, FEROCITY, rangeDays, rangeLabel, scaleTo, type Decisions, type Agent, type Slice, type TimeRange } from './data';
import { DEPARTMENT_ICON, type View } from './Sidebar';

// Slice colours come from --slice-0..4 on the card (styles.css): blue-to-gray
// normally, red at Apocalyptic, grays when the agent is stopped.
const SLICES = 5;
const sliceVar = (i: number) => `var(--slice-${i % SLICES})`;

type RunState = 'active' | 'draining' | 'stopped';

const SIZE = 220;
const R = 82;
const C = 2 * Math.PI * R;
// Gap between slices, in viewBox units. Cut with a mask of straight lines so the
// gap is the same width from the inner edge to the outer edge (a dash gap along
// the arc is an angle, so it would be wider at the outside), and it's truly
// see-through so the card background and glow show through it.
const GAP = 3;
const CUT_FROM = R - 34; // past the ring's inner edge (ring is 44 wide, 50 when hovered)
const CUT_TO = R + 34; // past its outer edge
// Widest the centre total may be: the hole is 120 across (R minus half the
// 44-wide ring, doubled), less some breathing room.
const TOTAL_MAX_WIDTH = 100;

// No legend: hovering a slice highlights it and shows its label, value and share.
function Donut({ caption, slices, format }: { caption: string; slices: Slice[]; format: (n: number) => string }) {
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const maskId = `cuts${useId().replace(/:/g, '')}`;
  // The centre total keeps its full size unless it would spill out of the hole;
  // then it shrinks just enough to fit.
  const totalRef = useRef<SVGTextElement>(null);
  const total = slices.reduce((n, s) => n + s.value, 0);
  const shown = slices.filter(x => x.value > 0).length;
  // Slice boundaries as fractions of the circle, for the gap cuts.
  const bounds: number[] = [];
  if (total > 0 && shown > 1) {
    let acc = 0;
    for (const sl of slices) {
      if (sl.value <= 0) continue;
      bounds.push(acc / total);
      acc += sl.value;
    }
  }
  const label = format(total);
  useLayoutEffect(() => {
    const fit = () => {
      const el = totalRef.current;
      if (!el) return;
      el.style.fontSize = '';
      const width = el.getComputedTextLength();
      if (width > TOTAL_MAX_WIDTH) {
        const base = parseFloat(getComputedStyle(el).fontSize);
        el.style.fontSize = `${(base * TOTAL_MAX_WIDTH) / width}px`;
      }
    };
    fit();
    // Re-measure once the web font is in, in case the first pass used a fallback.
    document.fonts.ready.then(fit);
  }, [label]);
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
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width={SIZE} height={SIZE}>
            <rect width={SIZE} height={SIZE} fill="white" />
            {bounds.map(f => {
              const a = f * 2 * Math.PI;
              const c = SIZE / 2;
              return (
                <line
                  key={f}
                  x1={c + CUT_FROM * Math.cos(a)}
                  y1={c + CUT_FROM * Math.sin(a)}
                  x2={c + CUT_TO * Math.cos(a)}
                  y2={c + CUT_TO * Math.sin(a)}
                  stroke="black"
                  strokeWidth={GAP}
                />
              );
            })}
          </mask>
        </defs>
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`} mask={`url(#${maskId})`}>
          {/* Track only for an empty chart - otherwise it would fill the slice gaps. */}
          {total <= 0 && <circle cx={SIZE / 2} cy={SIZE / 2} r={R} className="donut-track" />}
          {slices.map((s, i) => {
            if (s.value <= 0 || total <= 0) return null;
            const len = (s.value / total) * C;
            const seg = (
              <circle
                key={s.label}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={R}
                stroke={sliceVar(i)}
                strokeDasharray={`${len} ${C - len}`}
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
        <text ref={totalRef} x={SIZE / 2} y={SIZE / 2 - 9} className="donut-total">{format(total)}</text>
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
// Cents only matter for small amounts; from $100 up show whole dollars with commas.
const dollars = (n: number) =>
  n < 100 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`;

// Ferocity picks a FEROCITY level (schedule + self-booking). The estimate is
// this agent's output per run times that level's expected runs over the
// dashboard's selected time frame, matching the rest of the card.
function Tuning({
  agent,
  range,
  level,
  setLevel,
}: {
  agent: Agent;
  range: TimeRange;
  level: number;
  setLevel: (l: number) => void;
}) {
  // A real agent: its recent output per run times the runs its own plan gives
  // this level. Placeholder agents use the placeholder schedules.
  const perRun = agent.live ? agent.perRun : agent.output.reduce((n, s) => n + s.value, 0) / Math.max(agent.runs, 1);
  const perDay = agent.live && agent.runsPerDay ? agent.runsPerDay[level] : FEROCITY[level].runsPerDay;
  const estimate = perRun == null ? null : Math.round(perRun * perDay * rangeDays(range));
  const cadence = agent.live ? runsLabel(perDay) : `${FEROCITY[level].cadence} (placeholder schedule)`;

  return (
    <div className="tuning">
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
        <div className="ferocity-est" title={cadence}>
          <span className="stat-label">Est. Output:</span>
          <span className="est-value">{estimate == null ? '-' : count(estimate)}</span>
        </div>
      </div>
    </div>
  );
}

// "About 3 runs a day", "About 1 run a week", "Non-stop: about 400 runs a day".
function runsLabel(perDay: number): string {
  if (perDay >= 48) return `Non-stop: about ${Math.round(perDay)} runs a day`;
  if (perDay >= 1) return `About ${Math.round(perDay * 10) / 10} run${perDay >= 1.05 ? 's' : ''} a day`;
  const perWeek = perDay * 7;
  return `About ${Math.round(perWeek * 10) / 10} run${perWeek >= 1.05 ? 's' : ''} a week`;
}

export function AgentCard({
  agent,
  range,
  state,
  setState,
  onNavigate,
  openApprovals,
  openRequests,
  decisions,
  dragging,
  onGripDown,
  preview = false,
  onDelete,
  models,
  available = [],
  onModels,
  checks,
  onCheck,
  onLevel,
  onRunNow,
  agencyStopped = false,
}: {
  agent: Agent;
  range: TimeRange;
  state: RunState;
  setState: (s: RunState) => void;
  onNavigate: (v: View) => void;
  openApprovals: number;
  openRequests: number;
  decisions: Decisions; // for the dashboard's time frame
  dragging: boolean;
  onGripDown: (e: React.PointerEvent) => void;
  preview?: boolean; // the new-agent reveal: nothing on it is live yet
  onDelete?: () => void; // absent for built-in agents, which can't be deleted
  models?: ModelChoice[]; // up to three, in order (absent: don't show the Model row)
  available?: AvailableModels[];
  onModels?: (next: ModelChoice[]) => void;
  checks?: Checks; // whether each model really works on this account
  onCheck?: (connection: string, model: string) => void;
  onLevel?: (level: number) => void; // a real agent: save its ferocity
  onRunNow?: () => void; // a real agent: start a run now
  agencyStopped?: boolean; // the whole agency is stopped: its own controls wait
}) {
  // The model picker: the right column slides over the pies to make room.
  const cardRef = useRef<HTMLElement>(null);
  const [modelsOpen, setModelsOpen] = useState(false);
  const closeModels = useCallback(() => setModelsOpen(false), []);
  const slide = useModelSlide(cardRef, modelsOpen, closeModels);
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
    userSetAt.current = Date.now();
    onLevel?.(next);
  };
  // A real agent's level comes from the runner; follow it when it changes
  // there (but not over a change you just made that hasn't come back yet).
  const userSetAt = useRef(0);
  useEffect(() => {
    if (agent.live && agent.ferocity !== level && Date.now() - userSetAt.current > 6000) setLevelState(agent.ferocity);
  }, [agent.live, agent.ferocity]);
  useEffect(() => {
    if (!kick) return;
    const t = setTimeout(() => setKick(null), 500);
    return () => clearTimeout(t);
  }, [kick, level]);
  // Stopping halts an in-flight run; standby lets it finish.
  const last = agent.lastRun;
  const outcome = !last ? 'never' : state === 'stopped' && last.outcome === 'running' ? 'stopped' : last.outcome;
  const output = agent.live ? agent.output : agent.output.map(s => ({ ...s, value: scaleTo(range, s.value) }));
  const cost = agent.live ? agent.cost : agent.cost.map(s => ({ ...s, value: scaleTo(range, s.value, false) }));

  return (
    <article
      ref={cardRef}
      className={`agent-card${modelsOpen ? ` models-open${slide.stacked ? ' stacked' : ''}` : ''}${preview ? ' preview' : ''}${agent.settingUp && !preview ? ' setting-up' : ''} fero-${level} is-${state}${state !== 'active' ? ' is-paused' : ''}${kick ? ` kick-${kick}` : ''}${dragging ? ' dragging' : ''}`}
      style={{ '--tx': tx, '--shift': `${slide.shift}px` } as React.CSSProperties}
    >
      {/* Drag handle: centred on the card's left edge. */}
      {!preview && (
      <button className="drag-grip" title="Drag to reorder" aria-label="Drag to reorder" onPointerDown={onGripDown}>
        <GripVertical size={16} />
      </button>
      )}
      {onDelete && !preview && <CardMenu onDelete={onDelete} onRunNow={onRunNow} />}
      <div className="card-main">
        <header className="card-head">
          <div className="card-name">
            <DeptIcon size={18} strokeWidth={1.75} className="dept-icon" />
            <h2>{agent.name}</h2>
            {/* The pill and counts wrap as one, never apart. */}
            <span className="head-tags">
            {agent.settingUp && (
              <span className="state-pill setting-up" title="Being tailored to your organisation. It won't run until it's done.">
                Setting up
              </span>
            )}
            <span className="head-counts">
              <a
                className={`head-count${openRequests ? ' has' : ''}`}
                title={`${openRequests} open request${openRequests === 1 ? '' : 's'}`}
                onClick={() => onNavigate('requests')}
              >
                <Wrench size={14} strokeWidth={1.75} />
                {openRequests}
              </a>
              <a
                className={`head-count${openApprovals ? ' has' : ''}`}
                title={`${openApprovals} open approval${openApprovals === 1 ? '' : 's'}`}
                onClick={() => onNavigate('approvals')}
              >
                <CircleCheckBig size={14} strokeWidth={1.75} />
                {openApprovals}
              </a>
            </span>
            </span>
          </div>
          {/* Owners only exist inside an organization. */}
          <div className="card-owner">
            {ACCOUNT.org && (
              <span className="owner-name" title="Owner">
                <User size={13} strokeWidth={1.75} />
                {agent.owner}
              </span>
            )}
            {/* Flash when anyone's decision lands; re-keyed on the time frame so
                switching it (which changes every number) doesn't flash. */}
            <span className="decision-counts">
              <FlashCount key={`a-${range}`} outcome="approved" count={decisions.approved} />
              <FlashCount key={`r-${range}`} outcome="rejected" count={decisions.rejected} />
              <FlashCount key={`e-${range}`} outcome="expired" count={decisions.expired} />
            </span>
          </div>
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
            <span className="stat-value">{count(agent.live ? agent.runs : scaleTo(range, agent.runs))}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Last run</span>
            <span className="stat-value small">
              {last ? (
                <>
                  <span className={`outcome ${outcome}`} />
                  {timeAgo(last.minutesAgo)}
                  <span className="muted"> · {outcome}</span>
                </>
              ) : (
                <span className="muted">Not yet</span>
              )}
            </span>
          </div>
        </div>

        {/* Standby (the runner's 'draining') = start nothing itself, finish what's in flight,
            still answer people. Stop = halt now.
            Neutral, not red: Stop is the solid light button, the way a stop control
            reads in a dark UI; Resume takes the attention blue. */}
        {/* Built-ins have none of their own: the agency's Stop covers them. While
            the agency is stopped, every card reads stopped and its own controls wait. */}
        {!agent.builtIn && <div className="controls">
          <button
            key={state === 'draining' ? 'drain-resume' : 'drain'}
            className={`ctl-btn${state === 'draining' ? ' resume' : ''}`}
            disabled={state === 'stopped' || agencyStopped}
            onClick={() => setState(state === 'draining' ? 'active' : 'draining')}
          >
            {state === 'draining' ? <Play size={15} /> : <Pause size={15} />}
            {state === 'draining' ? 'Resume' : 'Standby'}
          </button>
          <button
            key={state === 'stopped' ? 'stop-resume' : 'stop'}
            className={`ctl-btn ${state === 'stopped' ? 'resume' : 'stop'}`}
            disabled={agencyStopped}
            onClick={() => setState(state === 'stopped' ? 'active' : 'stopped')}
          >
            {state === 'stopped' ? <Play size={15} /> : <Square size={13} fill="currentColor" />}
            {state === 'stopped' ? 'Resume' : 'Stop'}
          </button>
        </div>}

        {/* Built-ins work when there's work: no schedule to set. */}
        {!agent.builtIn && <Tuning agent={agent} range={range} level={level} setLevel={setLevel} />}
        {models && (
          <ModelRow choices={models} available={available} checks={checks} open={modelsOpen} readOnly={preview} onOpen={() => setModelsOpen(o => !o)} />
        )}
      </aside>
      {modelsOpen && models && onModels && <ModelPanel choices={models} available={available} onChange={onModels} checks={checks} onCheck={onCheck} />}
    </article>
  );
}

// The card's three-dot menu, top right.
function CardMenu({ onDelete, onRunNow }: { onDelete: () => void; onRunNow?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);
  return (
    <div className={`card-menu${open ? ' open' : ''}`} ref={ref}>
      <button className="card-menu-btn" onClick={() => setOpen(o => !o)} aria-label="Agent options" aria-expanded={open}>
        <Ellipsis size={18} />
      </button>
      {open && (
        <div className="card-menu-list" role="menu">
          {onRunNow && (
            <button
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onRunNow();
              }}
            >
              <Play size={14} strokeWidth={2} />
              Run now
            </button>
          )}
          <button
            role="menuitem"
            className="danger"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            <Trash2 size={14} strokeWidth={2} />
            Delete agent
          </button>
        </div>
      )}
    </div>
  );
}

const ORDER_KEY = 'eaa.dashboardOrder';

// Saved order, with agents not in it (newly added) at the top - the ones
// arriving right now first, in the order they were added.
function loadOrder(arriving: string[]): string[] {
  const ids = AGENTS.map(a => a.id);
  let saved: string[] = [];
  try {
    saved = JSON.parse(localStorage.getItem(ORDER_KEY) ?? '[]') as string[];
  } catch {
    // Storage unavailable - fall back to the default order.
  }
  const kept = saved.filter(id => ids.includes(id) && !arriving.includes(id));
  const fresh = ids.filter(id => !kept.includes(id) && !arriving.includes(id)).reverse();
  return [...arriving.filter(id => ids.includes(id)), ...fresh, ...kept];
}

export function Dashboard({
  range,
  agencyStopped,
  onNavigate,
  approvalCounts,
  requestCounts,
  newDecisions,
  arrivingIds,
  onDeleteAgent,
}: {
  range: TimeRange;
  agencyStopped: boolean;
  onNavigate: (v: View) => void;
  approvalCounts: Record<string, number>;
  requestCounts: Record<string, number>;
  newDecisions: Record<string, Decisions>; // since the app opened (yours + live), so in every time frame
  arrivingIds: string[]; // just-created agents: their cards smash in at the top together
  onDeleteAgent: (id: string) => Promise<void>; // removes its files and the agent everywhere
}) {
  // Standby/Stop/Resume you just pressed, shown at once. A real agent follows the
  // runner again a few seconds later, so a change made elsewhere (someone else,
  // another device) reaches this screen.
  const [states, setStates] = useState<Record<string, { state: RunState; at: number }>>({});
  const stateFor = (id: string, l: LiveAgent | undefined): RunState => {
    if (agencyStopped) return 'stopped';
    const mine = states[id];
    if (mine && (!l || Date.now() - mine.at < 6000)) return mine.state;
    return l?.state ?? 'active';
  };
  // Each agent's models, and every model that could be given (docs/model-connections.md).
  const [modelChoices, setModelChoices] = useState<Record<string, ModelChoice[]>>({});
  const [available, setAvailable] = useState<AvailableModels[]>([]);
  useEffect(() => {
    getAgentModels().then(setModelChoices, () => {});
    getAvailableModels().then(setAvailable, () => {});
  }, [arrivingIds.join(',')]);
  const { checks, check } = useModelChecks(Object.values(modelChoices).flat(), setAvailable);
  // Real agents' state and stats from the runner, refreshed every few seconds.
  const [live, setLive] = useState<Record<string, LiveAgent>>({});
  useEffect(() => {
    let stop = false;
    const load = () => getLiveAgents(Math.max(1, Math.round(rangeDays(range)))).then(l => !stop && setLive(l), () => {});
    load();
    const t = setInterval(load, 4000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [range, arrivingIds.join(',')]);
  // A placeholder card, or a real one with the runner's numbers.
  const view = (a: Agent): Agent => {
    const l = live[a.id];
    if (!l) return a;
    const minutes = l.lastRun ? Math.max(0, Math.round((Date.now() - l.lastRun.at) / 60_000)) : 0;
    return {
      ...a,
      live: true,
      ferocity: l.ferocity,
      runs: l.runs,
      lastRun: l.running ? { minutesAgo: 0, outcome: 'running' } : l.lastRun && { minutesAgo: minutes, outcome: l.lastRun.outcome },
      output: l.output.map(o => ({ label: o.label, value: o.value })),
      cost: l.cost,
      decisions: l.decisions,
      runsPerDay: l.runsPerDay,
      perRun: l.perRun,
    };
  };
  const changeModels = (id: string, next: ModelChoice[]) => {
    setModelChoices(prev => ({ ...prev, [id]: next }));
    setAgentModels(id, next).catch(() => {});
  };
  const [order, setOrder] = useState(() => loadOrder(arrivingIds));
  const [dragId, setDragId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Agent | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const deletedCard = useRef<Agent | null>(null);
  // Deleted: the card fades out, then the ones below slide up into its place.
  const confirmDelete = async (agent: Agent) => {
    await onDeleteAgent(agent.id);
    setDeleting(null);
    setRemoving(agent.id);
    window.setTimeout(() => {
      prevTops.current = new Map([...slots.current].map(([k, s]) => [k, s.getBoundingClientRect().top]));
      setRemoving(null);
      setOrder(prev => prev.filter(x => x !== agent.id));
    }, 240);
  };
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

  // New agents' cards drop in at the top, all at once. The cards below start
  // where they were (shifted up by the new cards' height) and get shoved down
  // at the moment of impact.
  const arrivingKey = arrivingIds.join(',');
  useLayoutEffect(() => {
    const landing = arrivingIds.map(id => slots.current.get(id)).filter((el): el is HTMLDivElement => !!el);
    if (!landing.length) return;
    const gap = parseFloat(getComputedStyle(landing[0].parentElement!).rowGap || '0');
    const shift = landing.reduce((h, el) => h + el.offsetHeight + gap, 0);
    const others = [...slots.current].filter(([id]) => !arrivingIds.includes(id)).map(([, s]) => s);
    for (const o of others) {
      o.style.transition = 'none';
      o.style.transform = `translateY(${-shift}px)`;
    }
    for (const el of landing) el.classList.add('arriving');
    const impact = setTimeout(() => {
      for (const o of others) {
        o.style.transition = 'transform 560ms cubic-bezier(0.25, 1.45, 0.45, 1)';
        o.style.transform = '';
      }
    }, 330);
    const done = setTimeout(() => landing.forEach(el => el.classList.remove('arriving')), 900);
    return () => {
      clearTimeout(impact);
      clearTimeout(done);
    };
  }, [arrivingKey]);

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
        // Gone from AGENTS already: its slot just plays its exit.
        const found = AGENTS.find(x => x.id === id) ?? (removing === id ? deletedCard.current : undefined);
        if (!found) return null;
        const a = view(found);
        const l = live[a.id];
        return (
          <div
            key={a.id}
            className={`card-slot${dragId === a.id ? ' lifted' : ''}${removing === a.id ? ' removing' : ''}`}
            ref={el => (el ? slots.current.set(a.id, el) : slots.current.delete(a.id))}
          >
            <AgentCard
              agent={a}
              range={range}
              state={stateFor(a.id, l)}
              agencyStopped={agencyStopped}
              setState={s => {
                setStates(prev => ({ ...prev, [a.id]: { state: s, at: Date.now() } }));
                if (l) setAgentRunner(a.id, { state: s }).catch(() => {});
              }}
              onNavigate={onNavigate}
              openApprovals={approvalCounts[a.id] ?? 0}
              openRequests={requestCounts[a.id] ?? 0}
              decisions={l ? a.decisions : {
                approved: scaleTo(range, a.decisions.approved) + (newDecisions[a.id]?.approved ?? 0),
                rejected: scaleTo(range, a.decisions.rejected) + (newDecisions[a.id]?.rejected ?? 0),
                expired: scaleTo(range, a.decisions.expired) + (newDecisions[a.id]?.expired ?? 0),
              }}
              dragging={dragId === a.id}
              onGripDown={e => startDrag(a.id, e)}
              onDelete={a.builtIn ? undefined : () => setDeleting(a)}
              models={modelChoices[a.id] ?? []}
              available={available}
              onModels={next => changeModels(a.id, next)}
              checks={checks}
              onCheck={check}
              onLevel={l ? level => setAgentRunner(a.id, { ferocity: level }).catch(() => {}) : undefined}
              onRunNow={l ? () => runNow(a.id).catch(() => {}) : undefined}
            />
          </div>
        );
      })}
      {deleting && (
        <DeleteAgentDialog
          agent={deleting}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            deletedCard.current = deleting;
            return confirmDelete(deleting);
          }}
        />
      )}
    </div>
  );
}
