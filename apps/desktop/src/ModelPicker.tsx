import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { AlertTriangle, ChevronRight, Cpu, Search, X } from 'lucide-react';
import { EFFORTS, type AvailableModels, type Effort, type ModelChoice } from './builder';

// An agent's models on its dashboard card (docs/model-connections.md): up to
// three in order - #1 runs, #2 and #3 take over if it fails. The card shows #1
// under Est. Output; clicking it slides the right column over the pies and
// opens this picker in the space it leaves.

const SLOTS = 3;
const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };

const isUsable = (c: ModelChoice, available: AvailableModels[]) =>
  available.some(a => a.connection === c.connection && a.models.includes(c.model));
const connectionName = (id: string, available: AvailableModels[]) => available.find(a => a.connection === id)?.name ?? id;
const modelLabel = (c: ModelChoice) => (c.connection === 'copilot' && c.model === 'auto' ? 'Copilot (auto)' : c.model);

// The collapsed row: #1 and its effort, or a flag when there's nothing to run on.
export function ModelRow({
  choices,
  available,
  onOpen,
  open,
  readOnly,
}: {
  choices: ModelChoice[];
  available: AvailableModels[];
  onOpen: () => void;
  open: boolean;
  readOnly?: boolean;
}) {
  const first = choices[0];
  const problem = !first ? 'No model' : !isUsable(first, available) && available.length ? 'Not connected' : null;
  return (
    <button
      className={`model-row${problem ? ' flagged' : ''}${open ? ' open' : ''}`}
      onClick={onOpen}
      disabled={readOnly}
      title={first ? `${modelLabel(first)} on ${connectionName(first.connection, available)}` : 'This agent has no model to run on'}
    >
      <span className="stat-label">Model</span>
      <span className="model-row-value">
        {problem && <AlertTriangle size={12} strokeWidth={2.2} />}
        {first ? (
          <>
            <span className="model-row-name">{modelLabel(first)}</span>
            <span className="model-row-effort">{EFFORT_LABEL[first.effort]}</span>
          </>
        ) : (
          problem
        )}
        {!readOnly && <ChevronRight size={14} className="model-row-chev" />}
      </span>
    </button>
  );
}

