import { useState } from 'react';
import { CircleCheckBig, Inbox, Pause, Play, Square } from 'lucide-react';
import { ACCOUNT, AGENTS, type Agent, type Slice } from './data';
import { DEPARTMENT_ICON, type View } from './Sidebar';

// Blue-to-gray ramp so charts stay inside the gray + one-blue palette.
const SLICE_COLORS = ['#3f7bd6', '#7aa3e4', '#b4cbf0', '#6b6b6b', '#a0a0a0'];

type RunState = 'active' | 'draining' | 'stopped';

function Donut({ title, slices, format }: { title: string; slices: Slice[]; format: (n: number) => string }) {
  const total = slices.reduce((n, s) => n + s.value, 0);
  const r = 42;
  const c = 2 * Math.PI * r;
  let offset = 0;

  return (
    <div className="chart">
      <div className="chart-title">{title}</div>
      <div className="chart-body">
        <svg viewBox="0 0 110 110" className="donut" role="img" aria-label={`${title}: ${format(total)}`}>
          <circle cx="55" cy="55" r={r} className="donut-track" />
          {slices.map((s, i) => {
            if (s.value <= 0) return null;
            const len = (s.value / total) * c;
            const seg = (
              <circle
                key={s.label}
                cx="55"
                cy="55"
                r={r}
                stroke={SLICE_COLORS[i % SLICE_COLORS.length]}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
                className="donut-seg"
              />
            );
            offset += len;
            return seg;
          })}
          <text x="55" y="55" className="donut-total">{format(total)}</text>
        </svg>
        <ul className="legend">
          {slices.map((s, i) => (
            <li key={s.label}>
              <span className="swatch" style={{ background: SLICE_COLORS[i % SLICE_COLORS.length] }} />
              <span className="legend-label">{s.label}</span>
              <span className="legend-value">{format(s.value)}</span>
            </li>
          ))}
        </ul>
      </div>
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
  state,
  setState,
  onNavigate,
}: {
  agent: Agent;
  state: RunState;
  setState: (s: RunState) => void;
  onNavigate: (v: View) => void;
}) {
  const DeptIcon = DEPARTMENT_ICON[agent.department];
  // Stopping halts an in-flight run; draining lets it finish.
  const outcome = state === 'stopped' && agent.lastRun.outcome === 'running' ? 'stopped' : agent.lastRun.outcome;

  return (
    <article className="agent-card">
      <div className="card-main">
        <header className="card-head">
          <div className="card-name">
            <DeptIcon size={18} strokeWidth={1.75} className="dept-icon" />
            <h2>{agent.name}</h2>
            {state !== 'active' && <span className={`state-pill ${state}`}>{state === 'draining' ? 'Draining' : 'Stopped'}</span>}
          </div>
          {/* Owners only exist inside an organization. */}
          {ACCOUNT.org && <div className="card-owner">Owner · {agent.owner}</div>}
        </header>
        <div className="card-charts">
          <Donut title="Output" slices={agent.output} format={count} />
          <Donut title="Cost" slices={agent.cost} format={dollars} />
        </div>
      </div>

      <aside className="card-side">
        <div className="stats">
          <div className="stat">
            <span className="stat-label">Runs · 30 days</span>
            <span className="stat-value">{count(agent.runs)}</span>
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

        {/* Drain = start nothing new, finish what's in flight. Stop = halt now. */}
        <div className="controls">
          <button
            className="ctl-btn"
            disabled={state === 'stopped'}
            onClick={() => setState(state === 'draining' ? 'active' : 'draining')}
          >
            {state === 'draining' ? <Play size={15} /> : <Pause size={15} />}
            {state === 'draining' ? 'Resume' : 'Drain'}
          </button>
          <button
            className={`ctl-btn${state === 'stopped' ? '' : ' danger'}`}
            onClick={() => setState(state === 'stopped' ? 'active' : 'stopped')}
          >
            {state === 'stopped' ? <Play size={15} /> : <Square size={14} />}
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

export function Dashboard({ onNavigate }: { onNavigate: (v: View) => void }) {
  const [states, setStates] = useState<Record<string, RunState>>({});

  return (
    <div className="dashboard">
      {AGENTS.map(a => (
        <AgentCard
          key={a.id}
          agent={a}
          state={states[a.id] ?? 'active'}
          setState={s => setStates(prev => ({ ...prev, [a.id]: s }))}
          onNavigate={onNavigate}
        />
      ))}
    </div>
  );
}
