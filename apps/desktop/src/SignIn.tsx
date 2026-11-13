import { useEffect, useRef, useState } from 'react';
import { siGithub, siGoogle, type SimpleIcon } from 'simple-icons';
import { devSignIn, emailCode, inDesktopApp, signInWith, state } from './account';
import { BusyLabel } from './Busy';
import { useGrow } from './grow';

// Anywhere in the app can ask for it; App shows it, grown out of the button
// pressed (grow.ts). 'up' only changes the title: the same
// email code signs you in or makes your account.
export type SignInAsk = { mode: 'in' | 'up'; from: DOMRect | null };
export const openSignIn = (mode: 'in' | 'up' = 'in', from?: Element | null) =>
  window.dispatchEvent(new CustomEvent<SignInAsk>('eaa:sign-in', { detail: { mode, from: from?.getBoundingClientRect() ?? null } }));

// A provider's mark, in the text's colour.
const Mark = ({ icon }: { icon: SimpleIcon }) => (
  <svg viewBox="0 0 24 24" width={15} height={15} aria-hidden fill="currentColor">
    <path d={icon.path} />
  </svg>
);

// The logo over the title (as on extremely.agency, extremely-agency-site/logo.svg).
// They stay still: the dialog's opening and closing is its only motion.
const Head = ({ title, sub }: { title: string; sub?: string }) => (
  <div className="signin-head">
    <svg className="signin-logo" viewBox="-42 0 164 96" aria-hidden>
      <polygon fill="#3f7bd6" points="2,32 56,50 2,68 24,50" />
      <polygon fill="#e5484d" points="-40,8 120,44 44,78 78,50" />
    </svg>
    <h2 id="signin-title">{title}</h2>
    {sub && <p className="signin-sub">{sub}</p>}
  </div>
);

// Opening and closing as every other dialog does (grow.ts): grown out of the
// button pressed, contents fading in once it's nearly open; closing, they fade
// first and it shrinks back into the button. The sign-in panel's blue glow
// (styles.css, .confirm.signin) also warms up as it opens.
const GLOW_MS = 620;
const warmUp = (scrim: HTMLDivElement | null) => {
  const panel = scrim?.querySelector<HTMLElement>('.confirm.signin');
  if (!panel || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  panel.animate([{ boxShadow: '0 0 0 0 rgba(63, 123, 214, 0), 0 0 0 rgba(63, 123, 214, 0), 0 0 0 rgba(63, 123, 214, 0), 0 30px 80px rgba(0, 0, 0, 0.6)', borderColor: 'rgba(63, 123, 214, 0.2)' }, {}], {
    duration: GLOW_MS,
    delay: 120,
    easing: 'ease-out',
    fill: 'backwards',
  });
};

// Signing in, for organizations (account.ts): Google, GitHub, or a code by
// email - the same code makes an account the first time. Development without
// Clerk: an email and a name, no code.
// Looks like an email address: until it does, the button waits (greyed, saying why).
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignIn({ onDone, onCancel, mode: asked = 'in' }: { onDone: () => void; onCancel: () => void; mode?: 'in' | 'up'; from?: DOMRect | null }) {
  // Either dialog links to the other ("Need an account? SIGN UP").
  const [mode, setMode] = useState(asked);
  const grow = useGrow<HTMLDivElement>('dialog', warmUp);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [finish, setFinish] = useState<((code: string) => Promise<void>) | null>(null);
  const [busy, setBusy] = useState(false);
  // Google/GitHub in the desktop app: signing in in the browser (account.ts).
  const [inBrowser, setInBrowser] = useState(false);
  // Cancel while waiting on the browser stops waiting.
  const waiting = useRef<AbortController | null>(null);
  useEffect(() => () => waiting.current?.abort(), []);
  const withProvider = (provider: 'google' | 'github') =>
    run(async () => {
      setInBrowser(inDesktopApp);
      const stop = (waiting.current = new AbortController());
      try {
        await signInWith(provider, stop.signal);
      } finally {
        setInBrowser(false);
        waiting.current = null;
      }
      if (inDesktopApp && !stop.signal.aborted) onDone();
    });
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
      if (dev) return void (await devSignIn(email, name, mode), onDone());
      if (finish) return void (await finish(code.trim()), onDone());
      const next = await emailCode(email.trim());
      setFinish(() => next);
    });

  if (!state.signIn)
    return (
      <div className="confirm-scrim" ref={grow} onMouseDown={e => e.target === e.currentTarget && onCancel()}>
        <div className="confirm signin" role="dialog" aria-labelledby="signin-title">
          <Head title="SIGN IN" />
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
    <div className="confirm-scrim" ref={grow} onMouseDown={e => e.target === e.currentTarget && !busy && onCancel()}>
      <form
        className="confirm signin"
        role="dialog"
        aria-labelledby="signin-title"
        onSubmit={e => {
          e.preventDefault();
          if (!busy) submit();
        }}
      >
        <Head
          title={finish ? 'Check your email' : mode === 'up' ? 'SIGN UP' : 'SIGN IN'}
          sub={!finish && mode === 'up' ? 'to unlock EXTREMELY agentic collaboration' : undefined}
        />
        {finish ? (
          <>
            <p>A code went to {email.trim()}.</p>
            <label className="signin-label">
              Code
              <input key="code" ref={first} className="signin-input" inputMode="numeric" autoComplete="one-time-code" placeholder="Code" value={code} onChange={e => setCode(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            {!dev && (
              <div className="signin-providers">
                <button type="button" className="sbtn" disabled={busy} onClick={() => withProvider('google')}>
                  <Mark icon={siGoogle} />
                  Google
                </button>
                <button type="button" className="sbtn" disabled={busy} onClick={() => withProvider('github')}>
                  <Mark icon={siGithub} />
                  GitHub
                </button>
              </div>
            )}
            <label className="signin-label">
              Email
              <input ref={first} className="signin-input" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />
            </label>
            {dev && (
              <label className="signin-label">
                Name
                <input className="signin-input" autoComplete="name" placeholder="Your name" value={name} onChange={e => setName(e.target.value)} />
              </label>
            )}
            {dev && <p className="signin-note">Development sign-in: no code.</p>}
            {inBrowser && <p className="signin-note">Finish signing in in the browser window that opened.</p>}
          </>
        )}
        {error && <div className="custom-error">{error}</div>}
        {!finish && (
          <p className="signin-switch">
            {mode === 'up' ? 'Already have an account? ' : 'Need an account? '}
            <button type="button" className="text-link" onClick={() => setMode(m => (m === 'up' ? 'in' : 'up'))}>
              {mode === 'up' ? 'SIGN IN' : 'SIGN UP'}
            </button>
          </p>
        )}
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={() => (waiting.current?.abort(), onCancel())} disabled={busy && !inBrowser}>
            Cancel
          </button>
          <button
            type="submit"
            className="sbtn signup-btn"
            disabled={busy || (finish ? !code.trim() : !EMAIL.test(email.trim()))}
            title={!finish && !busy && !EMAIL.test(email.trim()) ? (email.trim() ? "That doesn't look like an email address yet" : 'Enter your email first') : undefined}
          >
            <BusyLabel busy={busy} busyText={finish || dev ? (mode === 'up' ? 'Signing up' : 'Signing in') : 'Sending code'}>
              {finish || dev ? (mode === 'up' ? 'SIGN UP' : 'SIGN IN') : 'Continue'}
            </BusyLabel>
          </button>
        </div>
      </form>
    </div>
  );
}
