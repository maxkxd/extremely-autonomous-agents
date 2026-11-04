import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, CircleStop, Loader2, SendHorizontal } from 'lucide-react';
import { Linkify } from './Linkify';
import { RichText } from './RichText';
import { ACCOUNT, AGENTS } from './data';
import { currentOrg, isAdmin, myAccountId } from './account';
import { DEPARTMENT_ICON } from './Sidebar';
import type { DmEntry, RunPost, ToolLine } from './dms';
import type { Resolution } from './Approvals';
import { Loading, Skel, SkelLines } from './Skeleton';
import { getTools } from './builder';
import { useOffline } from './offline';
import { clockTime } from './clock';

// Placeholder history is "minutes ago"; pin it to the page's load time.
const loadedAt = Date.now();
export type StampedEntry = DmEntry & { at: number };
export const stamp = (e: DmEntry, at = loadedAt - e.minutesAgo * 60_000): StampedEntry => ({ ...e, at });

// The app's one clock format (clock.ts), everywhere it shows a time.
const clock = clockTime;
// A tool the list doesn't know (yet): write_file -> Write file.
const plainTool = (id: string) => (id.charAt(0).toUpperCase() + id.slice(1)).replace(/[_-]+/g, ' ');

function dayLabel(t: number) {
  const d = new Date(t);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
}

// A human-approved call is pending until its approval is decided.
type ToolState = 'ok' | 'failed' | 'pending';
function toolState(t: ToolLine, outcomes: Record<string, Resolution>): ToolState {
  if (!t.approvalId) return t.status;
  // Decided this session, or as the server last knew it (after a reload).
  const o = outcomes[t.approvalId] ?? (t.decided && t.decided !== 'pending' ? t.decided : undefined);
  return o === 'approved' ? 'ok' : o ? 'failed' : 'pending';
}
const TOOL_TITLE: Record<ToolState, string> = { ok: 'Succeeded', failed: 'Failed', pending: 'Waiting on approval' };

// Counting up while it works on your message.
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return <span className="dm-elapsed"> {duration(Math.max(0, Math.round((now - since) / 1000)))}</span>;
}

const duration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);

