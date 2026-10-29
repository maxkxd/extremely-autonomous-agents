import { ModelConnectors } from './ModelConnectors';
import { useHasModels } from './NoModels';

// The first thing a new install shows: who we are, then the one step nothing
// works without - an AI model (a plan you already pay for, or an API key). Next
// once one's connected; Skip goes straight to the dashboard (agents then say
// what's missing). Once either is pressed it's never shown again on this computer.

const KEY = 'eaa.onboarded';
export const onboarded = () => {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true;
  }
};

export function Onboarding({ onDone }: { onDone: () => void }) {
  const has = useHasModels();
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
        <button className="sbtn onboarding-skip" onClick={done}>
          Skip
        </button>
        <button className="sbtn primary" disabled={!has} onClick={done}>
          Next
        </button>
      </footer>
    </div>
  );
}
