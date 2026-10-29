import { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Code2, Hammer, Hand, Loader2, SendHorizontal, User, X } from 'lucide-react';
import { siClaude, siCursor, type SimpleIcon } from 'simple-icons';
import { ACCOUNT, AGENTS, type ResourceRequest } from './data';
import { DEPARTMENT_ICON } from './Sidebar';
import { visibleApprovals, type ApprovalScope } from './Approvals';
import { sendRequestMessage, sendToIde } from './builder';
import { RichText } from './RichText';

// How a request left the page: you did it, or you rejected it. (One the Fleet
// Engineer settles is closed on the server.)
export type RequestResolution = 'diy' | 'rejected';

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

const EXIT_MS = 620;
const COLLAPSE_MS = 240;

const agentOf = (r: ResourceRequest) => AGENTS.find(a => a.id === r.agentId)!;

function timeAgo(minutes: number): string {
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

type Message = { from: 'you' | 'engineer'; text: string };
type Drawer = 'diy' | 'reject';

const DRAWER_HINT: Record<Drawer, string> = {
  diy: 'What you did and how it fixed it, the agent will see this (optional)',
  reject: 'Reason for rejecting, the agent will see this (optional)',
};

// One request: what the agent asked, and its conversation with the Fleet
// Engineer (kept on the server; what you just sent shows until it's there).
// Where it stands is the server's: the engineer has it, it waits on you, or
// its go-live waits on approval.
function RequestRow({
  request,
  showOwner,
  onDecide,
  onGone,
  onOpenApprovals,
  refs,
  spotlight,
  onFocused,
}: {
  request: ResourceRequest;
  showOwner: boolean;
  onDecide: (r: RequestResolution, note: string) => void;
  onGone: () => void;
  onOpenApprovals: (approvalId?: string | null) => void; // takes you to that approval
  refs: RequestRefs; // other requests named in its text, as links
  spotlight: boolean; // you came here for this one - open it, centre it and glow
  onFocused: () => void;
}) {
  const agent = agentOf(request);
  const DeptIcon = DEPARTMENT_ICON[agent.department];
  // Closed unless it's waiting on you.
  const [open, setOpen] = useState(request.stage === 'waiting_you' || request.stage === 'person');
  // Arriving for this one (a link from another request): open, centred, a blue glow.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [spotlit, setSpotlit] = useState(false);
  useEffect(() => {
    if (!spotlight) return;
    setOpen(true);
    // Once it's open (0.28s), its top into view: an open request can be taller than the window.
    window.setTimeout(() => wrapRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 320);
    setSpotlit(true);
    onFocused();
    window.setTimeout(() => setSpotlit(false), 2600);
  }, [spotlight]);
  const [drawer, setDrawer] = useState<Drawer | null>(null);
  const [note, setNote] = useState('');
  const [echo, setEcho] = useState<Message[]>([]);
  const mineBefore = useRef(0);
  const serverThread = request.liveThread ?? [];
  useEffect(() => {
    if (echo.length && serverThread.filter(m => m.from === 'you').length >= echo.length + mineBefore.current) setEcho([]);
  }, [serverThread.length]);
  const thread: Message[] = [...serverThread, ...echo];
  const [draft, setDraft] = useState('');
  const [leaving, setLeaving] = useState<RequestResolution | 'done' | null>(null);
  const [collapsing, setCollapsing] = useState(false);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, fn: () => void) => timers.current.push(window.setTimeout(fn, ms));

  // Closed elsewhere - done (green, off to the right) or turned down (red, off to
  // the left) - it leaves like one you closed, open or folded.
  useEffect(() => {
    if (!request.closedAs || leaving) return;
    setDrawer(null);
    setLeaving(request.closedAs);
    later(EXIT_MS, () => setCollapsing(true));
    later(EXIT_MS + COLLAPSE_MS, onGone);
  }, [request.closedAs]);

  const resolve = (r: RequestResolution) => {
    if (leaving) return;
    setDrawer(null);
    setLeaving(r);
    onDecide(r, note);
    later(EXIT_MS, () => setCollapsing(true));
    later(EXIT_MS + COLLAPSE_MS, onGone);
  };

  const send = (text: string) => {
    const mine = text.trim();
    if (!mine || leaving || !request.live) return;
    mineBefore.current = serverThread.filter(m => m.from === 'you').length;
    setEcho(e => [...e, { from: 'you', text: mine }]);
    setDraft('');
    sendRequestMessage(request.live, mine).catch(e => {
      setEcho([]);
      setDraft(mine);
      window.alert((e as Error).message);
    });
  };

  // The IDE opens on the request; ones without a terminal start get the prompt
  // on the clipboard to paste.
  const [sending, setSending] = useState(false);
  const sendIde = async () => {
    if (!request.live) return;
    setSending(true);
    try {
      const r = await sendToIde(request.live, yourIde());
      const terminal = yourIde() === 'claude-code' || yourIde() === 'codex';
      if (!r.opened || !terminal) await navigator.clipboard?.writeText(r.prompt).catch(() => {});
      if (!r.opened) window.alert(`${r.ide} isn't installed where the app can start it. The request is ready in ${r.folder} - open that folder in ${r.ide} and paste the prompt (copied).`);
      else if (!terminal) window.alert(`${r.ide} is opening the request's folder. Paste the prompt (copied) into its chat.`);
    } catch (e) {
      window.alert((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const openDrawer = (kind: Drawer, e: React.MouseEvent) => {
    if (e.shiftKey) return resolve(kind === 'diy' ? 'diy' : 'rejected'); // shift-click: no note
    setDrawer(d => (d === kind ? null : kind));
  };

  const waitingOnApproval = request.stage === 'approval';
  const waitingOnYou = !leaving && (request.stage === 'waiting_you' || request.stage === 'person');
  const engineerOnIt = !leaving && (request.stage === 'engineer' || echo.length > 0);
  const typing = !!request.busy || echo.length > 0;

  return (
    <div className={`request-wrap${collapsing ? ' collapsing' : ''}`} ref={wrapRef}>
      <article className={`request${open ? ' open' : ''}${leaving ? ` leaving ${leaving}` : spotlit ? ' spotlit' : ''}`}>
        <button className="request-row" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <ChevronRight size={15} className="request-chevron" />
          <DeptIcon size={15} strokeWidth={1.75} className="request-dept" />
          <span className="request-agent">{agent.name}</span>
          <span className="request-summary">{request.summary}</span>
          {engineerOnIt && (
            <span className="request-status working">
              <Loader2 size={12} className="spin" />
              Agency Engineer
            </span>
          )}
          {waitingOnYou && <span className="request-status waiting">{request.stage === 'person' ? 'Needs you' : 'Waiting on you'}</span>}
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
              <div className="request-detail">
                <RichText text={request.detail} {...refs} />
              </div>

              {/* Conversation with the Agency Engineer. */}
              <div className="eng-chat">
                {thread.map((m, i) => (
                  <div key={i} className={`eng-msg ${m.from}`}>
                    {m.from === 'engineer' && (
                      <span className="eng-by">
                        <Hammer size={12} strokeWidth={1.9} />
                        Agency Engineer
                      </span>
                    )}
                    <div className="eng-text">
                      <RichText text={m.text} {...refs} />
                    </div>
                  </div>
                ))}
                {typing && (
                  <div className="eng-msg engineer">
                    <span className="eng-by">
                      <Hammer size={12} strokeWidth={1.9} />
                      Agency Engineer
                    </span>
                    <div className="eng-text typing">
                      <span />
                      <span />
                      <span />
                    </div>
                  </div>
                )}
                {waitingOnApproval && (
                  <button className="rq-btn open-approvals" onClick={() => onOpenApprovals(request.approvalId)}>
                    Open Approvals
                  </button>
                )}
                {open && !leaving && (
                  <div className="eng-composer">
                    <textarea
                      className="reject-reason"
                      rows={2}
                      placeholder="Reply to the Agency Engineer"
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      onKeyDown={e => {
                        // Enter sends, Shift+Enter is a new line.
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          if (draft.trim()) send(draft);
                        }
                      }}
                    />
                    <div className="reject-actions">
                      <span className="drawer-hint">Don't paste API keys or passwords here - they go in Settings -&gt; Connectors.</span>
                      <button className="ap-btn confirm-engineer" onClick={() => send(draft)} disabled={!draft.trim()}>
                        <SendHorizontal size={14} strokeWidth={1.9} />
                        Send
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div className="request-actions">
                {/* Your AI IDE, with this request and the agency's tools (runner/ide.ts). */}
                <button
                  className="rq-btn ide"
                  disabled={!!leaving || sending}
                  title={`Opens ${AI_IDES[yourIde()].name} on this request, with the agency's tools`}
                  onClick={sendIde}
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
                      placeholder={drawer ? DRAWER_HINT[drawer] : ''}
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
              {/* Its number, which other requests (and the Agency Engineer) refer to it by. */}
              {request.live && <span className="request-id">#{request.live}</span>}
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}

// Other requests named in a request's text ("request #41"): which can be opened
// (they're on this page), and how.
export type RequestRefs = { onRequest: (id: number) => void; canOpen: (id: number) => boolean; onSettings: (integration: string | null) => void };

export function Requests({
  pending,
  scope,
  agentFilter,
  onDecide,
  onGone,
  onOpenApprovals,
  refs,
  focus,
  onFocused,
}: {
  pending: ResourceRequest[];
  scope: ApprovalScope;
  agentFilter: string | null;
  onDecide: (id: string, r: RequestResolution, note: string) => void;
  onGone: (id: string) => void;
  onOpenApprovals: (approvalId?: string | null) => void;
  refs: RequestRefs;
  focus: number | null; // the request to bring into view (its number)
  onFocused: () => void;
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
          onOpenApprovals={onOpenApprovals}
          refs={refs}
          spotlight={r.live === focus}
          onFocused={onFocused}
        />
      ))}
    </div>
  );
}
