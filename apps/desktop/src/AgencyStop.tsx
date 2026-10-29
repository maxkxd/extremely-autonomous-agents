import { Pause, Play, Square } from 'lucide-react';
import type { AgencyState } from './builder';

// The whole agency's Standby and Stop (next to the time range on the
// dashboard), like a card's own pair. Standby: no agent starts anything by
// itself, people are still answered, and building agents and tailoring packs
// go on. Stop: every run is cut short and nothing happens at all - no
// building either - until it's resumed.
export function AgencyControls({ state, onChange }: { state: AgencyState; onChange: (state: AgencyState) => void }) {
  return (
    <div className="agency-controls">
      <button
        className={`ctl-btn agency-btn${state === 'standby' ? ' resume' : ''}`}
        disabled={state === 'stopped'}
        onClick={() => onChange(state === 'standby' ? 'active' : 'standby')}
      >
        {state === 'standby' ? <Play size={15} /> : <Pause size={15} />}
        {state === 'standby' ? 'Resume agency' : 'Standby'}
      </button>
      <button className={`ctl-btn agency-btn ${state === 'stopped' ? 'resume' : 'stop'}`} onClick={() => onChange(state === 'stopped' ? 'active' : 'stopped')}>
        {state === 'stopped' ? <Play size={15} /> : <Square size={13} fill="currentColor" />}
        {state === 'stopped' ? 'Resume agency' : 'Stop agency'}
      </button>
    </div>
  );
}
