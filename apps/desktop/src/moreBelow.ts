import { useEffect, useState, type RefObject } from 'react';

// Whether a scrolling box has more below what's in view, for a soft fade at its
// bottom edge (the class "more-below" in styles.css): without one, a list cut off
// at the window's edge looked complete.
export function useMoreBelow(ref: RefObject<HTMLElement | null>) {
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
    check();
    el.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => {
      el.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
      ro.disconnect();
    };
  });
  return more;
}
