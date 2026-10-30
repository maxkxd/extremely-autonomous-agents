import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Star } from 'lucide-react';
import { getConnectFirst, type ConnectFirst as Data } from './builder';
import { openSettings } from './NoModels';

// "Connect these first", above the agent cards: what to connect, ranked by how
// many agents each unlocks, with the fleet's progress. A connection that frees an
// agent fills the bar and says so - setup should feel like getting somewhere.
const SHOWN = 5;
const STARS = 5;

export function ConnectFirst() {
  const [data, setData] = useState<Data | null>(null);
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState(true);
  const [cheer, setCheer] = useState<string | null>(null);
  const before = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      getConnectFirst()
        .then(d => {
          if (!alive) return;
          // An agent unlocked since last look: a moment of celebration.
          if (before.current !== null && d.agents.unlocked > before.current) {
            const n = d.agents.unlocked - before.current;
            setCheer(`${n} more agent${n === 1 ? '' : 's'} unlocked`);
            setTimeout(() => alive && setCheer(null), 5000);
          }
          before.current = d.agents.unlocked;
          setData(d);
        })
        .catch(() => {});
    void load();
    const t = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!data) return null;
  const todo = data.services.filter(s => !s.connected);
  if (!todo.length) return null;
  const { unlocked, total } = data.agents;
  const pct = total ? Math.round((unlocked / total) * 100) : 0;
  const shown = all ? todo : todo.slice(0, SHOWN);

  return (
    <section className={`cf${open ? '' : ' closed'}`} aria-label="Connect these first">
      <header className="cf-head">
        <button className="cf-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>
          <span className="cf-title">Connect these first</span>
          <ChevronDown size={15} className="muted chev" />
        </button>
        <span className="cf-count">
          <strong>{unlocked}</strong> of {total} agents unlocked
        </span>
        <span className="cf-done">
          <Check size={13} strokeWidth={2.25} /> {data.connections.done} of {data.connections.total} connected
        </span>
        {cheer && <span className="cf-cheer">{cheer}</span>}
      </header>
      <div className="cf-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={unlocked}>
        <span className="cf-fill" style={{ width: `${pct}%` }} />
      </div>
      {open && (
        <>
          <ol className="cf-list">
            {shown.map(s => (
              <li key={s.key} className={`cf-row${s.settingUp ? ' setting-up' : ''}`}>
                <span className="cf-name">{s.name}</span>
                <span className="cf-stars" title={`Unlocks ${s.agents.map(a => a.name).join(', ')}`}>
                  {Array.from({ length: Math.min(STARS, s.agents.length) }, (_, n) => (
                    <Star key={n} size={13} className="cf-star" />
                  ))}
                  {s.agents.length > STARS && <span className="cf-more">+{s.agents.length - STARS}</span>}
                </span>
                <span className="cf-what">
                  Unlocks {s.agents.length === 1 ? s.agents[0].name : `${s.agents.length} agents`}
                  {!s.settingUp && s.needs && <span className="muted"> · needs {s.needs}</span>}
                </span>
                {s.settingUp ? (
                  <span className="cf-wait">Agency Engineer is setting it up</span>
                ) : (
                  <button className="cf-connect" onClick={() => openSettings('connectors', s.integrationId ?? undefined)}>
                    Connect
                  </button>
                )}
              </li>
            ))}
          </ol>
          {todo.length > SHOWN && (
            <button className="cf-all" onClick={() => setAll(a => !a)}>
              {all ? 'Show fewer' : `Show all ${todo.length}`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
