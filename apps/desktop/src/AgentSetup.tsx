import { useEffect } from 'react';
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

export function SetupList({ setup, onOpenRequest }: { setup: AgentSetup; onOpenRequest: (id: number) => void }) {
  // Connected ones stay, marked Complete - seeing them tick off is the point. Once
  // all are, it starts by itself and the list goes (runner/setup.ts).
  if (!setup.items.length) return null;
  return (
    <div className="setup-list">
      <ul>
        {setup.items.map(i => (
          <li key={i.name} className={i.connected ? 'done' : ''}>
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
                <button className="setup-go" onClick={() => onOpenRequest(i.requestId)}>
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
