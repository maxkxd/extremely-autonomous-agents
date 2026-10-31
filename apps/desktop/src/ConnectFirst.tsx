import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Star } from 'lucide-react';
import { scoped } from './account';
import { getConnectFirst, type ConnectFirst as Data } from './builder';
import { openSettings } from './NoModels';
import { Loading, Skel } from './Skeleton';

// "Connect these first", above the agent cards: what to connect, ranked by how
// many agents each unlocks (a star per agent, up to five), with the fleet's
// progress. A connection that frees an agent fills the bar and says so.
const SHOWN = 5;
const STARS = 5;
// Whether it had anything to show last time: its skeleton shows while the
// Dashboard loads only then, so a fully connected agency never flashes one.
const HAD = scoped('eaa.connectFirstHad');
const hadLast = () => {
  try {
    return localStorage.getItem(HAD) !== '0';
  } catch {
    return true;
  }
};

const Stars = ({ n }: { n: number }) => (
  <span className="cf-stars" aria-label={`Unlocks ${n} agent${n === 1 ? '' : 's'}`}>
    {Array.from({ length: Math.min(STARS, n) }, (_, i) => (
      <Star key={i} size={13} className="cf-star" />
    ))}
    {n > STARS && <span className="cf-more">+{n - STARS}</span>}
  </span>
);

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
          try {
            localStorage.setItem(HAD, d.services.some(s => !s.connected) ? '1' : '0');
          } catch {
            // Storage unavailable - the skeleton just shows next time too.
          }
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

  // Loading: the same frame as the cards' skeletons.
  if (!data)
    return hadLast() ? (
      <section className="cf" aria-busy>
        <Loading what="what to connect first" />
        <header className="cf-head">
          <Skel w={150} h={15} />
          <Skel w={140} h={12} />
        </header>
        <span className="cf-bar">
          <Skel w="100%" h={8} r={99} />
        </span>
        <ol className="cf-list">
          {Array.from({ length: SHOWN }, (_, i) => (
            <li key={i} className="cf-row">
              <Skel w={i % 2 ? 90 : 120} h={13} />
              <Skel w={70} h={13} />
              <Skel w={i % 2 ? 160 : 210} h={13} />
              <span className="cf-act">
                <Skel w={74} h={28} r={7} />
              </span>
            </li>
          ))}
        </ol>
      </section>
    ) : null;

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
        {cheer && <span className="cf-cheer">{cheer}</span>}
        <span className="cf-done">
          <Check size={13} strokeWidth={2.25} /> {data.connections.done} of {data.connections.total} connected
        </span>
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
                <span title={`Unlocks ${s.agents.map(a => a.name).join(', ')}`}>
                  <Stars n={s.agents.length} />
                </span>
                <span className="cf-what">
                  Unlocks {s.agents.length === 1 ? s.agents[0].name : `${s.agents.length} agents`}
                  {!s.settingUp && s.needs && <span className="muted"> · needs {s.needs}</span>}
                </span>
                <span className="cf-act">
                  {s.settingUp ? (
                    <span className="cf-wait">Agency Engineer is setting it up</span>
                  ) : (
                    <button className="cf-connect" onClick={() => openSettings('connectors', s.integrationId ?? undefined)}>
                      Connect
                    </button>
                  )}
                </span>
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
