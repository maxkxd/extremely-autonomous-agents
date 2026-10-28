import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import { AlertTriangle, ChevronRight, Cpu, Search, X } from 'lucide-react';
import { checkModel, EFFORTS, getModelChecks, type AvailableModels, type Effort, type ModelCheck, type ModelChoice } from './builder';

// An agent's models on its dashboard card (docs/model-connections.md): up to
// three in order - #1 runs, #2 and #3 take over if it fails. The card shows #1
// under Est. Output; clicking it slides the right column over the pies and
// opens this picker in the space it leaves.

const SLOTS = 3;
const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', max: 'Max' };

const isUsable = (c: ModelChoice, available: AvailableModels[]) =>
  available.some(a => a.connection === c.connection && a.models.includes(c.model));
// Why a choice can't run: its connection is gone, the connection no longer
// offers it, or its check found it doesn't work on this account.
export type Checks = Record<string, ModelCheck>;
const checkKey = (c: { connection: string; model: string }) => `${c.connection}/${c.model}`;
const whyNot = (c: ModelChoice, available: AvailableModels[], checks: Checks = {}) => {
  if (!isUsable(c, available)) return available.some(a => a.connection === c.connection) ? 'Unavailable' : 'Not connected';
  const check = checks[checkKey(c)];
  return check && !check.ok && !check.pending ? check.reason ?? 'Not working' : null;
};
// The levels a model takes - none for one without an effort setting.
const effortsOf = (connection: string, model: string, available: AvailableModels[]): Effort[] =>
  available.find(a => a.connection === connection)?.efforts?.[model] ?? [];
// The nearest level the model takes to the one wanted (server: models/caps.ts).
function fitEffort(want: Effort, efforts: Effort[]): Effort {
  if (!efforts.length || efforts.includes(want)) return want;
  const at = EFFORTS.indexOf(want);
  const gap = (e: Effort) => Math.abs(EFFORTS.indexOf(e) - at);
  return [...efforts].sort((a, b) => gap(a) - gap(b) || EFFORTS.indexOf(a) - EFFORTS.indexOf(b))[0];
}
const connectionName = (id: string, available: AvailableModels[]) => available.find(a => a.connection === id)?.name ?? id;
const modelLabel = (c: ModelChoice) => (c.connection === 'copilot' && c.model === 'auto' ? 'Copilot (auto)' : c.model);

