import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { AgentCard } from './Dashboard';
import type { ModelChoice } from './builder';
import type { Agent } from './data';

const HOLD_MS = 1200;

// The last step of creating an agent, or adding a pack: everything fades to
// black except the new agents' cards (up to three, stacked). X cancels;
// holding the button under them accepts.
export function AgentReveal({
  agents,
  models,
  leaving,
  error,
  onCancel,
  onAccept,
}: {
  agents: Agent[];
  models?: ModelChoice[][]; // the builder's picks, shown on each card (by position)
  leaving: boolean; // accepted: fading back to the dashboard
  error: string | null;
  onCancel: () => void;
  onAccept: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [holding, setHolding] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  // Several cards shrink together until the stack and the button fit the window.
  const stack = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const el = stack.current;
      if (!el) return;
      // Measure at full size: reading it back under a zoom compounds on each resize.
      el.style.zoom = '1';
      const natural = el.scrollHeight;
      // Room for the button and a margin above and below.
      el.style.zoom = String(Math.min(1, (window.innerHeight - 300) / natural));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [agents.length]);

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
        <div className="reveal-cards" ref={stack}>
          {agents.map((agent, i) => (
            // Each card bobs out of step with the others.
            <div className="reveal-card" key={agent.id} style={{ animationDelay: `${0.6 + i * 0.7}s` }}>
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
                models={models?.[i]}
              />
            </div>
          ))}
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
          <span className="reveal-label">{holding ? 'Keep holding' : agents.length > 1 ? `Hold to add ${agents.length} agents` : 'Hold to add'}</span>
        </button>
        {error && <div className="reveal-error">{error}</div>}
      </div>
    </div>
  );
}
