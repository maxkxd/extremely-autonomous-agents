import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Code2, Hammer, Hand, Loader2, SendHorizontal, User, X } from 'lucide-react';
import { siClaude, siCursor, type SimpleIcon } from 'simple-icons';
import { ACCOUNT, AGENTS, type ResourceRequest } from './data';
import { DEPARTMENT_ICON } from './Sidebar';
import { visibleApprovals, type ApprovalScope, type Resolution } from './Approvals';

// How a request left the page: you did it, you rejected it, or the Fleet
// Engineer sorted it after you tasked it.
export type RequestResolution = 'diy' | 'rejected' | 'engineered';

// AI IDEs a request can be handed to. Not built yet: needs a connector that
// finds and opens the IDE, and this system's MCP inside it (docs/requests.md).
// Logos are Simple Icons where they exist; Codex and Antigravity aren't in
// that set, so they show a generic code icon until their logos are added.
export const AI_IDES = {
  'claude-code': { name: 'Claude Code', logo: siClaude },
  cursor: { name: 'Cursor', logo: siCursor },
  codex: { name: 'Codex', logo: null },
  antigravity: { name: 'Antigravity', logo: null },
} satisfies Record<string, { name: string; logo: SimpleIcon | null }>;

export type IdeId = keyof typeof AI_IDES;

// Which AI IDE you use (Settings > Account); the button's name and logo follow it.
const IDE_KEY = 'eaa.ide';
export function yourIde(): IdeId {
  try {
    const v = localStorage.getItem(IDE_KEY);
    if (v && v in AI_IDES) return v as IdeId;
  } catch {
    // Storage unavailable - use the default.
  }
  return 'claude-code';
}
export function setYourIde(id: IdeId) {
  try {
    localStorage.setItem(IDE_KEY, id);
  } catch {
    // Storage unavailable - it lasts until the page reloads.
  }
}

export function IdeLogo({ logo }: { logo: SimpleIcon | null }) {
  if (!logo) return <Code2 size={15} strokeWidth={1.9} />;
  return (
    <svg viewBox="0 0 24 24" width={15} height={15} role="img" aria-hidden fill={`#${logo.hex}`}>
      <path d={logo.path} />
    </svg>
  );
}

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
// exists. It follows the real rules: always tell the person what to do next
// (never just "why it can't"), and know the app's buttons well enough to steer
// people to them (docs/fleet-engineer-ui-guide.md). Building a tool is always
// a human approval, never something it just does. Simple keyword matching.
const SAYS_DONE = /\b(done|did it|finished|sorted|set (it )?up|added|bought|got (it|the)|created|uploaded|it'?s (the )?20\d\d)\b/i;
const LOOKS_SECRET = /\b(sk-[A-Za-z0-9]{8,}|(api[ _-]?key|password|passwd|token|secret)\s*[:=]\s*\S+|[A-Za-z0-9_\-]{32,})/i;
const MENTIONS_SECRET = /\b(api[ _-]?keys?|passwords?|tokens?|secrets?|credentials?|log ?ins?)\b/i;
const WANTS_DIY = /\b(diy|myself|i('ll| will) (do|handle|sort|fix) (it|this))\b/i;
const WANTS_REJECT = /\b(reject|don'?t (want|need)|not (needed|doing)|no thanks|cancel|forget it|ignore)\b/i;
const ASKS_IDE = /\b(claude|cursor|codex|antigravity|ide)\b/i;
const ASKS_HELP = /\b(help|how do i|what do i|what now|confus\w*|which button|where (do|is))\b|\?\s*$/i;

function engineerReply(request: ResourceRequest, latest: string, waitingOnApproval: boolean) {
  const { engineer } = request;
  const agentName = agentOf(request).name;
  const say = (text: string, readyToBuild = false) => ({ text, readyToBuild });

  if (LOOKS_SECRET.test(latest)) {
    return say(
      "That looks like a key or password - please don't share secrets in chat. Keys go in Settings > Connections (coming soon); for now just tell me it's done and I'll leave a slot for the key.",
    );
  }
  if (waitingOnApproval) {
    return say(
      `Replying here doesn't approve it. Open Approvals (the button above, or Approvals in the sidebar) and press Approve on "Fleet Engineer wants to build a new tool for ${agentName}: ${engineer.build.toolName}". Once it's approved I'll build it and close this request.`,
    );
  }
  if (WANTS_DIY.test(latest)) {
    return say(
      "If you'd rather handle it yourself, press DIY under this conversation. You can add a note on what you did (optional) - the agent will see it - and the request closes.",
    );
  }
  if (WANTS_REJECT.test(latest)) {
    return say(
      `If ${agentName} doesn't need this, press Reject under this conversation. Add a reason if you like (optional) - ${agentName} will see it and stop asking.`,
    );
  }
  if (ASKS_IDE.test(latest)) {
    return say(
      "The Send to your-IDE button isn't live yet. When it is, it'll open your AI IDE with this request ready as a prompt, for anything that has to happen off-platform. Until then: follow the steps above, or press DIY if you handle it yourself.",
    );
  }
  if (MENTIONS_SECRET.test(latest)) {
    return say(
      "Don't paste keys or passwords here. They'll go in Settings > Connections once that's built. Just reply \"done\" when you have them and I'll build the tool with a slot for the key.",
    );
  }
  if (engineer.canDoNow || SAYS_DONE.test(latest)) {
    return say(`I've designed "${engineer.build.toolName}" for ${agentName}. Building it needs your approval - it's waiting in Approvals.`, true);
  }
  if (ASKS_HELP.test(latest)) {
    return say(
      'Everything I need is in my first message above. Once those steps are done, reply "done" here and I\'ll design the tool. Other options are below: DIY if you handle it yourself, Reject if it isn\'t needed.',
    );
  }
  return say("Got it. Work through the steps above, then reply here (just \"done\" is fine) and I'll design the tool.");
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
  onDecide: (r: RequestResolution, note: string) => void;
  onGone: () => void;
  onProposeBuild: () => string; // raises the build approval, returns its id
  approvalOutcomes: Record<string, Resolution>;
  onOpenApprovals: () => void;
  convo: Convo;
  updateConvo: (fn: (c: Convo) => Convo) => void;
}) {
  const agent = agentOf(request);
  const DeptIcon = DEPARTMENT_ICON[agent.department];
  // Requests start closed - unless you've already replied in one, so you can
  // pick the conversation back up (e.g. after approving its build).
  const [open, setOpen] = useState(convo.thread.some(m => m.from === 'you'));
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
    onDecide(r, note);
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
      const reply = engineerReply(request, mine, waitingOnApproval);
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
                {replying && !leaving && !finished && (
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
                {!request.live && !replying && !waitingOnApproval && !finished && (
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

                {/* Opens your AI IDE with this request as a prompt - not built yet. */}
                <button
                  className="rq-btn ide"
                  disabled
                  title={`Coming soon - opens ${AI_IDES[yourIde()].name} with this request (needs the IDE connector)`}
                >
                  <IdeLogo logo={AI_IDES[yourIde()].logo} />
                  Send to {AI_IDES[yourIde()].name}
                </button>

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
  onDecide: (id: string, r: RequestResolution, note: string) => void;
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
          onDecide={(res, note) => onDecide(r.id, res, note)}
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
