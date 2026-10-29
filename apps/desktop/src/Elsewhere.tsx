import { useState } from 'react';
import { hostedHere, hostHere, state, switchAgency, teamOrgs, type OrgView } from './account';

// An organisation whose agency isn't on this computer. Members reach it from
// here with the relay (docs/architecture.md, build order phase 4). Its owner,
// if nothing hosts it yet (creating it stopped part-way), can host it here.
export function Elsewhere({ org }: { org: OrgView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const others = teamOrgs().filter(o => o.id !== org.id && (o.role === 'owner' || hostedHere(o)));
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
            : org.role === 'owner'
              ? 'It runs on your other computer. Reaching it from here isn’t built yet.'
              : 'It runs on its owner’s computer. Reaching it from here isn’t built yet.'}
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
