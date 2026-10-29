import { useState } from 'react';
import { hostHere, state, switchAgency, teamOrgs, type OrgView } from './account';

// An organisation that can't be reached right now: its host is offline, or
// nothing hosts it yet (creating it stopped part-way: its owner can host it here).
export function Elsewhere({ org }: { org: OrgView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = teamOrgs().filter(o => o.id !== org.id);
  const canHost = org.role === 'owner' && !org.host.registered && !state.hosting;
  const host = async () => {
    setBusy(true);
    setError(null);
    try {
      await hostHere(org);
      location.reload();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="signed-out">
      <div>
        <h1>{org.name}</h1>
        <p>
          {org.role === 'owner' && !org.host.registered
            ? `It isn't running anywhere yet.${state.hosting ? ` This computer already hosts ${state.hosting.orgName}.` : ''}`
            : state.unreachable === 'offline'
              ? org.role === 'owner'
                ? 'The computer that hosts it is offline. It can be reached again once that computer is on with the app open.'
                : 'Its host is offline. It can be reached again once the owner’s computer is on with the app open.'
              : `It can't be reached right now: ${state.unreachable}`}
        </p>
        {error && <p className="custom-error">{error}</p>}
        <div className="elsewhere-actions">
          {canHost && (
            <button className="sbtn primary" disabled={busy} onClick={host}>
              {busy ? 'Starting...' : 'Host it on this computer'}
            </button>
          )}
          <button className={`sbtn${canHost ? '' : ' primary'}`} onClick={() => switchAgency('personal')}>
            Back to your agency
          </button>
          {others.map(o => (
            <button key={o.id} className="sbtn" onClick={() => switchAgency(o.id)}>
              {o.name}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