// The picker: three slots, the active slot's effort, then every connected
// provider as a group that opens with its arrow, and a search over them all.
export function ModelPanel({
  choices,
  available,
  onChange,
}: {
  choices: ModelChoice[];
  available: AvailableModels[];
  onChange: (next: ModelChoice[]) => void;
}) {
  const [slot, setSlot] = useState(Math.min(choices.length, SLOTS - 1));
  const [query, setQuery] = useState('');
  const [openGroups, setOpenGroups] = useState<Set<string>>(
    () => new Set(choices[0] ? [choices[0].connection] : available[0] ? [available[0].connection] : []),
  );
  const q = query.trim().toLowerCase();
  const groups = useMemo(
    () =>
      available
        .map(a => ({ ...a, shown: q ? a.models.filter(m => m.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)) : a.models }))
        .filter(a => !q || a.shown.length),
    [available, q],
  );

  const pick = (connection: string, model: string) => {
    const next = [...choices];
    const existing = next.findIndex(c => c.connection === connection && c.model === model);
    const effort = next[slot]?.effort ?? 'medium';
    if (existing >= 0 && existing !== slot) {
      // Already in another slot: swap them.
      const moved = next[existing];
      next[existing] = next[slot];
      next[slot] = moved;
    } else {
      next[slot] = { connection, model, effort };
    }
    const clean = next.filter(Boolean).slice(0, SLOTS);
    onChange(clean);
    setSlot(Math.min(clean.length, SLOTS - 1));
  };
  const remove = (i: number) => {
    const next = choices.filter((_, j) => j !== i);
    onChange(next);
    setSlot(Math.min(next.length, SLOTS - 1));
  };
  const setEffort = (effort: Effort) => {
    if (!choices[slot]) return;
    onChange(choices.map((c, i) => (i === slot ? { ...c, effort } : c)));
  };
  const toggle = (id: string) =>
    setOpenGroups(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="model-panel" onPointerDown={e => e.stopPropagation()}>
      <div className="model-slots">
        {Array.from({ length: SLOTS }, (_, i) => {
          const c = choices[i];
          const reachable = i <= choices.length;
          return (
            <button
              key={i}
              className={`model-slot${slot === i ? ' active' : ''}${c ? '' : ' empty'}${c && !isUsable(c, available) ? ' flagged' : ''}`}
              disabled={!reachable}
              onClick={() => setSlot(i)}
              title={c ? `${modelLabel(c)} on ${connectionName(c.connection, available)}` : reachable ? 'Pick a model below' : undefined}
            >
              <span className="model-slot-n">{i + 1}</span>
              <span className="model-slot-text">
                <span className="model-slot-name">{c ? modelLabel(c) : reachable ? 'Pick a model' : '-'}</span>
                {c && <span className="model-slot-sub">{connectionName(c.connection, available)}</span>}
              </span>
              {c && (
                <span
                  className="model-slot-x"
                  role="button"
                  aria-label={`Remove model ${i + 1}`}
                  onClick={e => {
                    e.stopPropagation();
                    remove(i);
                  }}
                >
                  <X size={12} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className={`model-effort${choices[slot] ? '' : ' off'}`}>
        <span className="stat-label">Effort</span>
        <div className="model-effort-options">
          {EFFORTS.map(e => (
            <button key={e} className={choices[slot]?.effort === e ? 'on' : ''} disabled={!choices[slot]} onClick={() => setEffort(e)}>
              {EFFORT_LABEL[e]}
            </button>
          ))}
        </div>
      </div>

      <label className="model-search">
        <Search size={14} />
        <input value={query} placeholder="Search models" onChange={e => setQuery(e.target.value)} />
      </label>

      <div className="model-groups">
        {!available.length && <p className="model-empty">No models connected. Add one in Settings → Connectors.</p>}
        {available.length > 0 && !groups.length && <p className="model-empty">No models match "{query}".</p>}
        {groups.map(g => {
          const expanded = !!q || openGroups.has(g.connection);
          return (
            <div key={g.connection} className={`model-group${expanded ? ' open' : ''}`}>
              <button className="model-group-head" onClick={() => toggle(g.connection)} aria-expanded={expanded}>
                <ChevronRight size={14} className="model-group-chev" />
                <span className="model-group-name">{g.name}</span>
                <span className="model-group-kind">{g.kind === 'plan' ? 'Plan' : g.kind === 'local' ? 'Local' : 'API key'}</span>
                <span className="model-group-count">{g.models.length}</span>
              </button>
              {expanded && (
                <ul className="model-list">
                  {g.shown.map(m => {
                    const at = choices.findIndex(c => c.connection === g.connection && c.model === m);
                    return (
                      <li key={m}>
                        <button className={at >= 0 ? 'chosen' : ''} onClick={() => pick(g.connection, m)}>
                          <Cpu size={13} className="model-item-icon" />
                          <span className="model-item-name">{modelLabel({ connection: g.connection, model: m, effort: 'medium' })}</span>
                          {at >= 0 && <span className="model-item-n">{at + 1}</span>}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// The slide: the right column moves left over the pies by exactly the pies'
// width, and the picker fills the space it leaves. A click anywhere outside
// the column or the picker slides it back. On a narrow card (column stacked
// under the pies) the picker covers the pies instead.
export function useModelSlide(
  card: RefObject<HTMLElement>,
  open: boolean,
  close: () => void,
): { shift: number; stacked: boolean } {
  const [layout, setLayout] = useState({ shift: 0, stacked: false });
  useLayoutEffect(() => {
    if (!open || !card.current) return;
    const measure = () => {
      const el = card.current;
      const charts = el?.querySelector('.card-charts')?.getBoundingClientRect();
      const side = el?.querySelector('.card-side')?.getBoundingClientRect();
      if (!charts || !side) return;
      const stacked = side.top > charts.top + 20;
      setLayout({ shift: stacked ? 0 : Math.max(0, side.left - charts.left), stacked });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, card]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!t.closest('.model-panel') && !t.closest('.model-row')) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return layout;
}
