import { useEffect, useRef, useState } from 'react';
import { devSignIn, emailCode, signInWith, state } from './account';

// Anywhere in the app can ask for it; App shows it.
export const openSignIn = () => window.dispatchEvent(new Event('eaa:sign-in'));

// Signing in, for organisations (account.ts): Google, GitHub, or a code by
// email - the same code makes an account the first time. Development without
// Clerk: an email and a name, no code.
export function SignIn({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [finish, setFinish] = useState<((code: string) => Promise<void>) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef<HTMLInputElement>(null);
  const dev = state.signIn === 'dev';

  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel, finish]);

  const run = async (step: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await step();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const submit = () =>
    run(async () => {
      if (dev) return void (await devSignIn(email, name), onDone());
      if (finish) return void (await finish(code.trim()), onDone());
      const next = await emailCode(email.trim());
      setFinish(() => next);
    });

  if (!state.signIn)
    return (
      <div className="confirm-scrim" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
        <div className="confirm signin" role="dialog" aria-labelledby="signin-title">
          <h2 id="signin-title">Sign in</h2>
          <p>Can't reach sign-in right now. Your own agency works without it.</p>
          <div className="confirm-actions">
            <button className="confirm-cancel" onClick={onCancel}>
              Close
            </button>
          </div>
        </div>
      </div>
    );

  return (
    <div className="confirm-scrim" onMouseDown={e => e.target === e.currentTarget && !busy && onCancel()}>
      <form
        className="confirm signin"
        role="dialog"
        aria-labelledby="signin-title"
        onSubmit={e => {
          e.preventDefault();
          if (!busy) submit();
        }}
      >
        <h2 id="signin-title">{finish ? 'Check your email' : 'Sign in'}</h2>
        {finish ? (
          <>
            <p>A code went to {email.trim()}.</p>
            <input key="code" ref={first} className="signin-input" inputMode="numeric" autoComplete="one-time-code" placeholder="Code" value={code} onChange={e => setCode(e.target.value)} />
          </>
        ) : (
          <>
            {!dev && (
              <div className="signin-providers">
                <button type="button" className="sbtn" disabled={busy} onClick={() => run(() => signInWith('google'))}>
                  Google
                </button>
                <button type="button" className="sbtn" disabled={busy} onClick={() => run(() => signInWith('github'))}>
                  GitHub
                </button>
              </div>
            )}
            <input ref={first} className="signin-input" type="email" autoComplete="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
            {dev && <input className="signin-input" autoComplete="name" placeholder="Name" value={name} onChange={e => setName(e.target.value)} />}
            {dev && <p className="signin-note">Development sign-in: no code.</p>}
          </>
        )}
        {error && <div className="custom-error">{error}</div>}
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="sbtn primary" disabled={busy || (finish ? !code.trim() : !email.trim())}>
            {busy ? 'One moment...' : finish ? 'Sign in' : dev ? 'Sign in' : 'Continue'}
          </button>
        </div>
      </form>
    </div>
  );
}
