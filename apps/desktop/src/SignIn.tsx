import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { siGithub, siGoogle, type SimpleIcon } from 'simple-icons';
import { devSignIn, emailCode, inDesktopApp, signInWith, state } from './account';

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
// The title moves like the sign-in tab (main.tsx): its letters land as it opens,
// wave while it works, shake when it fails, and float once you're signed in (the
// logo launching off as it does at the end of onboarding). styles.css, .signin.
type Mood = 'land' | 'wave' | 'shake' | 'done';
const Head = ({ title, sub, mood = 'land' }: { title: string; sub?: string; mood?: Mood }) => (
  <div className={`signin-head mood-${mood}`}>
    <svg className="signin-logo" viewBox="-42 0 164 96" aria-hidden>
      <polygon fill="#3f7bd6" points="2,32 56,50 2,68 24,50" />
      <polygon fill="#e5484d" points="-40,8 120,44 44,78 78,50" />
    </svg>
    {/* Keyed on the words, so a new title lands afresh. */}
    <Title key={title} text={title} />
    {sub && <p className="signin-sub">{sub}</p>}
  </div>
);
// The title's letters land once, when the words first show (opening, or new
// words: "Check your email", "SIGNED IN"); a change of mood never replays it,
// so a shake straight after the wave jolts letters you can see.
function Title({ text }: { text: string }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    ref.current?.querySelectorAll<HTMLElement>('span').forEach((s, i) =>
      s.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 180 + i * 30, easing: 'ease-out', fill: 'backwards' }),
    );
  }, []);
  return (
    <h2 id="signin-title" ref={ref} aria-label={text}>
      {[...text].map((c, i) => (
        <span key={i} aria-hidden style={{ '--i': i } as React.CSSProperties}>
          {c === ' ' ? ' ' : c}
        </span>
      ))}
    </h2>
  );
}
// How long "Signed in" shows before the app carries on.
const DONE_MS = 900;

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

// Signing in, for organizations (account.ts): Google, GitHub, or a code by
// email - the same code makes an account the first time. Development without
// Clerk: an email and a name, no code.
// Looks like an email address: until it does, the button waits (greyed, saying why).
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SignIn({ onDone: finished, onCancel: close, mode: asked = 'in', from = null }: { onDone: () => void; onCancel: () => void; mode?: 'in' | 'up'; from?: DOMRect | null }) {
  // Signed in: a moment of "Signed in" floating, the logo launching, then on.
  const [signedIn, setSignedIn] = useState(false);
  const onDone = () => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return finished();
    setSignedIn(true);
    window.setTimeout(finished, DONE_MS);
  };
  // Either dialog links to the other ("Need an account? SIGN UP").
  const [mode, setMode] = useState(asked);
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
  const [shaking, setShaking] = useState(false);
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
      // The title gives a short shake as it says why.
      setShaking(true);
      window.setTimeout(() => setShaking(false), 520);
    }
    setBusy(false);
  };
  const mood: Mood = signedIn ? 'done' : busy ? 'wave' : shaking ? 'shake' : 'land';
  const submit = () =>
    run(async () => {
      if (dev) return void (await devSignIn(email, name, mode), onDone());
      if (finish) return void (await finish(code.trim()), onDone());
      const next = await emailCode(email.trim());
      setFinish(() => next);
    });

  if (!state.signIn)
    return (
      <div className="confirm-scrim" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
        <div ref={box} className={`confirm signin${from ? ' grows' : ''}`} role="dialog" aria-labelledby="signin-title">
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
          title={signedIn ? (mode === 'up' ? 'SIGNED UP' : 'SIGNED IN') : finish ? 'Check your email' : mode === 'up' ? 'SIGN UP' : 'SIGN IN'}
          sub={!finish && !signedIn && mode === 'up' ? 'to unlock EXTREMELY agentic collaboration' : undefined}
          mood={mood}
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
            {busy ? 'One moment...' : finish || dev ? (mode === 'up' ? 'SIGN UP' : 'SIGN IN') : 'Continue'}
          </button>
        </div>
      </form>
    </div>
  );
}
