import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Hammer, RotateCcw, Sparkles, X } from 'lucide-react';
import type { BuilderSession } from './builder';

// A build takes up to a minute or so: count up so it never looks stuck.
function BuildingNote() {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 250);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="bmsg is-builder building-note">
      <span className="building-text">Building your agent - this could take a minute</span>
      <span className="building-timer">
        {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}
      </span>
    </div>
  );
}

// The agent builder's conversation, in a pop-up that grows out of the custom
// card. The blue bar across the top is the builder's own confidence that it
// understands the agent well enough to build it.
export function BuilderChat({
  origin,
  session,
  onReply,
  onRetry,
  onBuild,
  onClose,
}: {
  origin: DOMRect;
  session: BuilderSession;
  onReply: (text: string) => void;
  onRetry: () => void;
  onBuild: () => void;
  onClose: () => void;
}) {
  const [grown, setGrown] = useState(false);
  const [text, setText] = useState('');
  const log = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const building = session.phase === 'building';
  const last = session.turns[session.turns.length - 1];
  // A failed turn leaves your message unanswered: offer to ask again.
  const canRetry = !!session.error && !session.thinking && !building && last?.role === 'person';

  // Start exactly over the card, then grow to full size on the next frame.
  useLayoutEffect(() => {
    const id = requestAnimationFrame(() => requestAnimationFrame(() => setGrown(true)));
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    if (grown) input.current?.focus();
  }, [grown]);
  useEffect(() => {
    log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' });
  }, [session.turns.length, session.thinking, building]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !building && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [building, onClose]);

  const send = () => {
    const t = text.trim();
    if (!t || session.thinking || building) return;
    onReply(t);
    setText('');
  };

  const start = { top: origin.top, left: origin.left, width: origin.width, height: origin.height };
  return (
    <div className={`builder-scrim${grown ? ' in' : ''}`} onMouseDown={e => e.target === e.currentTarget && !building && onClose()}>
      <div className={`builder${grown ? ' grown' : ''}`} style={grown ? undefined : start} role="dialog" aria-label="Build an agent">
        <div
          className={`builder-progress${building ? ' building' : ''}`}
          role="progressbar"
          aria-label="How sure the builder is"
          aria-valuenow={session.confidence}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span style={{ width: `${building ? 100 : session.confidence}%` }} />
        </div>
        <header className="builder-head">
          <span className="builder-title">
            <Sparkles size={16} strokeWidth={1.75} />
            New agent
          </span>
          <span className="builder-confidence">{building ? 'Building' : `${session.confidence}%`}</span>
          <button className="builder-close" onClick={onClose} disabled={building} aria-label="Close" title="Close (keeps the conversation)">
            <X size={18} />
          </button>
        </header>

        <div className="builder-log" ref={log}>
          {session.turns.map((t, i) => (
            <div key={i} className={`bmsg is-${t.role}`}>
              {t.text}
            </div>
          ))}
          {session.thinking && (
            <div className="bmsg is-builder typing" aria-label="Thinking">
              <span />
              <span />
              <span />
            </div>
          )}
          {building && <BuildingNote />}
          {session.error && (
            <div className="builder-error">
              {session.error}
              {canRetry && (
                <button onClick={onRetry}>
                  <RotateCcw size={13} /> Try again
                </button>
              )}
            </div>
          )}
        </div>

        <footer className="builder-foot">
          {session.ready && !building && (
            <button className="builder-build" onClick={onBuild}>
              <Hammer size={15} strokeWidth={2} />
              Build agent
            </button>
          )}
          <div className="builder-compose">
            <textarea
              ref={input}
              value={text}
              rows={1}
              disabled={building}
              placeholder={session.ready ? 'Anything else? Or build it.' : 'Reply...'}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="custom-send" onClick={send} disabled={!text.trim() || session.thinking || building} aria-label="Send">
              <ArrowUp size={16} strokeWidth={2.25} />
            </button>
          </div>
          <div className="builder-hint">Don't paste API keys or passwords here - you'll add those in settings.</div>
        </footer>
      </div>
    </div>
  );
}
