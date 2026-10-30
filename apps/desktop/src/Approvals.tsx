import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, Clock, Ellipsis, Users, User, Wrench, X } from 'lucide-react';
import { ACCOUNT, AGENTS, isMine, type Approval } from './data';
import { DEPARTMENT_ICON } from './Sidebar';
import { FlashCount } from './FlashCount';
import { renderApproval } from './approvalTools';
import { useDismiss } from './useDismiss';
import { openSettings } from './NoModels';
import { Loading, Skel, SkelLines } from './Skeleton';

export type ApprovalScope = 'mine' | 'all';
// 'expired' = nobody answered in time; like a rejection, the action does not happen.
export type Resolution = 'approved' | 'rejected' | 'expired';

const agentOf = (a: Approval) => AGENTS.find(x => x.id === a.agentId)!;

// When the call was made: live approvals carry a timestamp, placeholder ones
// "minutes ago" pinned to the page's load time. Deadline = that + the tool's
// expiry window.
const loadedAt = Date.now();
const raisedAt = (a: Approval) => a.createdAt ?? loadedAt - a.minutesAgo * 60_000;
const deadlineOf = (a: Approval) => a.expiresAt ?? raisedAt(a) + renderApproval(a.tool, a.args).expiresAfterHours * 3_600_000;

