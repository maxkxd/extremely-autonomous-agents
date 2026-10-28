import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, Clock, Users, User, X } from 'lucide-react';
import { ACCOUNT, AGENTS, isMine, type Approval } from './data';
import { DEPARTMENT_ICON } from './Sidebar';
import { FlashCount } from './FlashCount';
import { renderApproval } from './approvalTools';
import { useDismiss } from './useDismiss';

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
export function visibleApprovals<T extends { agentId: string; forAgentId?: string }>(
  pending: T[],
  scope: ApprovalScope,
): T[] {
  if (!ACCOUNT.org || scope === 'all') return pending;
  return pending.filter(a => isMine(a.forAgentId ?? a.agentId));
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

const EXIT_MS = 620; // glow/tint, then fly off (matches the CSS keyframes)
const COLLAPSE_MS = 240; // the gap closing behind it

function ApprovalCard({
  approval,
  showOwner,
  onDecide,
  onGone,
}: {
  approval: Approval;
  showOwner: boolean; // the admin Everyone view tags every card, yours included
  onDecide: (r: Resolution, note: string) => void; // the moment it's decided - counters react now
  onGone: () => void; // after the exit animation - the card leaves the list
}) {
  const agent = agentOf(approval);
  const ownerAgent = AGENTS.find(x => x.id === (approval.forAgentId ?? approval.agentId))!;
  const DeptIcon = DEPARTMENT_ICON[agent.department];
  const card = renderApproval(approval.tool, approval.args);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [leaving, setLeaving] = useState<Resolution | null>(null);
  const [collapsing, setCollapsing] = useState(false);

  // Exit: approve glows green and flies right, reject turns red and flies left
  // (EXIT_MS, CSS keyframes). Then the empty slot closes (COLLAPSE_MS) so the
  // cards below glide up, and only then is the result handed up.
  const resolve = (r: Resolution) => {
    if (leaving) return; // already on its way out (e.g. expired while rejecting)
    setRejecting(false);
    setLeaving(r);
    onDecide(r, r === 'rejected' ? reason.trim() : '');
    setTimeout(() => setCollapsing(true), EXIT_MS);
    setTimeout(onGone, EXIT_MS + COLLAPSE_MS);
  };

  return (
    <div className={`approval-wrap${collapsing ? ' collapsing' : ''}`}>
      <article className={`approval${leaving ? ` leaving ${leaving}` : ''}`}>
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
            {showOwner && (
              <span className="approval-owner" title="Owner">
                <User size={12} strokeWidth={1.75} />
                {ownerAgent.owner}
              </span>
            )}
          </header>

          {card.fields.length > 0 && (
            <dl className="approval-fields">
              {card.fields.map(f => (
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
              <button className="ap-btn approve" onClick={() => resolve('approved')} disabled={!!leaving}>
                <Check size={15} strokeWidth={2.25} />
                Approve
              </button>
              <button
                className={`ap-btn reject${rejecting ? ' on' : ''}`}
                title="Shift-click to reject without a reason"
                // Shift-click skips the reason box and rejects straight away.
                onClick={e => (e.shiftKey ? resolve('rejected') : setRejecting(r => !r))}
                disabled={!!leaving}
                aria-expanded={rejecting}
              >
                <X size={15} strokeWidth={2.25} />
                Reject
              </button>
            </div>
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
  onDecide,
  onGone,
}: {
  pending: Approval[];
  scope: ApprovalScope;
  agentFilter: string | null;
  onDecide: (id: string, r: Resolution, note: string) => void;
  onGone: (id: string) => void;
}) {
  const shown = visibleApprovals(pending, scope)
    .filter(a => !agentFilter || a.agentId === agentFilter)
    .sort((a, b) => raisedAt(a) - raisedAt(b)); // oldest first; new ones arrive at the bottom

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
          showOwner={!!ACCOUNT.org && scope === 'all'}
          onDecide={(r, note) => onDecide(a.id, r, note)}
          onGone={() => onGone(a.id)}
        />
      ))}
    </div>
  );
}
