import { useEffect, useRef, useState } from 'react';
import { Bot, Check, ChevronDown, CircleCheckBig, Clock, Users, User, X } from 'lucide-react';
import { ACCOUNT, AGENTS, isMine, type Approval } from './data';
import { DEPARTMENT_ICON } from './Sidebar';
import { useDismiss } from './useDismiss';

export type ApprovalScope = 'mine' | 'all';
export type Resolution = 'approved' | 'rejected';

const agentOf = (a: Approval) => AGENTS.find(x => x.id === a.agentId)!;

// Placeholder data gives time remaining; pin each to a real deadline once.
const loadedAt = Date.now();
const deadlineOf = (a: Approval) => loadedAt + a.expiresInHours * 3_600_000;

// Live countdown to an approval's expiry, e.g. 3:59:41 (or 4:07 under an hour).
function Countdown({ deadline }: { deadline: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const total = Math.max(0, Math.floor((deadline - now) / 1000));
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
export function visibleApprovals(pending: Approval[], scope: ApprovalScope) {
  if (!ACCOUNT.org || scope === 'all') return pending;
  return pending.filter(a => isMine(a.agentId));
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

export function ApprovalsToolbar({
  pending,
  scope,
  setScope,
  agentFilter,
  setAgentFilter,
}: {
  pending: Approval[];
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

const EXIT_MS = 620; // glow/tint, then fly off (matches the CSS keyframes)
const COLLAPSE_MS = 240; // the gap closing behind it

function ApprovalCard({
  approval,
  showOwner,
  onResolve,
}: {
  approval: Approval;
  showOwner: boolean; // the admin Everyone view tags every card, yours included
  onResolve: (r: Resolution) => void;
}) {
  const agent = agentOf(approval);
  const DeptIcon = DEPARTMENT_ICON[agent.department];
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [leaving, setLeaving] = useState<Resolution | null>(null);
  const [collapsing, setCollapsing] = useState(false);

  // Exit: approve glows green and flies right, reject turns red and flies left
  // (EXIT_MS, CSS keyframes). Then the empty slot closes (COLLAPSE_MS) so the
  // cards below glide up, and only then is the result handed up.
  const resolve = (r: Resolution) => {
    setRejecting(false);
    setLeaving(r);
    setTimeout(() => setCollapsing(true), EXIT_MS);
    setTimeout(() => onResolve(r), EXIT_MS + COLLAPSE_MS);
  };

  return (
    <div className={`approval-wrap${collapsing ? ' collapsing' : ''}`}>
      <article className={`approval${leaving ? ` leaving ${leaving}` : ''}`}>
        <div className="approval-avatar" aria-hidden>
          <DeptIcon size={18} strokeWidth={1.75} />
        </div>
        <div className="approval-main">
          <header className="approval-head">
            <span className="approval-agent">{agent.name}</span>
            <span className="approval-action">{approval.action}</span>
            <span className="approval-time">{timeAgo(approval.minutesAgo)}</span>
            {showOwner && (
              <span className="approval-owner" title="Owner">
                <User size={12} strokeWidth={1.75} />
                {agent.owner}
              </span>
            )}
          </header>

          <dl className="approval-fields">
            {approval.fields.map(f => (
              <div key={f.label} className="approval-field">
                <dt>{f.label}</dt>
                <dd>{f.value}</dd>
              </div>
            ))}
          </dl>
          {approval.body && <blockquote className="approval-body">{approval.body}</blockquote>}

          <footer className="approval-foot">
            <div className="approval-buttons">
              <button className="ap-btn approve" onClick={() => resolve('approved')} disabled={!!leaving}>
                <Check size={15} strokeWidth={2.25} />
                Approve
              </button>
              <button
                className={`ap-btn reject${rejecting ? ' on' : ''}`}
                onClick={() => setRejecting(r => !r)}
                disabled={!!leaving}
                aria-expanded={rejecting}
              >
                <X size={15} strokeWidth={2.25} />
                Reject
              </button>
            </div>
            <span className="approval-expiry" title="Time left to respond - if it runs out, the action does not happen">
              <Clock size={12} strokeWidth={1.75} />
              <Countdown deadline={deadlineOf(approval)} />
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
  onResolve,
}: {
  pending: Approval[];
  scope: ApprovalScope;
  agentFilter: string | null;
  onResolve: (id: string, r: Resolution) => void;
}) {
  const shown = visibleApprovals(pending, scope)
    .filter(a => !agentFilter || a.agentId === agentFilter)
    .sort((a, b) => b.minutesAgo - a.minutesAgo); // oldest first; new ones arrive at the bottom

  if (shown.length === 0) {
    return (
      <div className="main-empty approvals-empty">
        <CircleCheckBig size={28} strokeWidth={1.5} />
        <span>{scope === 'all' ? 'Nothing is waiting for approval.' : 'Nothing is waiting on you.'}</span>
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
          onResolve={r => onResolve(a.id, r)}
        />
      ))}
    </div>
  );
}
