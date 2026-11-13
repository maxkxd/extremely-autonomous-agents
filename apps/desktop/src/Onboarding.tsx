import { useEffect, useRef, useState } from 'react';
import { useMoreBelow } from './moreBelow';
import { checkModel, getAvailableModels, type AvailableModels } from './builder';
import { ConnectionTests, Crayon, ModelConnectors, type ConnectionTestState } from './ModelConnectors';
import { BusyLabel } from './Busy';

// The first thing a new install shows: who we are, then the one step nothing
// works without - an AI model (a plan you already pay for, or an API key). Next
// once one's connected and has really answered a test request (connected isn't
// working: a plan's program missing, a key with no credit); Skip goes straight
// to the dashboard (agents then say what's missing) - with no working AI yet, after
// saying what that means. Once either is pressed it's never shown again on this computer.

const KEY = 'eaa.onboarded';
export const onboarded = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true;
  }
};

// The model a connection is tested with: a small, quick one when it has one.
const QUICK = /mini|nano|flash|haiku|small|lite|fast/i;
const testModel = (c: AvailableModels) => c.models.find(m => QUICK.test(m)) ?? c.models[0];

type Test = { state: 'testing' } | { state: 'ok' } | { state: 'failed'; reason: string };

// Each connected AI, tested once (again if what it has changes: reconnected).
function useModelTests() {
  const [connected, setConnected] = useState<AvailableModels[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tests, setTests] = useState<Record<string, Test>>({});
  useEffect(() => {
    let live = true;
    const look = () =>
      getAvailableModels().then(a => {
        if (!live) return;
        setConnected(a.filter(c => c.models.length > 0));
        setLoaded(true);
      }, () => {});
    look();
    const t = window.setInterval(look, 3000);
    return () => {
      live = false;
      window.clearInterval(t);
    };
  }, []);
  const signature = connected.map(c => `${c.connection}:${c.models.join(',')}`).join('|');
  const [tested, setTested] = useState<Record<string, string>>({});
  useEffect(() => {
    for (const c of connected) {
      const sig = c.models.join(',');
      if (tested[c.connection] === sig) continue;
      setTested(t => ({ ...t, [c.connection]: sig }));
      setTests(t => ({ ...t, [c.connection]: { state: 'testing' } }));
      checkModel(c.connection, testModel(c), true).then(
        ({ check }) => setTests(t => ({ ...t, [c.connection]: check.ok ? { state: 'ok' } : { state: 'failed', reason: check.reason ?? "It didn't answer." } })),
        e => setTests(t => ({ ...t, [c.connection]: { state: 'failed', reason: (e as Error).message } })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  const current = connected.map(c => ({ c, test: tests[c.connection] ?? ({ state: 'testing' } as Test) }));
  return {
    ok: current.some(x => x.test.state === 'ok'),
    // For the rows' badges (ModelConnectors' ConnectionTests): Connecting until it answers.
    rows: { loaded, states: Object.fromEntries(current.map(x => [x.c.connection, x.test.state])) as Record<string, ConnectionTestState> },
    testing: current.some(x => x.test.state === 'testing'),
    failed: current.flatMap(x => (x.test.state === 'failed' ? [{ name: x.c.name, reason: x.test.reason }] : [])),
  };
}

// Skipping with no AI that works: nothing can run, so say so first.
function SkipDialog({ onCancel, onSkip }: { onCancel: () => void; onSkip: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="confirm-scrim" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="confirm" role="alertdialog" aria-labelledby="skip-title" aria-describedby="skip-body">
        <h2 id="skip-title">Skip without an AI model?</h2>
        <p id="skip-body">
          Nothing runs without one: you can't build agents, and the built-in agents can't start. You can connect one any time in Settings, under
          Connectors. Joining an existing team? Skip anyway - your team's AI does the work there.
        </p>
        <div className="confirm-actions">
          <button className="confirm-cancel" onClick={onCancel}>
            Go back
          </button>
          <button className="confirm-resume" onClick={onSkip}>
            Skip anyway
          </button>
        </div>
      </div>
    </div>
  );
}

// The motion (styles.css, .onboarding): arriving, the logo flies in from the left
// and the rest fades up after it; a connected AI's badge says Connecting, grey and
// pulsing, until its test answers (no celebration when it does: Max, 2026-11-13);
// Next launches the logo off to the right and the dashboard opens behind it
// (App.tsx). Reduced motion: none of it.
const LAUNCH_MS = 650;
const ARRIVE_MS = 1400;

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { ok, rows, testing, failed } = useModelTests();
  const [skipping, setSkipping] = useState(false);
  const [launching, setLaunching] = useState(false);
  // Arriving: on for its length, then off (left on, any later animation change replayed it).
  const [arriving, setArriving] = useState(true);
  useEffect(() => {
    const t = window.setTimeout(() => setArriving(false), ARRIVE_MS);
    return () => window.clearTimeout(t);
  }, []);
  const root = useRef<HTMLDivElement>(null);
  // What continues under the Skip / Next bar: a fade says so.
  const body = useRef<HTMLDivElement>(null);
  const moreBelow = useMoreBelow(body);
  const done = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // Storage unavailable: it shows again next time.
    }
    onDone();
  };
  // Next: the logo launches off to the right, then the app opens behind it.
  const launch = () => {
    if (launching) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return done();
    setLaunching(true);
    window.setTimeout(done, LAUNCH_MS);
  };
  return (
    <div className={`onboarding${arriving ? ' arriving' : ''}${ok ? ' ready' : ''}${launching ? ' launching' : ''}`} ref={root}>
      <div className={`onboarding-body${moreBelow ? ' more-below' : ''}`} ref={body}>
        <header className="onboarding-head">
          {/* The logo, as on extremely.agency (extremely-agency-site/logo.svg). */}
          <svg className="onboarding-logo" viewBox="-42 0 164 96" role="img" aria-label="Extremely Autonomous Agents logo">
            <polygon fill="#3f7bd6" points="2,32 56,50 2,68 24,50" />
            <polygon fill="#e5484d" points="-40,8 120,44 44,78 78,50" />
          </svg>
          <h1 className="onboarding-title">
            EXTREMELY <span>Autonomous Agents</span>
          </h1>
          <p className="onboarding-lead">Connect an AI model to start: a plan you already pay for, or an API key.</p>
        </header>
        <div className="onboarding-models ssection">
          <ConnectionTests.Provider value={rows}>
            <ModelConnectors />
          </ConnectionTests.Provider>
        </div>
      </div>
      <footer className="onboarding-foot">
        {!ok && !testing && failed.length > 0 && (
          <p className="onboarding-failed">
            {failed.map(f => `${f.name} didn't work: ${f.reason}`).join(' ')}
          </p>
        )}
        {/* With one working there's nothing to skip: Skip and Next did the same thing. */}
        {/* Someone joining a teammate's organization needs no AI of their own: Skip is their way in. */}
        {!ok && (
          <span className="onboarding-team-tip">
            <span className="mtip-text">Joining an existing team? Skip this and sign in</span>
            <Crayon className="onboarding-team-arrow" viewBox="0 0 60 50" shaft="M57 30 C 44 21, 26 20, 8 28" head="M17 19 C 14 22, 11 25, 6 29 C 11 32, 14 34, 18 38" />
          </span>
        )}
        {!ok && (
          <button className="sbtn onboarding-skip" onClick={() => setSkipping(true)}>
            Skip
          </button>
        )}
        <button className="sbtn primary onboarding-next" disabled={!ok} onClick={launch}>
          <BusyLabel busy={!ok && testing} busyText="Testing">Next</BusyLabel>
        </button>
      </footer>
      {skipping && <SkipDialog onCancel={() => setSkipping(false)} onSkip={done} />}
    </div>
  );
}
