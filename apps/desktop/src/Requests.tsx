import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Hammer, Hand, Loader2, User, X } from 'lucide-react';
import { ACCOUNT, AGENTS, type ResourceRequest } from './data';
import { DEPARTMENT_ICON } from './Sidebar';
import { visibleApprovals, type ApprovalScope } from './Approvals';

// How a request left the page: you did it, you rejected it, or the Fleet
// Engineer sorted it after you tasked it.
export type RequestResolution = 'diy' | 'rejected' | 'engineered';

// AI IDEs a request can be handed to. Not built yet: needs a connector that
// finds and opens the IDE, and this system's MCP inside it (docs/requests.md).
const IDES = ['Claude Code', 'Cursor', 'Antigravity', 'Codex'];

// PLACEHOLDER: how long the simulated Fleet Engineer takes to answer.
const ENGINEER_MS = 2600;
const EXIT_MS = 620;
const COLLAPSE_MS = 240;

const agentOf = (r: ResourceRequest) => AGENTS.find(a => a.id === r.agentId)!;

function timeAgo(minutes: number): string {
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

type Engineer = 'idle' | 'working' | 'replied';

function RequestRow({
  request,
  showOwner,
  onDecide,
  onGone,
}: {
  request: ResourceRequest;
  showOwner: boolean;
  onDecide: (r: RequestResolution) => void;
  onGone: () => void;
}) {
  const agent = agentOf(request);
  const DeptIcon = DEPARTMENT_ICON[agent.department];
  const [open, setOpen] = useState(false);
  const [drawer, setDrawer] = useState<'diy' | 'reject' | null>(null);
  const [note, setNote] = useState('');
  const [engineer, setEngineer] = useState<Engineer>('idle');
  const [leaving, setLeaving] = useState<RequestResolution | null>(null);
  const [collapsing, setCollapsing] = useState(false);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));

  const resolve = (r: RequestResolution) => {
    if (leaving) return;
    setDrawer(null);
    setLeaving(r);
    onDecide(r);
    later(EXIT_MS, () => setCollapsing(true));
    later(EXIT_MS + COLLAPSE_MS, onGone);
  };

  // PLACEHOLDER: simulated Fleet Engineer. Succeeds -> the request leaves;
  // can't -> it adds an addendum explaining why, and the request stays.
  const taskEngineer = () => {
    setDrawer(null);
    setEngineer('working');
    later(ENGINEER_MS, () => {
      if (request.engineerReply.ok) resolve('engineered');
      else setEngineer('replied');
    });
  };

  const openDrawer = (kind: 'diy' | 'reject', e: React.MouseEvent) => {
    if (e.shiftKey) return resolve(kind === 'diy' ? 'diy' : 'rejected'); // shift-click: no note
    setDrawer(d => (d === kind ? null : kind));
  };

  return (
    <div className={`request-wrap${collapsing ? ' collapsing' : ''}`}>
      <article className={`request${open ? ' open' : ''}${leaving ? ` leaving ${leaving}` : ''}`}>
        <button className="request-row" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <ChevronRight size={15} className="request-chevron" />
          <DeptIcon size={15} strokeWidth={1.75} className="request-dept" />
          <span className="request-agent">{agent.name}</span>
          <span className="request-summary">{request.summary}</span>
          {engineer === 'working' && (
            <span className="request-status working">
              <Loader2 size={12} className="spin" />
              Fleet Engineer
            </span>
          )}
          {engineer === 'replied' && <span className="request-status">Engineer replied</span>}
          {showOwner && (
            <span className="request-owner" title="Owner">
              <User size={12} strokeWidth={1.75} />
              {agent.owner}
            </span>
          )}
          <span className="request-time">{timeAgo(request.minutesAgo)}</span>
        </button>

        <div className="request-expand" {...(open ? {} : { inert: '' })}>
          <div className="request-clip">
            <div className="request-body">
              <p className="request-detail">{request.detail}</p>

              {/* How it got here: what the agency already tried. */}
              <ol className="request-trail">
                {request.trail.map((step, i) => (
                  <li key={i}>
                    <span className="trail-by">{step.by}</span>
                    <span className="trail-text">{step.text}</span>
                  </li>
                ))}
              </ol>

              {engineer === 'replied' && (
                <div className="request-addendum">
                  <span className="addendum-by">
                    <Hammer size={13} strokeWidth={1.75} />
                    Fleet Engineer · addendum
                  </span>
                  {request.engineerReply.text}
                </div>
              )}

              <div className="request-actions">
                <button
                  className="rq-btn engineer"
                  onClick={taskEngineer}
                  disabled={engineer === 'working' || !!leaving}
                >
                  {engineer === 'working' ? <Loader2 size={14} className="spin" /> : <Hammer size={14} strokeWidth={1.9} />}
                  {engineer === 'working' ? 'Fleet Engineer is on it' : engineer === 'replied' ? 'Task again' : 'Task Fleet Engineer'}
                </button>

                <div className="ide-group" title="Coming soon - needs the IDE connector">
                  <span className="ide-label">Send to your AI IDE</span>
                  {IDES.map(ide => (
                    <button key={ide} className="rq-chip" disabled>
                      {ide}
                    </button>
                  ))}
                </div>

                <div className="request-own">
                  <button
                    className={`rq-btn diy${drawer === 'diy' ? ' on' : ''}`}
                    onClick={e => openDrawer('diy', e)}
                    disabled={!!leaving}
                    title="Shift-click to mark done without a note"
                  >
                    <Hand size={14} strokeWidth={1.9} />
                    DIY
                  </button>
                  <button
                    className={`rq-btn reject${drawer === 'reject' ? ' on' : ''}`}
                    onClick={e => openDrawer('reject', e)}
                    disabled={!!leaving}
                    title="Shift-click to reject without a reason"
                  >
                    <X size={14} strokeWidth={2.25} />
                    Reject
                  </button>
                </div>
              </div>

              {/* DIY / Reject note: same slide-open box as Approvals, optional. */}
              <div className={`reject-drawer${drawer ? ' open' : ''}`} {...(drawer ? {} : { inert: '' })}>
                <div className="reject-clip">
                  <div className="reject-inner">
                    <textarea
                      className="reject-reason"
                      placeholder={
                        drawer === 'reject'
                          ? 'Reason for rejecting, the agent will see this (optional)'
                          : 'What you did and how it fixed it, the agent will see this (optional)'
                      }
                      value={note}
                      onChange={e => setNote(e.target.value)}
                      rows={2}
                    />
                    <div className="reject-actions">
                      <button className="ap-btn ghost" onClick={() => setDrawer(null)}>
                        Cancel
                      </button>
                      <button
                        className={`ap-btn ${drawer === 'reject' ? 'confirm-reject' : 'confirm-diy'}`}
                        onClick={() => resolve(drawer === 'reject' ? 'rejected' : 'diy')}
                      >
                        {drawer === 'reject' ? (
                          <>Reject{note.trim() ? ' with reason' : ''}</>
                        ) : (
                          <>
                            <Check size={14} strokeWidth={2.25} />
                            Mark done
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}

export function Requests({
  pending,
  scope,
  agentFilter,
  onDecide,
  onGone,
}: {
  pending: ResourceRequest[];
  scope: ApprovalScope;
  agentFilter: string | null;
  onDecide: (id: string, r: RequestResolution) => void;
  onGone: (id: string) => void;
}) {
  const shown = visibleApprovals(pending, scope)
    .filter(r => !agentFilter || r.agentId === agentFilter)
    .sort((a, b) => b.minutesAgo - a.minutesAgo); // oldest first

  if (shown.length === 0) {
    return <div className="main-empty">{scope === 'all' ? 'No requests are waiting.' : 'No requests are waiting on you.'}</div>;
  }

  return (
    <div className="requests">
      {shown.map(r => (
        <RequestRow
          key={r.id}
          request={r}
          showOwner={!!ACCOUNT.org && scope === 'all'}
          onDecide={res => onDecide(r.id, res)}
          onGone={() => onGone(r.id)}
        />
      ))}
    </div>
  );
}
