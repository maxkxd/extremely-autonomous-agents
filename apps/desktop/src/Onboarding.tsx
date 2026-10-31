import { useEffect, useState } from 'react';
import { checkModel, getAvailableModels, type AvailableModels } from './builder';
import { ModelConnectors } from './ModelConnectors';

// The first thing a new install shows: who we are, then the one step nothing
// works without - an AI model (a plan you already pay for, or an API key). Next
// once one's connected and has really answered a test request (connected isn't
// working: a plan's program missing, a key with no credit); Skip goes straight
// to the dashboard (agents then say what's missing). Once either is pressed it's never shown again on this computer.

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
  const [tests, setTests] = useState<Record<string, Test>>({});
  useEffect(() => {
    let live = true;
    const look = () => getAvailableModels().then(a => live && setConnected(a.filter(c => c.models.length > 0)), () => {});
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
    testing: current.some(x => x.test.state === 'testing'),
    failed: current.flatMap(x => (x.test.state === 'failed' ? [{ name: x.c.name, reason: x.test.reason }] : [])),
  };
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { ok, testing, failed } = useModelTests();
  const done = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      // Storage unavailable: it shows again next time.
    }
    onDone();
  };
  return (
    <div className="onboarding">
      <div className="onboarding-body">
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
          <ModelConnectors />
        </div>
      </div>
      <footer className="onboarding-foot">
        {!ok && !testing && failed.length > 0 && (
          <p className="onboarding-failed">
            {failed.map(f => `${f.name} didn't work: ${f.reason}`).join(' ')}
          </p>
        )}
        <button className="sbtn onboarding-skip" onClick={done}>
          Skip
        </button>
        <button className="sbtn primary" disabled={!ok} onClick={done}>
          {!ok && testing ? 'Testing…' : 'Next'}
        </button>
      </footer>
    </div>
  );
}