export function RunPostView({
  post,
  agentName,
  Icon,
  outcomes,
  silent,
  names,
}: {
  post: StampedEntry & RunPost;
  agentName: string;
  Icon: typeof CircleCheck;
  outcomes: Record<string, Resolution>;
  silent?: Set<string>; // its Silent tools (Settings > Tools): done without a word, so not listed here
  names?: Map<string, { name: string; source: string }>; // each tool's plain name and where it acts (Settings > Tools)
}) {
  const shown = post.tools.filter(t => !silent?.has(`${t.server}.${t.tool}`));
  const ok = post.outcome === 'succeeded';
  const stopped = post.outcome === 'stopped'; // a person stopped it: not a failure
  return (
    <div className="dm-post">
      <div className="dm-avatar agent">
        <Icon size={16} strokeWidth={1.75} />
      </div>
      <div className="dm-post-main">
        <div className="dm-post-head">
          <span className="dm-author">{agentName}</span>
          <span className="dm-time">{clock(post.at)}</span>
        </div>
        {/* Status line: outcome, run id, trigger, actions, cost, duration. */}
        {/* The run id is kept for debugging but not shown: hover the line to see
            it, click to copy it (e.g. to ask the Agency Engineer about a run). */}
        <button
          className={`dm-runline${ok ? '' : stopped ? ' stopped' : ' failed'}`}
          title={`Run ${post.id} - click to copy`}
          onClick={() => navigator.clipboard?.writeText(post.id).catch(() => {})}
        >
          {ok ? <CircleCheck size={13} strokeWidth={2} /> : stopped ? <CircleStop size={13} strokeWidth={2} /> : <CircleAlert size={13} strokeWidth={2} />}
          {post.trigger} · {post.tools.length} action{post.tools.length === 1 ? '' : 's'} · {post.costKnown === false ? 'cost unknown' : `$${post.cost.toFixed(2)}`} ·{' '}
          {duration(post.seconds)}
        </button>
        <div className="dm-text">
          <RichText text={post.text} />
        </div>
        {shown.length > 0 && (
          <ul className="dm-tools">
            {shown.map((t, i) => (
              <li key={i}>
                <span className={`dm-tool-dot ${toolState(t, outcomes)}`} title={TOOL_TITLE[toolState(t, outcomes)]} />
                {/* Its plain name, as Settings > Tools and requests say it (not computer_files · write_file · path, content). */}
                {names?.get(`${t.server}.${t.tool}`)?.name ?? plainTool(t.tool)}
                <span className="dm-tool-fields"> · {names?.get(`${t.server}.${t.tool}`)?.source ?? plainTool(t.server)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function AgentDM({
  agentId,
  entries,
  thinking,
  onSend,
  approvalOutcomes,
  loading = false,
  stopped = false,
  agencyStopped = false,
  sendError = null,
  onOpenDashboard,
  since = null,
}: {
  onOpenDashboard?: () => void; // a stopped agent's reply links to where it's resumed
  since?: number | null; // when the message it's answering was sent: "running... 2m"
  agentId: string;
  stopped?: boolean; // it or the agency is stopped: it won't answer until it's resumed
  agencyStopped?: boolean; // ...and it's the whole agency
  sendError?: string | null; // the message wasn't taken (e.g. it's stopped): why
  loading?: boolean; // its history isn't in yet: placeholders, not "No agent activity yet"
  entries: StampedEntry[];
  thinking: boolean;
  onSend: (text: string) => void;
  approvalOutcomes: Record<string, Resolution>;
}) {
  const agent = AGENTS.find(a => a.id === agentId)!;
  const Icon = DEPARTMENT_ICON[agent.department];
  // A teammate's agent: its chat is there to read; only its maker or an admin writes in it.
  // Everyone may write to the Agency Engineer.
  const readOnly = !!currentOrg() && !isAdmin() && agent.id !== 'fleet' && (agent.builtIn || agent.ownerId !== myAccountId());
  const readOnlyWhy = readOnly ? `Only ${agent.builtIn ? 'the owner' : agent.owner || 'its owner'} or an admin can message ${agent.name}` : null;
  const [draft, setDraft] = useState('');
  const off = useOffline(); // the host is offline: nothing can be sent until it's back
  const end = useRef<HTMLDivElement>(null);
  // Its Silent tools, which its posts leave out.
  const [silent, setSilent] = useState<Set<string>>();
  const [names, setNames] = useState<Map<string, { name: string; source: string }>>();
  useEffect(() => {
    let live = true;
    getTools().then(
      tools => {
        if (!live) return;
        setSilent(new Set(tools.filter(t => t.agents.find(a => a.id === agentId)?.tier === 'T0').map(t => t.id)));
        setNames(new Map(tools.map(t => [t.id, { name: t.name, source: t.source }])));
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [agentId]);

  // Newest at the bottom, like any chat: open at (and follow) the latest post.
  useLayoutEffect(() => {
    const scroller = end.current?.closest('.main-body');
    if (!scroller) return;
    const toBottom = () => (scroller.scrollTop = scroller.scrollHeight);
    toBottom();
    const frame = requestAnimationFrame(toBottom); // again once fonts/layout settle
    return () => cancelAnimationFrame(frame);
  }, [agentId, entries.length, thinking]);
  // Resizing the window rewraps every post: at the bottom before, still at the bottom after
  // (narrowing it left the newest post and the stopped note below the fold).
  useEffect(() => {
    const scroller = end.current?.closest('.main-body');
    const log = end.current?.parentElement;
    if (!scroller || !log) return;
    let atBottom = true;
    // Only your own scrolling counts: the rewrap scrolls it too (before this hears of the resize).
    let size = '';
    const sizeNow = () => `${scroller.scrollHeight}x${scroller.clientHeight}`;
    const onScroll = () => {
      if (sizeNow() === size) atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    };
    const keep = () => {
      if (atBottom) scroller.scrollTop = scroller.scrollHeight;
      size = sizeNow();
    };
    const follow = new ResizeObserver(keep);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', keep);
    follow.observe(scroller);
    follow.observe(log);
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', keep);
      follow.disconnect();
    };
  }, [agentId]);

  const send = () => {
    if (!draft.trim() || thinking) return;
    onSend(draft.trim());
    setDraft('');
  };

  let lastDay = '';
  return (
    <div className="dm">

      <div className="dm-log">
        {loading && entries.length === 0 && (
          <div className="dm-skel" aria-busy>
            <Loading what="messages" />
            {[3, 2, 4].map((lines, i) => (
              <div key={i} className="dm-skel-post" aria-hidden>
                <Skel w={36} h={36} r={18} />
                <div className="dm-skel-body">
                  <Skel w={i === 1 ? 90 : 130} h={13} />
                  <SkelLines lines={lines} h={11} />
                </div>
              </div>
            ))}
          </div>
        )}
        {!loading && entries.length === 0 && !thinking && <div className="dm-empty">No agent activity yet</div>}
        {entries.map((e, i) => {
          // A "stopped" note it has since answered past is history, not news: gone.
          if (e.kind === 'stopped' && entries.slice(i + 1).some(x => x.kind === 'run')) return null;
          const day = dayLabel(e.at);
          const divider = day !== lastDay ? <div className="dm-day" key={`d-${i}`}><span>{day}</span></div> : null;
          lastDay = day;
          return (
            <div key={i}>
              {divider}
              {e.kind === 'run' ? (
                <RunPostView post={e as StampedEntry & RunPost} agentName={agent.name} Icon={Icon} outcomes={approvalOutcomes} silent={silent} names={names} />
              ) : e.kind === 'stopped' ? (
                <div className="dm-post">
                  <div className="dm-avatar agent">
                    <Icon size={16} strokeWidth={1.75} />
                  </div>
                  <div className="dm-post-main">
                    <div className="dm-post-head">
                      <span className="dm-author">{agent.name}</span>
                      <span className="dm-time">{clock(e.at)}</span>
                    </div>
                    <p className="dm-text">
                      {(e as { agency?: boolean }).agency ? 'The agency is stopped. Resume it at the top of the' : `${agent.name} is stopped. Resume it on the`}{' '}
                      <a className="text-link" href="#" onClick={ev => (ev.preventDefault(), onOpenDashboard?.())}>
                        Dashboard
                      </a>
                      .
                    </p>
                  </div>
                </div>
              ) : (
                <div className="dm-post">
                  {/* Who wrote it (a teammate's message showed under the viewer's name). */}
                  <div className="dm-avatar you">{(e.by || ACCOUNT.name).charAt(0)}</div>
                  <div className="dm-post-main">
                    <div className="dm-post-head">
                      <span className="dm-author">{e.by || ACCOUNT.name}</span>
                      <span className="dm-time">{clock(e.at)}</span>
                    </div>
                    <p className="dm-text">
                      <Linkify text={e.text} />
                    </p>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {thinking && (
          <div className="dm-post">
            <div className="dm-avatar agent">
              <Icon size={16} strokeWidth={1.75} />
            </div>
            <div className="dm-post-main">
              <div className="dm-running">
                <Loader2 size={13} className="spin" />
                {agent.name} is running…{since != null && <Elapsed since={since} />}
              </div>
            </div>
          </div>
        )}
        {/* Once it has said so itself (a message sent while stopped), no second note. */}
        {/* A helper takes no messages: it works when an agent needs it, stopped or not. */}
        {agent.service ? (
          <div className="dm-stopped">{agent.name} works only when an agent needs it.</div>
        ) : (
          (sendError || (stopped && !entries.some(e => e.kind === 'stopped'))) && (
            <div className="dm-stopped">{sendError ?? (agencyStopped ? `The agency is stopped, so ${agent.name} won't answer until it's resumed.` : `${agent.name} is stopped, so it won't answer until it's resumed.`)}</div>
          )
        )}
        <div ref={end} />
      </div>

      {/* A helper's channel is its log: it runs only when the agency calls it. */}
      {!agent.service && <div className="dm-composer">
        <textarea
          rows={1}
          placeholder={`Message ${agent.name}`}
          disabled={!!off || readOnly}
          title={off ?? readOnlyWhy ?? undefined}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            // Enter sends, Shift+Enter is a new line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (!off && !readOnly) send();
            }
          }}
        />
        <button className="dm-send" onClick={send} disabled={!draft.trim() || thinking || !!off || readOnly} title={off ?? readOnlyWhy ?? (!draft.trim() ? 'Type a message first' : undefined)} aria-label="Send">
          <SendHorizontal size={16} strokeWidth={1.9} />
        </button>
      </div>}
    </div>
  );
}
