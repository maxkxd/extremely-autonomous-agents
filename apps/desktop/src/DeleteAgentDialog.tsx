import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { Agent } from './data';
import { useGrow } from './grow';
import { BusyLabel } from './Busy';

// Deleting an agent can't be undone, so you type its name to confirm.
export function DeleteAgentDialog({
  agent,
  onCancel,
  onConfirm,
}: {
  agent: Agent;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const grow = useGrow<HTMLDivElement>('dialog');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // Its name however it's typed: case and extra spaces don't matter.
  const same = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const matches = same(typed) === same(agent.name);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  const confirm = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="confirm-scrim" ref={grow} onMouseDown={e => e.target === e.currentTarget && !busy && onCancel()}>
      <div className="confirm" role="alertdialog" aria-labelledby="del-title" aria-describedby="del-body">
        <h2 id="del-title">Delete {agent.name}?</h2>
        <p id="del-body">
          This can't be undone. Its instructions, memory and chat are deleted for good, and anything it was in the
          middle of stops. What it spent stays in Usage, and files it saved stay where they are.
        </p>
        <label className="confirm-label">
          <span>
            Type <strong>{agent.name}</strong> to confirm
          </span>
          <input
            ref={input}
            value={typed}
            disabled={busy}
            spellCheck={false}
            autoComplete="off"
            onChange={e => setTyped(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && confirm()}
          />
        </label>
        {error && <div className="custom-error">{error}</div>}
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="confirm-delete" onClick={confirm} disabled={!matches || busy}>
            <Trash2 size={14} strokeWidth={2} />
            <BusyLabel busy={busy} busyText="Deleting">Delete agent</BusyLabel>
          </button>
        </div>
      </div>
    </div>
  );
}
