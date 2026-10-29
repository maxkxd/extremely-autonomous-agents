import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { siGithub, siGoogle, type SimpleIcon } from 'simple-icons';
import { devSignIn, emailCode, signInWith, state } from './account';

// Anywhere in the app can ask for it; App shows it, grown out of the button
// pressed (from), if there was one. 'up' only changes the title: the same
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

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
// The dialog, from the button's place and size to its own, or back.
function grow(box: HTMLElement, from: DOMRect, back = false) {
  // Measured where it rests, not part-way through another animation.
  box.getAnimations().forEach(a => a.cancel());
  const to = box.getBoundingClientRect();
  const start = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
  const frames = [
    { transform: start, opacity: 0.6, borderRadius: '9px' },
    { transform: 'none', opacity: 1, borderRadius: '14px' },
  ];
  box.style.transformOrigin = 'top left';
  const a = box.animate(back ? frames.reverse() : frames, { duration: back ? 200 : 300, easing: EASE, fill: back ? 'forwards' : 'none' });
  // What's inside fades in once it's nearly open, rather than squashing with it.
  if (!back) for (const child of Array.from(box.children)) (child as HTMLElement).animate([{ opacity: 0 }, { opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-out' });
  return a.finished;
}

// Signing in, for organisations (account.ts): Google, GitHub, or a code by
// email - the same code makes an account the first time. Development without
// Clerk: an email and a name, no code.
export function SignIn({ onDone, onCancel: close, mode = 'in', from = null }: { onDone: () => void; onCancel: () => void; mode?: 'in' | 'up'; from?: DOMRect | null }) {
  const box = useRef<HTMLFormElement & HTMLDivElement>(null);
  const grown = useRef(false);
  useLayoutEffect(() => {
    // Once (development runs effects twice).
    if (grown.current) return;
    grown.current = true;
    if (from && box.current) void grow(box.current, from);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Closing goes back into the button it came from.
  const leaving = useRef(false);
  const onCancel = () => {
    if (leaving.current) return;
    leaving.current = true;
    if (from && box.current) void grow(box.current, from, true).then(close, close);
    else close();
  };
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
        <div ref={box} className={`confirm signin${from ? ' grows' : ''}`} role="dialog" aria-labelledby="signin-title">
          <Head title="Sign in" />
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
        ref={box}
        className={`confirm signin${from ? ' grows' : ''}`}
        role="dialog"
        aria-labelledby="signin-title"
        onSubmit={e => {
          e.preventDefault();
          if (!busy) submit();
        }}
      >
        <Head
          title={finish ? 'Check your email' : mode === 'up' ? 'SIGN UP' : 'Sign in'}
          sub={!finish && mode === 'up' ? 'to unlock EXTREMELY agentic collaboration' : undefined}
        />
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
                  <Mark icon={siGoogle} />
                  Google
                </button>
                <button type="button" className="sbtn" disabled={busy} onClick={() => run(() => signInWith('github'))}>
                  <Mark icon={siGithub} />
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
            {busy ? 'One moment...' : finish || dev ? (mode === 'up' ? 'Sign up' : 'Sign in') : 'Continue'}
          </button>
        </div>
      </form>
    </div>
  );
}
