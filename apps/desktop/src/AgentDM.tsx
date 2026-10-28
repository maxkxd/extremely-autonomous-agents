import { useLayoutEffect, useRef, useState } from 'react';
import { CircleAlert, CircleCheck, Loader2, SendHorizontal } from 'lucide-react';
import { ACCOUNT, AGENTS } from './data';
import { DEPARTMENT_ICON } from './Sidebar';
import type { DmEntry, RunPost, ToolLine } from './dms';
import type { Resolution } from './Approvals';

// Placeholder history is "minutes ago"; pin it to the page's load time.
const loadedAt = Date.now();
export type StampedEntry = DmEntry & { at: number };
export const stamp = (e: DmEntry, at = loadedAt - e.minutesAgo * 60_000): StampedEntry => ({ ...e, at });

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
  const o = outcomes[t.approvalId];
  return o === 'approved' ? 'ok' : o ? 'failed' : 'pending';
}
const TOOL_TITLE: Record<ToolState, string> = { ok: 'Succeeded', failed: 'Failed', pending: 'Waiting on approval' };

const duration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);

function RunPostView({
  post,
  agentName,
  Icon,
  outcomes,
}: {
  post: StampedEntry & RunPost;
  agentName: string;
  Icon: typeof CircleCheck;
  outcomes: Record<string, Resolution>;
}) {
  const ok = post.outcome === 'succeeded';
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
        <div className={`dm-runline${ok ? '' : ' failed'}`}>
          {ok ? <CircleCheck size={13} strokeWidth={2} /> : <CircleAlert size={13} strokeWidth={2} />}
          run {post.id} · {post.trigger} · {post.tools.length} action{post.tools.length === 1 ? '' : 's'} · $
          {post.cost.toFixed(2)} · {duration(post.seconds)}
        </div>
        <p className="dm-text">{post.text}</p>
        {post.tools.length > 0 && (
          <ul className="dm-tools">
            {post.tools.map((t, i) => (
              <li key={i}>
                <span className={`dm-tool-dot ${toolState(t, outcomes)}`} title={TOOL_TITLE[toolState(t, outcomes)]} />
                {t.server} · {t.tool} · <span className="dm-tool-fields">{t.fields.join(', ')}</span>
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
}: {
  agentId: string;
  entries: StampedEntry[];
  thinking: boolean;
  onSend: (text: string) => void;
  approvalOutcomes: Record<string, Resolution>;
}) {
  const agent = AGENTS.find(a => a.id === agentId)!;
  const Icon = DEPARTMENT_ICON[agent.department];
  const [draft, setDraft] = useState('');
  const end = useRef<HTMLDivElement>(null);

  // Newest at the bottom, like any chat: open at (and follow) the latest post.
  useLayoutEffect(() => {
    const scroller = end.current?.closest('.main-body');
    if (!scroller) return;
    const toBottom = () => (scroller.scrollTop = scroller.scrollHeight);
    toBottom();
    const frame = requestAnimationFrame(toBottom); // again once fonts/layout settle
    return () => cancelAnimationFrame(frame);
  }, [agentId, entries.length, thinking]);

  const send = () => {
    if (!draft.trim() || thinking) return;
    onSend(draft.trim());
    setDraft('');
  };

  let lastDay = '';
  return (
    <div className="dm">
      {/* The rule, quietly: nothing here needs anyone (docs/agent-dms.md). */}
      <p className="dm-notice">
        Run logs and direct messages with {agent.name}. Nothing here needs you - anything that does goes to Approvals or
        Requests.
      </p>

      <div className="dm-log">
        {entries.map((e, i) => {
          const day = dayLabel(e.at);
          const divider = day !== lastDay ? <div className="dm-day" key={`d-${i}`}><span>{day}</span></div> : null;
          lastDay = day;
          return (
            <div key={i}>
              {divider}
              {e.kind === 'run' ? (
                <RunPostView post={e as StampedEntry & RunPost} agentName={agent.name} Icon={Icon} outcomes={approvalOutcomes} />
              ) : (
                <div className="dm-post">
                  <div className="dm-avatar you">{ACCOUNT.name.charAt(0)}</div>
                  <div className="dm-post-main">
                    <div className="dm-post-head">
                      <span className="dm-author">{ACCOUNT.name}</span>
                      <span className="dm-time">{clock(e.at)}</span>
                    </div>
                    <p className="dm-text">{e.text}</p>
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
                {agent.name} is running…
              </div>
            </div>
          </div>
        )}
        <div ref={end} />
      </div>

      <div className="dm-composer">
        <textarea
          rows={1}
          placeholder={`Message ${agent.name}`}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            // Enter sends, Shift+Enter is a new line.
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="dm-send" onClick={send} disabled={!draft.trim() || thinking} aria-label="Send">
          <SendHorizontal size={16} strokeWidth={1.9} />
        </button>
      </div>
    </div>
  );
}
