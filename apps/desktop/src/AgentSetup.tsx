import { useEffect } from 'react';
import { Play, Star } from 'lucide-react';
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
  <span className="setup-stars" aria-label={`${n} of 5: how much it helps`} title={`How much it helps: ${n} of 5`}>
    {Array.from({ length: 5 }, (_, i) => (
      <Star key={i} size={12} className={i < n ? 'on' : 'off'} />
    ))}
  </span>
);

export function SetupList({ setup, onOpenRequest }: { setup: AgentSetup; onOpenRequest: (id: number) => void }) {
  // Connected ones drop off; once none are left it starts by itself (runner/setup.ts).
  const todo = setup.items.filter(i => !i.connected);
  if (!todo.length) return null;
  return (
    <div className="setup-list">
      <ul>
        {todo.map(i => (
          <li key={i.name}>
            <span className="setup-name">{i.name}</span>
            <Stars n={i.stars} />
            <span className="setup-act">
              {i.building ? (
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