// The collapsed row: #1 and its effort, or a flag when there's nothing to run on.
export function ModelRow({
  choices,
  available,
  onOpen,
  open,
  readOnly,
  checks,
}: {
  choices: ModelChoice[];
  available: AvailableModels[];
  onOpen: () => void;
  open: boolean;
  readOnly?: boolean;
  checks?: Checks;
}) {
  const first = choices[0];
  const problem = !first ? 'No model' : available.length ? whyNot(first, available, checks) : null;
  // The level that will actually be used: a choice saved before its model's
  // levels were known shows (and runs at) the nearest one it takes.
  const firstEfforts = first && !problem ? effortsOf(first.connection, first.model, available) : [];
  return (
    <button
      className={`model-row${problem ? ' flagged' : ''}${open ? ' open' : ''}`}
      onClick={onOpen}
      disabled={readOnly}
      title={
        first
          ? `${modelLabel(first)} on ${connectionName(first.connection, available)}${problem ? ` - ${problem}: pick another model` : ''}`
          : 'This agent has no model to run on'
      }
    >
      <span className="stat-label">Model</span>
      <span className="model-row-value">
        {problem && <AlertTriangle size={12} strokeWidth={2.2} />}
        {first ? (
          <>
            <span className="model-row-name">{modelLabel(first)}</span>
            {firstEfforts.length > 0 && <span className="model-row-effort">{EFFORT_LABEL[fitEffort(first.effort, firstEfforts)]}</span>}
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
  checks = {},
  onCheck,
}: {
  choices: ModelChoice[];
  available: AvailableModels[];
  onChange: (next: ModelChoice[]) => void;
  checks?: Checks;
  onCheck?: (connection: string, model: string) => void; // a model was just picked: test it
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
    const effort = fitEffort(next[slot]?.effort ?? 'medium', effortsOf(connection, model, available));
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
    onCheck?.(connection, model);
    // Replacing a model stays on its slot; filling an empty one moves on to
    // the next empty one.
    if (!choices[slot]) setSlot(Math.min(clean.length, SLOTS - 1));
  };
  const remove = (i: number) => {
    const next = choices.filter((_, j) => j !== i);
    onChange(next);
    setSlot(Math.min(next.length, SLOTS - 1));
  };
  // Only the levels the slot's model takes; none greys the row out.
  const current = choices[slot];
  const currentWorks = !!current && !whyNot(current, available, checks);
  const slotEfforts = currentWorks ? effortsOf(current.connection, current.model, available) : [];
  const slotEffort = current && fitEffort(current.effort, slotEfforts);
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
              className={`model-slot${slot === i ? ' active' : ''}${c ? '' : ' empty'}${c && whyNot(c, available, checks) ? ' flagged' : ''}`}
              disabled={!reachable}
              onClick={() => setSlot(i)}
              title={c ? `${modelLabel(c)} on ${connectionName(c.connection, available)}${whyNot(c, available, checks) ? ` - ${whyNot(c, available, checks)}` : ''}` : reachable ? 'Pick a model below' : undefined}
            >
              <span className="model-slot-n">{i + 1}</span>
              <span className="model-slot-text">
                <span className="model-slot-name">{c ? modelLabel(c) : reachable ? 'Pick a model' : '-'}</span>
                {c && (
                  <span className="model-slot-sub">
                    {checks[checkKey(c)]?.pending ? 'Checking...' : whyNot(c, available, checks) ?? connectionName(c.connection, available)}
                  </span>
                )}
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
                  <X size={14} />
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className={`model-effort${slotEfforts.length ? '' : ' off'}`}>
        <span className="stat-label">Effort</span>
        {slotEfforts.length ? (
          <div className="model-effort-options">
            {slotEfforts.map(e => (
              <button key={e} className={slotEffort === e ? 'on' : ''} onClick={() => setEffort(e)}>
                {EFFORT_LABEL[e]}
              </button>
            ))}
          </div>
        ) : (
          <span className="model-effort-none">
            {!current ? 'Pick a model first' : currentWorks ? 'Not adjustable for this model' : 'Pick another model'}
          </span>
        )}
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
                    const result = checks[checkKey({ connection: g.connection, model: m })];
                    const failed = result && !result.ok && !result.pending;
                    return (
                      <li key={m}>
                        <button
                          className={`${at >= 0 ? 'chosen' : ''}${failed ? ' failed' : ''}`}
                          onClick={() => pick(g.connection, m)}
                          title={failed ? result.reason : undefined}
                        >
                          {failed ? <AlertTriangle size={12} className="model-item-icon warn" /> : <Cpu size={13} className="model-item-icon" />}
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

// Each chosen model's check (models/check.ts on the server): the kept results,
// a check for any chosen model that has none, and a fresh one when a model is
// picked. A check can learn a model's exact effort levels, so it hands back
// the updated list of what's connected.
export function useModelChecks(chosen: ModelChoice[], setAvailable: (a: AvailableModels[]) => void) {
  const [checks, setChecks] = useState<Checks>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    getModelChecks()
      .then(all => setChecks(prev => ({ ...all, ...prev })))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);
  const run = useCallback(
    (connection: string, model: string, force = false) => {
      const key = checkKey({ connection, model });
      setChecks(prev => ({ ...prev, [key]: { ...(prev[key] ?? { ok: true, at: 0 }), pending: true } }));
      checkModel(connection, model, force).then(
        ({ check, available }) => {
          setChecks(prev => ({ ...prev, [key]: check }));
          setAvailable(available);
        },
        () => setChecks(prev => ({ ...prev, [key]: { ...prev[key], pending: false } })),
      );
    },
    [setAvailable],
  );
  const missing = loaded ? [...new Set(chosen.map(checkKey))].filter(k => !checks[k]) : [];
  useEffect(() => {
    for (const k of missing) {
      const c = chosen.find(x => checkKey(x) === k);
      if (c) run(c.connection, c.model);
    }
  }, [missing.join('|')]);
  return { checks, check: (connection: string, model: string) => run(connection, model, true) };
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
    // Clicks in the picker or in this card's slid-over column (the Model row,
    // the controls above it) keep it open; anywhere else closes it.
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      const el = card.current;
      const inside = !!el && (!!el.querySelector('.model-panel')?.contains(t) || !!el.querySelector('.card-side')?.contains(t));
      if (!inside) close();
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
