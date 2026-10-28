import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Sidebar, viewLabel, type View } from './Sidebar';
import { Dashboard } from './Dashboard';
import { RangePicker } from './RangePicker';
import { useElasticScroll } from './useElasticScroll';
import { APPROVALS, DECIDED_EARLIER_TODAY, type Decisions, type TimeRange } from './data';
import {
  Approvals,
  ApprovalsToolbar,
  DecisionTally,
  visibleApprovals,
  type ApprovalScope,
  type Resolution,
} from './Approvals';

const MIN_WIDTH = 240;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 300;
// Dragging narrower than this snaps the sidebar shut instead of stopping at MIN_WIDTH.
const SNAP_SHUT_BELOW = 160;
const WIDTH_KEY = 'eaa.sidebarWidth';
const SHUT_KEY = 'eaa.sidebarShut';

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable - sidebar size just won't persist.
  }
}

const clamp = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));

export function App() {
  const [view, setView] = useState<View>('dashboard');
  const [range, setRange] = useState<TimeRange>('week');
  // Approvals: resolved ones drop out of every count (sidebar badge, dashboard).
  // `resolved` records a decision the moment it's made (so counters react
  // straight away); `gone` drops the card once its exit animation has played.
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});
  const [gone, setGone] = useState<Record<string, true>>({});
  const pending = APPROVALS.filter(a => !gone[a.id]);
  const [scope, setScope] = useState<ApprovalScope>('mine');
  const [agentFilterRaw, setAgentFilter] = useState<string | null>(null);
  // A filter on an agent with nothing left in scope falls back to all agents.
  const agentFilter =
    agentFilterRaw && visibleApprovals(pending, scope).some(a => a.agentId === agentFilterRaw) ? agentFilterRaw : null;
  const approvalCounts: Record<string, number> = {};
  for (const a of pending) approvalCounts[a.agentId] = (approvalCounts[a.agentId] ?? 0) + 1;
  // Decisions made in this session, per agent - they all happened today, so they
  // add to the dashboard's counts in every time frame and to today's tally.
  const sessionDecisions: Record<string, Decisions> = {};
  for (const [id, r] of Object.entries(resolved)) {
    const agentId = APPROVALS.find(a => a.id === id)!.agentId;
    const d = (sessionDecisions[agentId] ??= { approved: 0, rejected: 0, expired: 0 });
    d[r]++;
  }
  const decidedToday = Object.values(sessionDecisions).reduce(
    (t, d) => ({ approved: t.approved + d.approved, rejected: t.rejected + d.rejected }),
    DECIDED_EARLIER_TODAY,
  );
  const mainBody = useRef<HTMLDivElement>(null);
  useElasticScroll(mainBody);
  const [width, setWidth] = useState(() => clamp(readStored(WIDTH_KEY, DEFAULT_WIDTH)));
  const [shut, setShut] = useState(() => readStored(SHUT_KEY, false));

  useEffect(() => writeStored(WIDTH_KEY, width), [width]);
  useEffect(() => writeStored(SHUT_KEY, shut), [shut]);

  // The sidebar's left edge is the window's left edge, so the pointer's x is the width.
  // onTap runs instead when the pointer is released without moving (click on the rail).
  const startDrag = useCallback((e: React.PointerEvent, onTap?: () => void) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      moved = true;
      if (ev.clientX < SNAP_SHUT_BELOW) {
        setShut(true);
      } else {
        setShut(false);
        setWidth(clamp(ev.clientX));
      }
    };
    const onUp = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) onTap?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  return (
    <div className="app">
      {shut ? (
        <div
          className="sidebar-rail"
          title="Open sidebar (click or drag)"
          onPointerDown={e => startDrag(e, () => setShut(false))}
        >
          <ChevronRight size={14} />
        </div>
      ) : (
        <Sidebar
          view={view}
          onSelect={setView}
          width={width}
          onResizeStart={startDrag}
          approvalsBadge={visibleApprovals(pending, 'mine').length}
        />
      )}
      <main className="main">
        <header className="main-header">
          <div className="header-title">
            <h1>{viewLabel(view)}</h1>
            {view === 'approvals' && <DecisionTally approved={decidedToday.approved} rejected={decidedToday.rejected} />}
          </div>
          {view === 'dashboard' && <RangePicker value={range} onChange={setRange} />}
          {view === 'approvals' && (
            <ApprovalsToolbar
              pending={pending}
              scope={scope}
              setScope={setScope}
              agentFilter={agentFilter}
              setAgentFilter={setAgentFilter}
            />
          )}
        </header>
        <div className="main-body" ref={mainBody}>
          {view === 'dashboard' ? (
            <Dashboard
              range={range}
              onNavigate={setView}
              approvalCounts={approvalCounts}
              sessionDecisions={sessionDecisions}
            />
          ) : view === 'approvals' ? (
            <Approvals
              pending={pending}
              scope={scope}
              agentFilter={agentFilter}
              onDecide={(id, r) => setResolved(prev => ({ ...prev, [id]: r }))}
              onGone={id => setGone(prev => ({ ...prev, [id]: true }))}
            />
          ) : (
            <div className="main-empty">Coming next.</div>
          )}
        </div>
      </main>
    </div>
  );
}
