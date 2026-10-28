import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Hammer, Hand, Loader2, SendHorizontal, User, X } from 'lucide-react';
import { ACCOUNT, AGENTS, type ResourceRequest } from './data';
import { DEPARTMENT_ICON } from './Sidebar';
import { visibleApprovals, type ApprovalScope, type Resolution } from './Approvals';

// How a request left the page: you did it, you rejected it, or the Fleet
// Engineer sorted it after you tasked it.
export type RequestResolution = 'diy' | 'rejected' | 'engineered';

// AI IDEs a request can be handed to. Not built yet: needs a connector that
// finds and opens the IDE, and this system's MCP inside it (docs/requests.md).
const IDES = ['Claude Code', 'Cursor', 'Antigravity', 'Codex'];

// PLACEHOLDER timings for the simulated Fleet Engineer.
const ENGINEER_MS = 2200; // thinking before each reply
const READ_MS = 1800; // time to read its final reply before the request leaves
const EXIT_MS = 620;
const COLLAPSE_MS = 240;

const agentOf = (r: ResourceRequest) => AGENTS.find(a => a.id === r.agentId)!;

function timeAgo(minutes: number): string {
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

type Message = { from: 'you' | 'engineer'; text: string };

// A request's conversation with the Fleet Engineer. Kept by the app, not the
// row, so it survives leaving the page (e.g. to approve the build).
// Every conversation opens with the engineer's instructions for this request.
export type Convo = { thread: Message[]; buildApproval: string | null };
export const startConvo = (r: ResourceRequest): Convo => ({
  thread: [{ from: 'engineer', text: r.engineer.plan }],
  buildApproval: null,
});
type Drawer = 'diy' | 'reject';

const PLACEHOLDER: Record<Drawer, string> = {
  diy: 'What you did and how it fixed it, the agent will see this (optional)',
  reject: 'Reason for rejecting, the agent will see this (optional)',
};

// PLACEHOLDER: the simulated Fleet Engineer's next reply, until the real one
// exists. It follows the real rule: never just "why it can't" - its first
// reply is always what you need to do. Once it can, it designs the tool and
// asks to build it - which is a human approval, not something it just does.
const SAYS_DONE = /\b(done|did it|finished|sorted|set (it )?up|added|bought|got (it|the)|created|uploaded|it'?s (the )?20\d\d)\b/i;
function engineerReply(request: ResourceRequest, latest: string) {
  const { engineer } = request;
  const ready = engineer.canDoNow || SAYS_DONE.test(latest);
  if (ready) {
    return {
      text: `I've designed "${engineer.build.toolName}" for ${agentOf(request).name}. Building it needs your approval - it's waiting in Approvals.`,
      readyToBuild: true,
    };
  }
  return {
    text: "Got it. Work through the steps above, then reply here (just \"done\" is fine) and I'll design the tool.",
    readyToBuild: false,
  };
}

function RequestRow({
  request,
  showOwner,
  onDecide,
  onGone,
  onProposeBuild,
  approvalOutcomes,
  onOpenApprovals,
  convo,
  updateConvo,
}: {
  request: ResourceRequest;
  showOwner: boolean;
  onDecide: (r: RequestResolution) => void;
  onGone: () => void;
  onProposeBuild: () => string; // raises the build approval, returns its id
  approvalOutcomes: Record<string, Resolution>;
  onOpenApprovals: () => void;
  convo: Convo;
  updateConvo: (fn: (c: Convo) => Convo) => void;
}) {
  const agent = agentOf(request);
  const DeptIcon = DEPARTMENT_ICON[agent.department];
  // Requests with a conversation in progress open already expanded.
  const [open, setOpen] = useState(convo.thread.length > 0);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [note, setNote] = useState('');
  // The conversation with the Fleet Engineer about this request.
  const { thread, buildApproval } = convo;
  // The reply box: opened by "Task Fleet Engineer", or already open once you've replied.
  const [replying, setReplying] = useState(thread.some(m => m.from === 'you'));
  const setThread = (fn: (t: Message[]) => Message[]) => updateConvo(c => ({ ...c, thread: fn(c.thread) }));
  const setBuildApproval = (id: string | null) => updateConvo(c => ({ ...c, buildApproval: id }));
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const [finished, setFinished] = useState(false); // engineer has done it; request about to leave
  const [leaving, setLeaving] = useState<RequestResolution | null>(null);
  const [collapsing, setCollapsing] = useState(false);
  const composer = useRef<HTMLTextAreaElement>(null);
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

  // Send a message to the Fleet Engineer (an empty one just tasks it).
  const send = (text: string) => {
    if (thinking || leaving) return;
    const mine = text.trim();
    const sent: Message[] = mine ? [...thread, { from: 'you', text: mine }] : thread;
    setThread(() => sent);
    setDraft('');
    setReplying(true);
    setDrawer(null);
    setThinking(true);
    later(ENGINEER_MS, () => {
      const reply = engineerReply(request, mine);
      setThread(t => [...t, { from: 'engineer', text: reply.text }]);
      setThinking(false);
      if (reply.readyToBuild) setBuildApproval(onProposeBuild());
    });
  };

  // The build approval was decided (on the Approvals page, or it expired).
  const outcome = buildApproval ? approvalOutcomes[buildApproval] : undefined;
  useEffect(() => {
    if (!outcome) return;
    if (outcome === 'approved') {
      setThread(t => [...t, { from: 'engineer', text: request.engineer.done }]);
      setFinished(true);
      later(READ_MS, () => resolve('engineered'));
    } else {
      setThread(t => [
        ...t,
        {
          from: 'engineer',
          text:
            outcome === 'rejected'
              ? "The build was rejected. Tell me what to change and I'll redesign it - or sort it another way with DIY."
              : "The build approval expired before anyone answered. Reply here and I'll raise it again.",
        },
      ]);
      setBuildApproval(null);
    }
  }, [outcome]);

  const taskEngineer = (e: React.MouseEvent) => {
    if (e.shiftKey) return send(''); // shift-click: go ahead without a note
    setReplying(true);
    setDrawer(null);
    setTimeout(() => composer.current?.focus(), 30);
  };

  const openDrawer = (kind: Drawer, e: React.MouseEvent) => {
    if (e.shiftKey) return resolve(kind === 'diy' ? 'diy' : 'rejected'); // shift-click: no note
    setDrawer(d => (d === kind ? null : kind));
  };

  const last = thread[thread.length - 1];
  const waitingOnApproval = !!buildApproval && !outcome;
  const started = thread.some(m => m.from === 'you');
  const waitingOnYou = started && !thinking && !leaving && !finished && !waitingOnApproval && last?.from === 'engineer';

  return (
    <div className={`request-wrap${collapsing ? ' collapsing' : ''}`}>
      <article className={`request${open ? ' open' : ''}${leaving ? ` leaving ${leaving}` : ''}`}>
        <button className="request-row" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <ChevronRight size={15} className="request-chevron" />
          <DeptIcon size={15} strokeWidth={1.75} className="request-dept" />
          <span className="request-agent">{agent.name}</span>
          <span className="request-summary">{request.summary}</span>
          {thinking && (
            <span className="request-status working">
              <Loader2 size={12} className="spin" />
              Fleet Engineer
            </span>
          )}
          {waitingOnYou && <span className="request-status waiting">Waiting on you</span>}
          {waitingOnApproval && <span className="request-status approval">Waiting on approval</span>}
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

              {/* Conversation with the Fleet Engineer. */}
              <div className="eng-chat">
                {thread.map((m, i) => (
                  <div key={i} className={`eng-msg ${m.from}`}>
                    {m.from === 'engineer' && (
                      <span className="eng-by">
                        <Hammer size={12} strokeWidth={1.9} />
                        Fleet Engineer
                      </span>
                    )}
                    <div className="eng-text">{m.text}</div>
                  </div>
                ))}
                {thinking && (
                  <div className="eng-msg engineer">
                    <span className="eng-by">
                      <Hammer size={12} strokeWidth={1.9} />
                      Fleet Engineer
                    </span>
                    <div className="eng-text typing">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                )}
                {waitingOnApproval && (
                  <button className="rq-btn open-approvals" onClick={onOpenApprovals}>
                    Open Approvals
                  </button>
                )}
                {replying && !leaving && !finished && !waitingOnApproval && (
                  <div className="eng-composer">
                    <textarea
                      ref={composer}
                      className="reject-reason"
                      rows={2}
                      placeholder={
                        'Reply to the Fleet Engineer, e.g. "I\'ll get a seat - what do you need?" or "done"'
                      }
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        // Enter sends, Shift+Enter is a new line.
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          if (draft.trim()) send(draft);
                        }
                      }}
                      disabled={thinking}
                    />
                    <div className="reject-actions">
                      {/* Keys go in the (future) settings, never in a chat message. */}
                      <span className="drawer-hint">Don't paste API keys or passwords here - you'll add those in settings.</span>
                      <button
                        className="ap-btn confirm-engineer"
                        onClick={() => send(draft)}
                        disabled={thinking || !draft.trim()}
                      >
                        <SendHorizontal size={14} strokeWidth={1.9} />
                        Send
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="request-actions">
                {!replying && !waitingOnApproval && !finished && (
                  <button
                    className="rq-btn engineer"
                    onClick={taskEngineer}
                    disabled={!!leaving}
                    title="Shift-click to tell it to go ahead without a note"
                  >
                    <Hammer size={14} strokeWidth={1.9} />
                    Reply to Fleet Engineer
                  </button>
                )}

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
                      placeholder={drawer ? PLACEHOLDER[drawer] : ''}
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
  onProposeBuild,
  approvalOutcomes,
  onOpenApprovals,
  convos,
  updateConvo,
}: {
  pending: ResourceRequest[];
  scope: ApprovalScope;
  agentFilter: string | null;
  onDecide: (id: string, r: RequestResolution) => void;
  onGone: (id: string) => void;
  onProposeBuild: (r: ResourceRequest) => string;
  approvalOutcomes: Record<string, Resolution>;
  onOpenApprovals: () => void;
  convos: Record<string, Convo>;
  updateConvo: (id: string, fn: (c: Convo) => Convo) => void;
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
          onProposeBuild={() => onProposeBuild(r)}
          approvalOutcomes={approvalOutcomes}
          onOpenApprovals={onOpenApprovals}
          convo={convos[r.id] ?? startConvo(r)}
          updateConvo={fn => updateConvo(r.id, fn)}
        />
      ))}
    </div>
  );
}
