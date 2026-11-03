import { useEffect, useRef, useState } from 'react';
import { Check, Play, Star } from 'lucide-react';
import type { AgentSetup } from './builder';

// A new agent's setup, on its card until it's first resumed: the connectors its
// first requests asked for (the Agency Engineer drafts them), how much each
// helps it (stars), and a bar across the card's top edge for how far along the
// connecting is. Each goes to its request, where the engineer's steps are.

export function SetupBar({ progress }: { progress: number }) {
  return (
    <div className="setup-bar" role="progressbar" aria-label="Setup" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
      <span style={{ width: `${Math.round(progress * 100)}%` }} />
    </div>
  );
}

const Stars = ({ n }: { n: number }) => (
  // 1-5 once the Agency Engineer has rated it; none lit before that.
  <span className="setup-stars" aria-label={n ? `${n} of 5: how much it helps` : 'Not rated yet'} title={n ? `How much it helps: ${n} of 5` : 'Not rated yet'}>
    {Array.from({ length: 5 }, (_, i) => (
      <Star key={i} size={12} className={i < n ? 'on' : 'off'} />
    ))}
  </span>
);

// someoneElse: a member looking at a teammate's agent - its requests are its owner's, not on their
// Requests page, so Go to request is greyed (an admin opens them under Everyone).
export function SetupList({
  setup,
  onOpenRequest,
  onStart,
  someoneElse = null,
}: {
  setup: AgentSetup;
  onOpenRequest: (id: number) => void;
  onStart?: () => void; // ready: what the last item's Start does (the card's Start)
  someoneElse?: string | null;
}) {
  // Connected ones stay, marked Complete - seeing them tick off is the point. Once
  // all are, they slide and fade off and one last item is left: start it. It never
  // starts by itself (runner/setup.ts). Ready when the card first shows: no slide.
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState(setup.ready);
  const wasReady = useRef(setup.ready);
  useEffect(() => {
    if (!setup.ready) return void ((wasReady.current = false), setGone(false));
    if (wasReady.current) return;
    wasReady.current = true;
    setLeaving(true);
    const t = window.setTimeout(() => (setGone(true), setLeaving(false)), 700);
    return () => window.clearTimeout(t);
  }, [setup.ready]);
  if (!setup.items.length) return null;
  if (gone)
    return (
      <div className="setup-list">
        <ul>
          <li className="setup-start">
            <span className="setup-name">Start the agent</span>
            <span />
            <span className="setup-act">
              <button className="setup-go start" disabled={!!someoneElse || !onStart} title={someoneElse ? `Only ${someoneElse} or an admin can start it` : undefined} onClick={onStart}>
                Start
              </button>
            </span>
          </li>
        </ul>
      </div>
    );
  return (
    <div className="setup-list">
      <ul>
        {setup.items.map(i => (
          <li key={i.name} className={`${i.connected ? 'done' : ''}${leaving ? ' leaving' : ''}`}>
            <span className="setup-name">{i.name}</span>
            <Stars n={i.stars} />
            <span className="setup-act">
              {i.connected ? (
                <span className="state-pill complete">
                  <Check size={11} strokeWidth={3} />
                  Complete
                </span>
              ) : i.building ? (
                <span className="state-pill setting-up" title="The Agency Engineer is getting this ready to connect.">
                  Setting up
                </span>
              ) : (
                <button
                  className="setup-go"
                  disabled={!!someoneElse}
                  title={someoneElse ? `${someoneElse}'s request - only they or an admin can open it` : undefined}
                  onClick={() => onOpenRequest(i.requestId)}
                >
                  Go to request
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Resuming before everything's connected: it can, but say what that means.
export function ResumeSetupDialog({ name, missing, onCancel, onResume }: { name: string; missing: string[]; onCancel: () => void; onResume: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="confirm-scrim" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="confirm" role="alertdialog" aria-labelledby="setup-title" aria-describedby="setup-body">
        <h2 id="setup-title">{name} isn't fully connected</h2>
        <p id="setup-body">
          You haven't connected all of its tools yet ({missing.join(', ')}), so things might not work as expected. It will do what it can
          with what's connected.
        </p>
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onCancel}>
            Cancel
          </button>
          <button className="confirm-resume" onClick={onResume}>
            <Play size={14} strokeWidth={2} />
            Resume anyway
          </button>
        </div>
      </div>
    </div>
  );
}