// Live countdown to an approval's expiry, e.g. 3:59:41 (or 4:07 under an hour).
function Countdown({ deadline, onExpire }: { deadline: number; onExpire: () => void }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const total = Math.max(0, Math.floor((deadline - now) / 1000));
  const expired = total === 0;
  useEffect(() => {
    if (expired) onExpire();
    // onExpire changes identity every render; firing on the edge is what matters.
  }, [expired]);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = String(total % 60).padStart(2, '0');
  // A day or more (the Agency Engineer's week-long ones): days and hours is enough.
  if (h >= 24) return <>{`${Math.floor(h / 24)}d ${h % 24}h`}</>;
  return <>{h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`}</>;
}

function timeAgo(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

// Which approvals this person sees: their own agents', or everyone's when an
// admin switches to "Everyone". Solo accounts (no org) own every agent.
// An item belongs to the owner of the agent it's FOR (e.g. a tool the Fleet
// Engineer wants to build for Lead Finder), else of the agent that raised it.
// A real approval says whose it is (the server knows each agent's owner); one
// with no owner on file is everyone's.
export function visibleApprovals<T extends { agentId: string; forAgentId?: string; owner?: string | null }>(
  pending: T[],
  scope: ApprovalScope,
): T[] {
  if (!ACCOUNT.org || scope === 'all') return pending;
  return pending.filter(a => (a.owner !== undefined ? a.owner === null || a.owner.trim().toLowerCase() === ACCOUNT.name.trim().toLowerCase() : isMine(a.forAgentId ?? a.agentId)));
}

// ---- Today's tally beside the page title -----------------------------------

export function DecisionTally({ approved, rejected }: { approved: number; rejected: number }) {
  return (
    <div className="tally">
      <FlashCount outcome="approved" count={approved} size="lg" title="Approved today" />
      <FlashCount outcome="rejected" count={rejected} size="lg" title="Rejected today" />
    </div>
  );
}

// ---- Header controls: admin "Mine / Everyone" switch + agent filter --------

function AgentFilter({
  options,
  value,
  onChange,
}: {
  options: { id: string; name: string; count: number }[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const current = options.find(o => o.id === value);

  return (
    <div className={`agent-filter${open ? ' open' : ''}`} ref={ref}>
      <button className="range-btn" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <Bot size={15} strokeWidth={1.75} />
        <span className="filter-label">{current ? current.name : 'All agents'}</span>
        <ChevronDown size={15} className="muted chev" />
      </button>
      {open && (
        <ul className="dropdown-menu" role="listbox">
          <li>
            <button
              role="option"
              aria-selected={value === null}
              className="dropdown-option"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
            >
              All agents
              {value === null && <Check size={15} />}
            </button>
          </li>
          {options.map(o => (
            <li key={o.id}>
              <button
                role="option"
                aria-selected={o.id === value}
                className="dropdown-option"
                onClick={() => {
                  onChange(o.id);
                  setOpen(false);
                }}
              >
                <span>{o.name}</span>
                <span className="option-count">{o.id === value ? <Check size={15} /> : o.count}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Shared by Approvals and Requests: anything owned through an agent.
export function ApprovalsToolbar({
  pending,
  scope,
  setScope,
  agentFilter,
  setAgentFilter,
}: {
  pending: { agentId: string }[];
  scope: ApprovalScope;
  setScope: (s: ApprovalScope) => void;
  agentFilter: string | null;
  setAgentFilter: (id: string | null) => void;
}) {
  // Only agents that actually have something waiting, within the current scope.
  const inScope = visibleApprovals(pending, scope);
  const options = AGENTS.filter(a => inScope.some(p => p.agentId === a.id)).map(a => ({
    id: a.id,
    name: a.name,
    count: inScope.filter(p => p.agentId === a.id).length,
  }));

  return (
    <div className="header-tools">
      {ACCOUNT.org && ACCOUNT.role === 'admin' && (
        <div className="segmented" role="tablist" aria-label="Whose approvals">
          <button role="tab" aria-selected={scope === 'mine'} className={scope === 'mine' ? 'on' : ''} onClick={() => setScope('mine')}>
            <User size={14} strokeWidth={1.75} />
            Mine
          </button>
          <button role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>
            <Users size={14} strokeWidth={1.75} />
            Everyone
          </button>
        </div>
      )}
      {options.length > 0 && <AgentFilter options={options} value={agentFilter} onChange={setAgentFilter} />}
    </div>
  );
}

// ---- The cards -------------------------------------------------------------

// A long body is clamped to a few lines with a fade and a Show more toggle, so
// one big approval can't push everything else (and its buttons) off screen.
function ApprovalBody({ text }: { text: string }) {
  const ref = useRef<HTMLQuoteElement>(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > el.clientHeight + 2);
  }, [text]);
  return (
    <div className="approval-body-wrap">
      <blockquote ref={ref} className={`approval-body${open ? '' : ' clamped'}${long && !open ? ' faded' : ''}`}>
        {text}
      </blockquote>
      {long && (
        <button className="body-toggle" onClick={() => setOpen(o => !o)}>
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}

// A card giving agents tools (the Agency Engineer's): each tool with its level,
// which the person sets before approving - the engineer's pick is only a start.
type Given = { forAgent: string; tools: { id: string; tier: string }[] };
const LEVEL_NAMES: [string, string][] = [
  ['T0', 'Silent'],
  ['T1', 'Logged'],
  ['T2', 'Approval'],
];
// "calendar.find_open_slots" -> "Find open slots"
const toolName = (id: string) => {
  const w = (id.split('.').slice(1).join(' ') || id).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};
// Its lists arrive as JSON text (live approvals' args are flattened to strings).
const listOf = (v: unknown): unknown[] | null => {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};
function givenTools(approval: Approval): Given[] | null {
  const args = approval.args as unknown as { tools?: unknown; for_agent?: unknown; also?: unknown };
  const tools = listOf(args.tools) as Given['tools'] | null;
  if (!tools || !['engineer.give_tools', 'engineer.publish_integration'].includes(approval.tool)) return null;
  const also = (listOf(args.also) ?? []) as { for_agent: string; tools: Given['tools'] }[];
  return [{ forAgent: String(args.for_agent ?? ''), tools }, ...also.map(g => ({ forAgent: String(g.for_agent), tools: g.tools ?? [] }))];
}
const levelKey = (forAgent: string, id: string) => `${forAgent}|${id}`;

function ToolLevels({ given, levels, setLevel, disabled }: { given: Given[]; levels: Record<string, string>; setLevel: (key: string, tier: string) => void; disabled: boolean }) {
  return (
    <div className="approval-levels">
      {given.map(g => (
        <div key={g.forAgent} className="approval-levels-agent">
          {given.length > 1 && <span className="approval-levels-who">{AGENTS.find(a => a.id === g.forAgent)?.name ?? g.forAgent}</span>}
          {g.tools.map(t => {
            const key = levelKey(g.forAgent, t.id);
            return (
              <label key={key} className="approval-level">
                <span>{toolName(t.id)}</span>
                <select value={levels[key] ?? t.tier} disabled={disabled} onChange={e => setLevel(key, e.target.value)}>
                  {LEVEL_NAMES.map(([tier, name]) => (
                    <option key={tier} value={tier}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      ))}
    </div>
  );
}

const EXIT_MS = 620; // glow/tint, then fly off (matches the CSS keyframes)
const COLLAPSE_MS = 240; // the gap closing behind it

// The card's three-dot menu: the tool's setting (how much a person is involved with it).
function ApprovalMenu({ tool }: { tool: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  return (
    <div className={`card-menu approval-menu${open ? ' open' : ''}`} ref={ref}>
      <button className="card-menu-btn" onClick={() => setOpen(o => !o)} aria-label="Approval options" aria-expanded={open}>
        <Ellipsis size={18} />
      </button>
      {open && (
        <div className="card-menu-list" role="menu">
          <button
            role="menuitem"
            onClick={() => {
              setOpen(false);
              openSettings('tools', tool);
            }}
          >
            <Wrench size={14} strokeWidth={2} />
            Tool settings
          </button>
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  approval,
  showOwner,
  spotlight,
  onFocused,
  onDecide,
  onGone,
}: {
  spotlight: boolean; // you came here for this one - centre it and glow
  onFocused: () => void;
  approval: Approval;
  showOwner: boolean; // the admin Everyone view tags every card, yours included
  onDecide: (r: Resolution, note: string, levels?: Record<string, string>) => void; // the moment it's decided - counters react now
  onGone: () => void; // after the exit animation - the card leaves the list
}) {
  const agent = agentOf(approval);
  const ownerAgent = AGENTS.find(x => x.id === (approval.forAgentId ?? approval.agentId))!;
  const DeptIcon = DEPARTMENT_ICON[agent.department];
  const card = renderApproval(approval.tool, approval.args);
  const given = givenTools(approval);
  const [levels, setLevels] = useState<Record<string, string>>({});
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [leaving, setLeaving] = useState<Resolution | null>(null);
  const [collapsing, setCollapsing] = useState(false);
  // Arriving for this one (Open Approvals, a draft's Approve): scroll it to the
  // middle, then glow blue for a moment.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [spotlit, setSpotlit] = useState(false);
  useEffect(() => {
    if (!spotlight) return;
    wrapRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setSpotlit(true);
    onFocused(); // clears `spotlight` straight away, so the glow's timer isn't tied to it
    setTimeout(() => setSpotlit(false), 2600);
  }, [spotlight]);

  // Exit: approve glows green and flies right, reject turns red and flies left
  // (EXIT_MS, CSS keyframes). Then the empty slot closes (COLLAPSE_MS) so the
  // cards below glide up, and only then is the result handed up.
  const resolve = (r: Resolution) => {
    if (leaving) return; // already on its way out (e.g. expired while rejecting)
    setRejecting(false);
    setLeaving(r);
    onDecide(r, r === 'rejected' ? reason.trim() : '', r === 'approved' && Object.keys(levels).length ? levels : undefined);
    setTimeout(() => setCollapsing(true), EXIT_MS);
    setTimeout(onGone, EXIT_MS + COLLAPSE_MS);
  };

  return (
    <div ref={wrapRef} className={`approval-wrap${collapsing ? ' collapsing' : ''}`}>
      <article className={`approval${leaving ? ` leaving ${leaving}` : spotlit ? ' spotlit' : ''}${approval.paused && !leaving ? ' paused' : ''}`}>
        <div className="approval-avatar" aria-hidden>
          <DeptIcon size={18} strokeWidth={1.75} />
        </div>
        <div className="approval-main">
          <header className="approval-head">
            {/* One sentence that wraps naturally, however long the tool's "wants to" is. */}
            <p className="approval-line">
              <span className="approval-agent">{agent.name}</span>{' '}
              <span className="approval-action">{card.action}</span>{' '}
              <span className="approval-time">{timeAgo(Math.floor((Date.now() - raisedAt(approval)) / 60_000))}</span>
            </p>
            {/* Built-in agents' own steps (an integration going live) aren't a tool setting. */}
            {!agent.builtIn && <ApprovalMenu tool={approval.tool} />}
            {showOwner && (
              <span className="approval-owner" title="Owner">
                <User size={12} strokeWidth={1.75} />
                {ownerAgent.owner}
              </span>
            )}
          </header>

          {given && <ToolLevels given={given} levels={levels} setLevel={(k, t) => setLevels(l => ({ ...l, [k]: t }))} disabled={!!leaving || !!approval.paused} />}
          {card.fields.filter(f => !(given && f.label === 'Tools')).length > 0 && (
            <dl className="approval-fields">
              {card.fields.filter(f => !(given && f.label === 'Tools')).map(f => (
                <div key={f.label} className="approval-field">
                  <dt>{f.label}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {card.body !== null && <ApprovalBody text={card.body} />}

          <footer className="approval-foot">
            <div className="approval-buttons">
              <button className="ap-btn approve" onClick={() => resolve('approved')} disabled={!!leaving || approval.paused}>
                <Check size={15} strokeWidth={2.25} />
                Approve
              </button>
              <button
                className={`ap-btn reject${rejecting ? ' on' : ''}`}
                title="Shift-click to reject without a reason"
                // Shift-click skips the reason box and rejects straight away.
                onClick={e => (e.shiftKey ? resolve('rejected') : setRejecting(r => !r))}
                disabled={!!leaving || approval.paused}
                aria-expanded={rejecting}
              >
                <X size={15} strokeWidth={2.25} />
                Reject
              </button>
            </div>
            {approval.paused && (
              <span className="state-pill approval-paused" title={`${agent.name} is stopped. Resume it to decide; the clock keeps running.`}>
                Stopped
              </span>
            )}
            <span className="approval-expiry" title="Time left to respond - if it runs out, the action does not happen">
              <Clock size={12} strokeWidth={1.75} />
              {/* Running out plays the reject exit; the action does not happen. */}
              <Countdown deadline={deadlineOf(approval)} onExpire={() => resolve('expired')} />
            </span>
          </footer>

          {/* Reject expands out of the bottom of the card; the reason is optional. */}
          {/* inert while closed: hidden from screen readers, keyboard and find-in-page. */}
          <div className={`reject-drawer${rejecting ? ' open' : ''}`} {...(rejecting ? {} : { inert: '' })}>
            <div className="reject-clip">
              <div className="reject-inner">
                <textarea
                  className="reject-reason"
                  placeholder="Reason for rejecting, the agent will see this (optional)"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  rows={2}
                />
                <div className="reject-actions">
                  <button className="ap-btn ghost" onClick={() => setRejecting(false)}>
                    Cancel
                  </button>
                  <button className="ap-btn confirm-reject" onClick={() => resolve('rejected')}>
                    Reject{reason.trim() ? ' with reason' : ''}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}

export function Approvals({
  pending,
  scope,
  agentFilter,
  focus = null,
  onFocused = () => {},
  onDecide,
  onGone,
  loading = false,
}: {
  loading?: boolean; // the list isn't in yet: placeholders, not "nothing waiting"
  pending: Approval[];
  scope: ApprovalScope;
  agentFilter: string | null;
  focus?: string | null; // the approval to centre and glow
  onFocused?: () => void;
  onDecide: (id: string, r: Resolution, note: string, levels?: Record<string, string>) => void;
  onGone: (id: string) => void;
}) {
  const shown = visibleApprovals(pending, scope)
    .filter(a => !agentFilter || a.agentId === agentFilter)
    .sort((a, b) => raisedAt(a) - raisedAt(b)); // oldest first; new ones arrive at the bottom

  if (loading && shown.length === 0)
    return (
      <div className="approvals" aria-busy>
        <Loading what="approvals" />
        {[0, 1].map(i => (
          <div key={i} className="approval skel-card" aria-hidden>
            <Skel w={38} h={38} r={19} />
            <div className="approval-main">
              <Skel w="45%" h={15} />
              <SkelLines lines={2} h={12} />
              <Skel w="100%" h={64} r={6} />
              <div className="approval-buttons">
                <Skel w={96} h={32} r={8} />
                <Skel w={86} h={32} r={8} />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  if (shown.length === 0) {
    return (
      <div className="main-empty">
        {scope === 'all' ? 'No approvals are waiting.' : 'No approvals are waiting on you.'}
      </div>
    );
  }

  return (
    <div className="approvals">
      {shown.map(a => (
        <ApprovalCard
          key={a.id}
          approval={a}
          spotlight={a.id === focus}
          onFocused={onFocused}
          showOwner={!!ACCOUNT.org && scope === 'all'}
          onDecide={(r, note, levels) => onDecide(a.id, r, note, levels)}
          onGone={() => onGone(a.id)}
        />
      ))}
    </div>
  );
}
