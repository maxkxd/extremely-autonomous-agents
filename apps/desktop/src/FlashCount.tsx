import { useRef } from 'react';
import { Check, CircleMinus, X } from 'lucide-react';

export type Outcome = 'approved' | 'rejected' | 'expired';

const ICON = { approved: Check, rejected: X, expired: CircleMinus };
const LABEL = { approved: 'Approved', rejected: 'Rejected', expired: 'Expired' };

// An outcome icon + count that flashes (green / red / gray) whenever the count
// goes up. The inner span re-mounts on each new count (key), which replays the
// CSS animation; whatever count it first rendered with doesn't flash.
export function FlashCount({
  outcome,
  count,
  size = 'sm',
  title,
}: {
  outcome: Outcome;
  count: number;
  size?: 'sm' | 'lg';
  title?: string;
}) {
  const first = useRef(count);
  const Icon = ICON[outcome];
  const iconSize = size === 'lg' ? 20 : 13;
  return (
    <span className={`flash-count ${outcome} ${size}`} title={title ?? LABEL[outcome]}>
      <span key={count} className={`flash-inner${count > first.current ? ' pop' : ''}`}>
        <Icon size={iconSize} strokeWidth={outcome === 'expired' ? 1.75 : 2.25} />
        {count}
      </span>
    </span>
  );
}
