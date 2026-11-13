import { LoaderCircle } from 'lucide-react';

// One way to say "working on it", everywhere (styles.css .busy-*, .busy-line):
//   - something not loaded yet: a skeleton (Skeleton.tsx), never words
//   - a button doing what you pressed: a spinner and its verb ("Deleting…"),
//     the button keeping its size
//   - waiting on something else: a small spinner and a muted line ("Checking the key…")
// One ellipsis, "…", and only for something in progress.

export const Spinner = ({ size = 13 }: { size?: number }) => <LoaderCircle size={size} strokeWidth={2.2} className="spin" aria-hidden />;

// A button's label while it works. Both texts sit in the same spot, so the
// button is as wide as the longer one and doesn't jump.
export function BusyLabel({ busy, busyText, children }: { busy: boolean; busyText: string; children: React.ReactNode }) {
  return (
    <span className={`busy-label${busy ? ' on' : ''}`} aria-live="polite">
      <span className="busy-idle" aria-hidden={busy}>
        {children}
      </span>
      <span className="busy-now" aria-hidden={!busy}>
        <Spinner />
        {busyText}…
      </span>
    </span>
  );
}

// Waiting on something elsewhere: a sign-in window, a check, a save.
export function Working({ text }: { text: string }) {
  return (
    <span className="busy-line" role="status">
      <Spinner size={12} />
      {text}…
    </span>
  );
}

// "Connect" → "Connecting": the verb for a button's own label, for the usual ones.
const ING: Record<string, string> = {
  connect: 'Connecting',
  disconnect: 'Disconnecting',
  'sign in': 'Signing in',
  add: 'Adding',
  open: 'Opening',
  save: 'Saving',
  delete: 'Deleting',
  send: 'Sending',
};
export const busyVerb = (label: React.ReactNode) => {
  const text = typeof label === 'string' ? label.trim().toLowerCase() : '';
  const key = Object.keys(ING).find(k => text === k || text.startsWith(`${k} `));
  return key ? ING[key] : 'Working';
};
