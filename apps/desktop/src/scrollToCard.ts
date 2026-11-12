// Scrolling to one card on a long page (a link to an approval or a request).
// The browser's smooth scroll picks its destination once, at the start: on a long
// list the cards above it keep changing height while it travels (the target
// opening, rows loading or collapsing, a refresh), so it stopped where the card
// used to be. This one re-aims at the card every frame, eases in, and keeps
// correcting for a moment after it arrives, until the card holds still.
// Any scrolling of your own takes over at once.

const SETTLE_MS = 900; // after arriving, how long it follows a card that's still moving
const MARGIN = 16; // px above a card brought to the top

function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const y = getComputedStyle(p).overflowY;
    if ((y === 'auto' || y === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function scrollToCard(el: HTMLElement | null, block: 'start' | 'center' = 'center') {
  if (!el) return;
  const scroller = scrollerOf(el);
  if (!scroller) return el.scrollIntoView({ block });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Where the scroller has to be for the card to sit right, as of now.
  const target = () => {
    const box = el.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const offset = block === 'start' ? MARGIN : Math.max(MARGIN, (scroller.clientHeight - box.height) / 2);
    const want = scroller.scrollTop + (box.top - view.top) - offset;
    return Math.max(0, Math.min(want, scroller.scrollHeight - scroller.clientHeight));
  };

  const from = scroller.scrollTop;
  // Longer trips take a little longer, never long enough to feel slow.
  const duration = reduce ? 0 : Math.min(750, 280 + Math.abs(target() - from) / 12);
  const start = performance.now();
  let settledAt = 0;
  let frame = 0;
  let stopped = false;

  const stop = () => {
    stopped = true;
    cancelAnimationFrame(frame);
    for (const e of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) scroller.removeEventListener(e, stop);
  };
  for (const e of ['wheel', 'touchstart', 'keydown', 'mousedown'] as const) scroller.addEventListener(e, stop, { passive: true });

  const step = (now: number) => {
    if (stopped || !el.isConnected) return stop();
    const to = target();
    const t = duration ? Math.min(1, (now - start) / duration) : 1;
    // On the way: a share of the trip to wherever the card is now.
    scroller.scrollTop = t < 1 ? from + (to - from) * ease(t) : to;
    if (t >= 1) {
      // Arrived: stay on it while things above finish moving, then let go.
      if (Math.abs(scroller.scrollTop - to) > 1) settledAt = 0;
      else if (!settledAt) settledAt = now;
      if (now - start > duration + SETTLE_MS || (settledAt && now - settledAt > 250)) return stop();
    }
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}
