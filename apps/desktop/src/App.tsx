import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { Sidebar, viewLabel, type View } from './Sidebar';
import { Dashboard } from './Dashboard';
import { RangePicker } from './RangePicker';
import { useElasticScroll } from './useElasticScroll';
import { AgentDM, stamp, type StampedEntry } from './AgentDM';
import { NewAgent } from './NewAgent';
import { AgentReveal } from './AgentReveal';
import { NEW_SESSION, agentStatuses, deleteAgentFiles, outputSlices, saveAgent, type BuilderSession, type Built } from './builder';
import { DM_HISTORY } from './dms';
import { subscribeToDecisions } from './live';
import {
  AGENTS,
  addAgent,
  removeAgent,
  updateAgent,
  APPROVALS,
  DECIDED_EARLIER_TODAY,
  REQUESTS,
  type Approval,
  type Decisions,
  type ResourceRequest,
  type TimeRange,
} from './data';
import { Requests, startConvo, type Convo, type RequestResolution } from './Requests';
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
  // Approvals raised while the app is open (e.g. the Fleet Engineer asking to
  // build a tool for a request), alongside the placeholder ones.
  const [raised, setRaised] = useState<Approval[]>([]);
  const allApprovals = [...APPROVALS, ...raised];
  // Bumped when an agent is deleted, so everything re-reads AGENTS.
  const [, setAgentsVersion] = useState(0);
  const exists = (id?: string) => !id || AGENTS.some(a => a.id === id);
  const pending = allApprovals.filter(a => !gone[a.id] && exists(a.agentId) && exists(a.forAgentId));
  // The Fleet Engineer wants to build the tool it designed for a request: that
  // is a human approval, owned by the requesting agent's owner. Returns its id.
  const proposeBuild = (req: ResourceRequest) => {
    const id = `ap-build-${req.id}-${Date.now()}`;
    const forAgent = AGENTS.find(a => a.id === req.agentId)!;
    setRaised(prev => [
      ...prev,
      {
        id,
        agentId: 'fleet',
        forAgentId: req.agentId,
        tool: 'tool.build',
        args: { forAgent: forAgent.name, ...req.engineer.build },
        minutesAgo: 0,
        createdAt: Date.now(),
      },
    ]);
    return id;
  };
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
    const agentId = allApprovals.find(a => a.id === id)!.agentId;
    const d = (sessionDecisions[agentId] ??= { approved: 0, rejected: 0, expired: 0 });
    d[r]++;
  }
  // Decisions arriving live from elsewhere in the org (other people, expiries).
  const [liveDecisions, setLiveDecisions] = useState<Record<string, Decisions>>({});
  useEffect(
    () =>
      subscribeToDecisions(e =>
        setLiveDecisions(prev => {
          const d = prev[e.agentId] ?? { approved: 0, rejected: 0, expired: 0 };
          return { ...prev, [e.agentId]: { ...d, [e.outcome]: d[e.outcome] + 1 } };
        }),
      ),
    [],
  );
  // Everything decided since the app opened, yours plus live: added on top of
  // each agent's history on the dashboard.
  const newDecisions: Record<string, Decisions> = {};
  for (const src of [sessionDecisions, liveDecisions]) {
    for (const [id, d] of Object.entries(src)) {
      const t = (newDecisions[id] ??= { approved: 0, rejected: 0, expired: 0 });
      t.approved += d.approved;
      t.rejected += d.rejected;
      t.expired += d.expired;
    }
  }
  // Today's tally on Approvals is only YOUR decisions.
  const decidedToday = Object.values(sessionDecisions).reduce(
    (t, d) => ({ approved: t.approved + d.approved, rejected: t.rejected + d.rejected }),
    DECIDED_EARLIER_TODAY,
  );
  // Requests: same shape as approvals - decided on click, removed after the exit.
  const [, setRequestResolved] = useState<Record<string, RequestResolution>>({});
  const [requestGone, setRequestGone] = useState<Record<string, true>>({});
  const pendingRequests = REQUESTS.filter(r => !requestGone[r.id] && exists(r.agentId));
  const [requestScope, setRequestScope] = useState<ApprovalScope>('mine');
  const [requestFilterRaw, setRequestFilter] = useState<string | null>(null);
  const requestFilter =
    requestFilterRaw && visibleApprovals(pendingRequests, requestScope).some(r => r.agentId === requestFilterRaw)
      ? requestFilterRaw
      : null;
  const [convos, setConvos] = useState<Record<string, Convo>>({});
  const updateConvo = (id: string, fn: (c: Convo) => Convo) =>
    setConvos(prev => ({ ...prev, [id]: fn(prev[id] ?? startConvo(REQUESTS.find(r => r.id === id)!)) }));
  const requestCounts: Record<string, number> = {};
  for (const r of pendingRequests) requestCounts[r.agentId] = (requestCounts[r.agentId] ?? 0) + 1;
  // Agent DMs: history plus anything sent this session, per agent. Kept here
  // so a pending reply still lands if you switch away mid-run.
  const [dms, setDms] = useState<Record<string, StampedEntry[]>>(() =>
    Object.fromEntries(Object.entries(DM_HISTORY).map(([id, list]) => [id, list.map(e => stamp(e))])),
  );
  const [dmRunning, setDmRunning] = useState<Record<string, boolean>>({});
  // PLACEHOLDER: your message wakes the agent; a run later posts its reply in
  // the same channel. Simulated until real agents exist.
  const sendDm = (agentId: string, text: string) => {
    setDms(prev => ({ ...prev, [agentId]: [...(prev[agentId] ?? []), stamp({ kind: 'you', minutesAgo: 0, text }, Date.now())] }));
    setDmRunning(prev => ({ ...prev, [agentId]: true }));
    // Still being set up: it answers once it's ready (see the set-up poll below).
    if (AGENTS.find(a => a.id === agentId)?.settingUp) heldDms.current.add(agentId);
    else answerDm(agentId);
  };
  const heldDms = useRef(new Set<string>());
  const answerDm = (agentId: string) => {
    const name = AGENTS.find(a => a.id === agentId)?.name ?? 'This agent';
    window.setTimeout(() => {
      const reply = stamp(
        {
          kind: 'run',
          id: Math.random().toString(16).slice(2, 6),
          minutesAgo: 0,
          trigger: 'your message',
          outcome: 'succeeded',
          cost: 0.02,
          seconds: 3,
          text: `(Simulated) This is where ${name} answers you. Replies to questions asked here always come back here.`,
          tools: [],
        },
        Date.now(),
      );
      setDms(prev => ({ ...prev, [agentId]: [...(prev[agentId] ?? []), reply] }));
      setDmRunning(prev => ({ ...prev, [agentId]: false }));
    }, 2400);
  };
  const mainBody = useRef<HTMLDivElement>(null);
  useElasticScroll(mainBody);

  // Creating an agent (docs/agent-creation.md). The conversation lives here so
  // it survives leaving the New agent page.
  const [builder, setBuilder] = useState<BuilderSession>(NEW_SESSION);
  // The new agents on the black screen: one you built, or a whole pack.
  const [reveal, setReveal] = useState<{ built: Built[]; leaving: boolean; error: string | null } | null>(null);
  const [arrivingIds, setArrivingIds] = useState<string[]>([]);
  const cancelReveal = useCallback(() => setReveal(null), []);
  const acceptReveal = async () => {
    if (!reveal) return;
    try {
      await Promise.all(reveal.built.map(b => saveAgent(b)));
    } catch (e) {
      setReveal({ ...reveal, error: (e as Error).message });
      return;
    }
    for (const b of reveal.built) addAgent(b.agent);
    // Building an agent ends its conversation; adding a pack leaves yours alone.
    if (reveal.built.length === 1 && builder.phase === 'chat') setBuilder(NEW_SESSION);
    setReveal({ ...reveal, leaving: true, error: null });
    setArrivingIds(reveal.built.map(b => b.agent.id));
    setView('dashboard');
    mainBody.current?.scrollTo({ top: 0 });
    window.setTimeout(() => setReveal(null), 450);
  };
  // The smash plays once: forget the new agent as soon as it has landed, or
  // when you leave the dashboard, so coming back doesn't replay it.
  useEffect(() => {
    if (!arrivingIds.length) return;
    if (view !== 'dashboard') return setArrivingIds([]);
    const t = window.setTimeout(() => setArrivingIds([]), 1000);
    return () => window.clearTimeout(t);
  }, [arrivingIds, view]);

  // Pack agents are customized on the server after they're added. While any
  // is still setting up, check every few seconds; when one is ready its card
  // picks up its final details and any DM sent meanwhile gets answered.
  const [, setAgentsTick] = useState(0);
  const anySettingUp = AGENTS.some(a => a.settingUp);
  useEffect(() => {
    if (!anySettingUp) return;
    const check = async () => {
      let statuses;
      try {
        statuses = await agentStatuses();
      } catch {
        return; // server down: try again next tick
      }
      let changed = false;
      for (const a of AGENTS) {
        const s = statuses[a.id];
        if (!a.settingUp || !s || s.status === 'setting-up') continue;
        updateAgent(a.id, { settingUp: false, output: outputSlices(s.output) });
        changed = true;
        if (heldDms.current.delete(a.id)) answerDm(a.id);
      }
      if (changed) setAgentsTick(t => t + 1);
    };
    check();
    const id = window.setInterval(check, 3000);
    return () => window.clearInterval(id);
  }, [anySettingUp]);
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
          requestsBadge={visibleApprovals(pendingRequests, 'mine').length}
        />
      )}
      <main className="main">
        <header className="main-header">
          <div className="header-title">
            <h1>{viewLabel(view)}</h1>
            {view === 'approvals' && <DecisionTally approved={decidedToday.approved} rejected={decidedToday.rejected} />}
            {view === 'dashboard' && (
              <button className="new-agent-btn" onClick={() => setView('new-agent')}>
                <Plus size={14} strokeWidth={2} />
                New agent
              </button>
            )}
          </div>
          {view === 'dashboard' && <RangePicker value={range} onChange={setRange} />}
          {view === 'requests' && (
            <ApprovalsToolbar
              pending={pendingRequests}
              scope={requestScope}
              setScope={setRequestScope}
              agentFilter={requestFilter}
              setAgentFilter={setRequestFilter}
            />
          )}
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
              requestCounts={requestCounts}
              newDecisions={newDecisions}
              arrivingIds={arrivingIds}
              onDeleteAgent={async id => {
                await deleteAgentFiles(id);
                removeAgent(id);
                setAgentsVersion(v => v + 1);
              }}
            />
          ) : view === 'approvals' ? (
            <Approvals
              pending={pending}
              scope={scope}
              agentFilter={agentFilter}
              onDecide={(id, r) => setResolved(prev => ({ ...prev, [id]: r }))}
              onGone={id => setGone(prev => ({ ...prev, [id]: true }))}
            />
          ) : view === 'requests' ? (
            <Requests
              pending={pendingRequests}
              scope={requestScope}
              agentFilter={requestFilter}
              onDecide={(id, r) => setRequestResolved(prev => ({ ...prev, [id]: r }))}
              onGone={id => setRequestGone(prev => ({ ...prev, [id]: true }))}
              onProposeBuild={proposeBuild}
              approvalOutcomes={resolved}
              onOpenApprovals={() => setView('approvals')}
              convos={convos}
              updateConvo={updateConvo}
            />
          ) : view === 'new-agent' ? (
            <NewAgent
              session={builder}
              setSession={setBuilder}
              onBuilt={built => setReveal({ built, leaving: false, error: null })}
            />
          ) : view.startsWith('agent:') ? (
            <AgentDM
              agentId={view.slice('agent:'.length)}
              entries={dms[view.slice('agent:'.length)] ?? []}
              thinking={!!dmRunning[view.slice('agent:'.length)]}
              onSend={text => sendDm(view.slice('agent:'.length), text)}
              approvalOutcomes={resolved}
            />
          ) : (
            <div className="main-empty">Coming next.</div>
          )}
        </div>
      </main>
      {reveal && (
        <AgentReveal
          agents={reveal.built.map(b => b.agent)}
          leaving={reveal.leaving}
          error={reveal.error}
          onCancel={cancelReveal}
          onAccept={acceptReveal}
        />
      )}
    </div>
  );
}
