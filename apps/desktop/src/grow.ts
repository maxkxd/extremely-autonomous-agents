import { useCallback, useRef } from 'react';

// Opening and closing like the help window (help/HelpButton.tsx): a dialog grows
// out of the button that opened it and shrinks back into it as it closes, its
// contents fading first; a menu unfolds from its trigger and folds back.
//
// Attach with one ref, on the dialog's scrim or the menu's list:
//   const grow = useGrow('dialog');  <div className="confirm-scrim" ref={grow}>
// Closing needs nothing from the parent: when the element is removed, a copy of it
// is left in its place long enough to play the way out, then removed.

type Kind = 'dialog' | 'menu';
const GROW_MS = 380;
const SHRINK_MS = 300;
const MENU_IN_MS = 190;
const MENU_OUT_MS = 150;
const OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const IN = 'cubic-bezier(0.4, 0, 0.6, 1)';

// What was last pressed: where a dialog grows from.
let pressed: { rect: DOMRect; at: number } | null = null;
if (typeof document !== 'undefined')
  document.addEventListener(
    'pointerdown',
    e => {
      const t = e.target instanceof Element ? (e.target.closest('button, a, [role="menuitem"], [role="option"]') ?? e.target) : null;
      if (t) pressed = { rect: t.getBoundingClientRect(), at: Date.now() };
    },
    true,
  );

const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const panelOf = (scrim: HTMLElement) => scrim.querySelector<HTMLElement>('.confirm, .settings') ?? scrim;

// The transform that puts `panel` over `from`, so it can grow out of it.
function fromRect(panel: DOMRect, from: DOMRect | null) {
  if (!from || !from.width) return 'translateY(10px) scale(0.94)';
  const dx = from.left + from.width / 2 - (panel.left + panel.width / 2);
  const dy = from.top + from.height / 2 - (panel.top + panel.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${Math.max(0.05, from.width / panel.width)}, ${Math.max(0.05, from.height / panel.height)})`;
}

function growIn(scrim: HTMLElement, origin: DOMRect | null) {
  const panel = panelOf(scrim);
  // The stylesheet's own fade-in would play on top of this one.
  scrim.style.animation = 'none';
  panel.style.animation = 'none';
  if (reduced()) {
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    return;
  }
  scrim.animate([{ backgroundColor: 'rgba(0, 0, 0, 0)' }, {}], { duration: GROW_MS, easing: 'ease-out' });
  panel.animate([{ transform: fromRect(panel.getBoundingClientRect(), origin), opacity: 0.4, borderRadius: '40px' }, { transform: 'none', opacity: 1 }], {
    duration: GROW_MS,
    easing: OUT,
  });
  for (const child of panel.children) (child as HTMLElement).animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: GROW_MS * 0.55, easing: 'ease-out', fill: 'backwards' });
}

function shrinkOut(copy: HTMLElement, origin: DOMRect | null) {
  const panel = panelOf(copy);
  if (reduced()) return copy.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: 'forwards' });
  for (const child of panel.children) (child as HTMLElement).animate([{ opacity: 1 }, { opacity: 0 }], { duration: 110, fill: 'forwards' });
  panel.animate([{ transform: 'none', opacity: 1 }, { transform: fromRect(panel.getBoundingClientRect(), origin), opacity: 0, borderRadius: '40px' }], {
    duration: SHRINK_MS,
    easing: IN,
    fill: 'forwards',
  });
  return copy.animate([{}, { backgroundColor: 'rgba(0, 0, 0, 0)' }], { duration: SHRINK_MS, easing: 'ease-in', fill: 'forwards' });
}

// A menu opens down from its trigger, or up when it sits above it (the account menu).
const upward = (menu: HTMLElement) => getComputedStyle(menu).top === 'auto';
const fold = (menu: HTMLElement) => [
  { opacity: 0, transform: `translateY(${upward(menu) ? 6 : -6}px) scaleY(0.82)`, transformOrigin: upward(menu) ? 'bottom' : 'top' },
  { opacity: 1, transform: 'none', transformOrigin: upward(menu) ? 'bottom' : 'top' },
];

export function useGrow<T extends HTMLElement>(kind: Kind, also?: (el: T | null) => void) {
  const node = useRef<T | null>(null);
  const origin = useRef<DOMRect | null>(null);
  return useCallback(
    (el: T | null) => {
      also?.(el);
      if (el) {
        node.current = el;
        if (kind === 'menu') {
          if (!reduced()) el.animate(fold(el), { duration: MENU_IN_MS, easing: OUT });
          return;
        }
        // Grown from what was pressed a moment ago; otherwise from just below centre.
        origin.current = pressed && Date.now() - pressed.at < 1500 ? pressed.rect : null;
        growIn(el, origin.current);
        return;
      }
      // Being removed: a copy stays where it was for the way out.
      const gone = node.current;
      node.current = null;
      const parent = gone?.parentElement;
      if (!gone || !parent || !gone.isConnected) return;
      const copy = gone.cloneNode(true) as HTMLElement;
      copy.style.pointerEvents = 'none';
      copy.setAttribute('aria-hidden', 'true');
      copy.removeAttribute('id');
      parent.insertBefore(copy, gone.nextSibling);
      const done = () => copy.remove();
      if (kind === 'menu') {
        if (reduced()) return done();
        copy.animate([...fold(copy)].reverse(), { duration: MENU_OUT_MS, easing: IN, fill: 'forwards' }).finished.then(done, done);
        return;
      }
      shrinkOut(copy, origin.current).finished.then(done, done);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind],
  );
}
