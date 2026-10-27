import { useState } from 'react';
import { CircleCheckBig, Inbox, Pause, Play, Square, User } from 'lucide-react';
import { ACCOUNT, AGENTS, rangeLabel, scaleTo, type Agent, type Slice, type TimeRange } from './data';
import { DEPARTMENT_ICON, type View } from './Sidebar';

// Blue-to-gray ramp so charts stay inside the gray + one-blue palette.
const SLICE_COLORS = ['#3f7bd6', '#7aa3e4', '#b4cbf0', '#6b6b6b', '#a0a0a0'];

type RunState = 'active' | 'draining' | 'stopped';

const SIZE = 168;
const R = 64;
const STROKE = 22;
const C = 2 * Math.PI * R;

// No legend: hovering a slice highlights it and shows its label, value and share.
function Donut({ caption, slices, format }: { caption: string; slices: Slice[]; format: (n: number) => string }) {
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const total = slices.reduce((n, s) => n + s.value, 0);
  let offset = 0;

  return (
    <div className="chart" onMouseLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="donut"
        role="img"
        aria-label={`${caption}: ${format(total)}`}
      >
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={R} className="donut-track" />
          {slices.map((s, i) => {
            if (s.value <= 0 || total <= 0) return null;
            const len = (s.value / total) * C;
            const seg = (
              <circle
                key={s.label}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={R}
                stroke={SLICE_COLORS[i % SLICE_COLORS.length]}
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
        <text x={SIZE / 2} y={SIZE / 2 - 7} className="donut-total">{format(total)}</text>
        <text x={SIZE / 2} y={SIZE / 2 + 15} className="donut-caption">{caption}</text>
      </svg>
      {hover && (
        <div className="chart-tip" style={{ left: hover.x, top: hover.y }}>
          <span className="swatch" style={{ background: SLICE_COLORS[hover.i % SLICE_COLORS.length] }} />
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

function AgentCard({
  agent,
  range,
  state,
  setState,
  onNavigate,
}: {
  agent: Agent;
  range: TimeRange;
  state: RunState;
  setState: (s: RunState) => void;
  onNavigate: (v: View) => void;
}) {
  const DeptIcon = DEPARTMENT_ICON[agent.department];
  // Stopping halts an in-flight run; draining lets it finish.
  const outcome = state === 'stopped' && agent.lastRun.outcome === 'running' ? 'stopped' : agent.lastRun.outcome;
  const output = agent.output.map(s => ({ ...s, value: scaleTo(range, s.value) }));
  const cost = agent.cost.map(s => ({ ...s, value: scaleTo(range, s.value, false) }));

  return (
    <article className="agent-card">
      <div className="card-main">
        <header className="card-head">
          <div className="card-name">
            <DeptIcon size={18} strokeWidth={1.75} className="dept-icon" />
            <h2>{agent.name}</h2>
            {state !== 'active' && <span className="state-pill">{state === 'draining' ? 'Draining' : 'Stopped'}</span>}
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

        <div className="open-items">
          <button
            className={`open-chip${agent.openRequests ? ' has' : ''}`}
            title="Open requests"
            onClick={() => onNavigate('requests')}
          >
            <Inbox size={16} strokeWidth={1.75} />
            <span className="open-count">{agent.openRequests}</span>
            <span className="open-label">Requests</span>
          </button>
          <button
            className={`open-chip${agent.openApprovals ? ' has' : ''}`}
            title="Open approvals"
            onClick={() => onNavigate('approvals')}
          >
            <CircleCheckBig size={16} strokeWidth={1.75} />
            <span className="open-count">{agent.openApprovals}</span>
            <span className="open-label">Approvals</span>
          </button>
        </div>
      </aside>
    </article>
  );
}

export function Dashboard({ range, onNavigate }: { range: TimeRange; onNavigate: (v: View) => void }) {
  const [states, setStates] = useState<Record<string, RunState>>({});

  return (
    <div className="dashboard">
      {AGENTS.map(a => (
        <AgentCard
          key={a.id}
          agent={a}
          range={range}
          state={states[a.id] ?? 'active'}
          setState={s => setStates(prev => ({ ...prev, [a.id]: s }))}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}
