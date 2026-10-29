import { Play, Square } from 'lucide-react';

// Stop the whole agency (next to the time range on the dashboard): every run is
// cut short and nothing starts, built-in agents included, until it's resumed.
export function AgencyStop({ stopped, onChange }: { stopped: boolean; onChange: (stopped: boolean) => void }) {
  return (
    <button className={`ctl-btn agency-stop ${stopped ? 'resume' : 'stop'}`} onClick={() => onChange(!stopped)}>
      {stopped ? <Play size={15} /> : <Square size={13} fill="currentColor" />}
      {stopped ? 'Resume agency' : 'Stop agency'}
    </button>
  );
}
