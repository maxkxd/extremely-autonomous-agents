import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, ArrowRight, Check, X } from 'lucide-react';

// The app's own notice, in place of the system's plain pop-up box. Bottom right,
// in the colours the rest of the app uses: red - something failed; green - done;
// blue - over to you. It slides in, and leaves the way an approval card does.
// Good news goes by itself (hovering holds it); a failure or something for you to
// do stays until you close it.

export type NoticeKind = 'error' | 'done' | 'info';
type Notice = { id: number; kind: NoticeKind; text: string; action?: { label: string; run: () => void }; at: number };

let notices: Notice[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
const MAX = 4;

export function notify(text: string, kind: NoticeKind = 'error', action?: Notice['action']) {
  // The same one again: brought back to the front rather than stacked twice.
  notices = [...notices.filter(n => n.text !== text), { id: nextId++, kind, text, action, at: Date.now() }].slice(-MAX);
  emit();
}
// For a failed call: its message, or a plain fallback.
export const notifyError = (e: unknown) => notify((e as Error)?.message || 'Something went wrong. Try again.', 'error');

const dismiss = (id: number) => {
  notices = notices.filter(n => n.id !== id);
  emit();
};
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

// How long good news stays: long enough to read it.
const life = (n: Notice) => (n.kind === 'done' ? Math.min(9000, 4000 + n.text.length * 40) : null);
const LEAVE_MS = 520;
const ICON = { error: AlertTriangle, done: Check, info: ArrowRight };

function NoticeCard({ n }: { n: Notice }) {
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);
  const left = useRef(life(n));
  const close = () => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(() => dismiss(n.id), LEAVE_MS);
  };
  // Counts down only while you aren't reading it (hovered).
  useEffect(() => {
    if (left.current == null || held || leaving) return;
    const started = Date.now();
    const t = window.setTimeout(close, left.current);
    return () => {
      window.clearTimeout(t);
      left.current = Math.max(800, (left.current ?? 0) - (Date.now() - started));
    };
  }, [held, leaving]);
  const Icon = ICON[n.kind];
  const ms = life(n);
  return (
    <div
      className={`notice ${n.kind}${leaving ? ' leaving' : ''}`}
      role={n.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
    >
      <span className="notice-icon">
        <Icon size={15} strokeWidth={2.2} />
      </span>
      <div className="notice-body">
        <p>{n.text}</p>
        {n.action && (
          <button
            className="notice-action"
            onClick={() => {
              n.action!.run();
              close();
            }}
          >
            {n.action.label}
          </button>
        )}
      </div>
      <button className="notice-close" aria-label="Close" onClick={close}>
        <X size={14} />
      </button>
      {ms != null && <span className="notice-timer" style={{ animationDuration: `${ms}ms`, animationPlayState: held ? 'paused' : 'running' }} />}
    </div>
  );
}

export function Notices() {
  const list = useSyncExternalStore(subscribe, () => notices);
  if (!list.length) return null;
  return (
    <div className="notices" aria-live="polite">
      {list.map(n => (
        <NoticeCard key={n.id} n={n} />
      ))}
    </div>
  );
}
