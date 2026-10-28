import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { AgentCard } from './Dashboard';
import type { Agent } from './data';

const HOLD_MS = 1200;

// The last step of creating an agent: everything fades to black except the
// new agent's card. X cancels; holding the button under the card accepts.
export function AgentReveal({
  agent,
  leaving,
  error,
  onCancel,
  onAccept,
}: {
  agent: Agent;
  leaving: boolean; // accepted: fading back to the dashboard
  error: string | null;
  onCancel: () => void;
  onAccept: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(id);
      window.removeEventListener('keydown', onKey);
      clearTimeout(timer.current);
    };
  }, [onCancel]);

  const press = () => {
    if (leaving) return;
    clearTimeout(timer.current);
    setHolding(true);
    timer.current = setTimeout(onAccept, HOLD_MS);
  };
  const release = () => {
    setHolding(false);
    clearTimeout(timer.current);
  };

  return (
    <div className={`reveal${shown ? ' in' : ''}${leaving ? ' leaving' : ''}`}>
      <button className="reveal-cancel" onClick={onCancel} aria-label="Cancel" title="Cancel">
        <X size={22} />
      </button>
      <div className="reveal-stage">
        <div className="reveal-card">
          <AgentCard
            agent={agent}
            range="week"
            state="active"
            setState={() => {}}
            onNavigate={() => {}}
            openApprovals={0}
            openRequests={0}
            decisions={agent.decisions}
            dragging={false}
            onGripDown={() => {}}
            preview
          />
        </div>
        <button
          className={`reveal-accept${holding ? ' holding' : ''}`}
          style={{ '--hold': `${HOLD_MS}ms` } as React.CSSProperties}
          onPointerDown={press}
          onPointerUp={release}
          onPointerLeave={release}
          onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && !e.repeat && press()}
          onKeyUp={e => (e.key === ' ' || e.key === 'Enter') && release()}
        >
          <span className="reveal-fill" aria-hidden />
          <span className="reveal-label">{holding ? 'Keep holding' : 'Hold to add'}</span>
        </button>
        {error && <div className="reveal-error">{error}</div>}
      </div>
    </div>
  );
}
