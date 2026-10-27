import { useRef, useState } from 'react';
import { Calendar, Check, ChevronDown } from 'lucide-react';
import { TIME_RANGES, rangeLabel, type TimeRange } from './data';
import { useDismiss } from './useDismiss';

export function RangePicker({ value, onChange }: { value: TimeRange; onChange: (r: TimeRange) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useDismiss(ref, open, () => setOpen(false));

  return (
    <div className={`range-picker${open ? ' open' : ''}`} ref={ref}>
      <button className="range-btn" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open}>
        <Calendar size={15} strokeWidth={1.75} />
        {rangeLabel(value)}
        <ChevronDown size={15} className="muted chev" />
      </button>
      {open && (
        <ul className="dropdown-menu" role="listbox">
          {TIME_RANGES.map(r => (
            <li key={r.value}>
              <button
                role="option"
                aria-selected={r.value === value}
                className="dropdown-option"
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
