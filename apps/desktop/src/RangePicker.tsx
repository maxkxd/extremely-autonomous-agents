import { useEffect, useRef, useState } from 'react';
import { Calendar, Check, ChevronDown } from 'lucide-react';
import { TIME_RANGES, rangeLabel, type TimeRange } from './data';

export function RangePicker({ value, onChange }: { value: TimeRange; onChange: (r: TimeRange) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="range-picker" ref={ref}>
      <button className="range-btn" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <Calendar size={15} strokeWidth={1.75} />
        {rangeLabel(value)}
        <ChevronDown size={15} className="muted" />
      </button>
      {open && (
        <ul className="range-menu" role="listbox">
          {TIME_RANGES.map(r => (
            <li key={r.value}>
              <button
                role="option"
                aria-selected={r.value === value}
                className="range-option"
                onClick={() => {
                  onChange(r.value);
                  setOpen(false);
                }}
              >
                {r.label}
                {r.value === value && <Check size={15} />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
