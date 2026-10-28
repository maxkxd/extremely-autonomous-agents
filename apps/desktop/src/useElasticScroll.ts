import { useEffect, type RefObject } from 'react';

// Edge bounce for one scroll container. Chrome on Windows doesn't bounce inner
// scrollers, so we do it ourselves - as an impact, not a stretch:
//   - scrolling into the top or bottom edge kicks the content past it, harder
//     the faster you were scrolling (capped)
//   - an underdamped spring carries it out and back with one small wobble
//   - one kick per gesture: the edge re-arms only after a short quiet gap, so a
//     trackpad's momentum tail (which keeps sending events for ~1s) can't
//     re-trigger or hold it, and two separate scrolls each get a clean bounce
// Nothing accumulates, and scrolling away from the edge is never blocked.
// Moves the scroller's first child, so it works for whatever view is shown.

const IMPULSE = 0.22; // kick velocity (px/frame) per px of scroll delta
const MAX_KICK = 9; // px/frame cap on the kick - roughly a 21px bounce
const STIFFNESS = 0.07; // spring pull back toward rest
const DAMPING = 0.84; // velocity kept per frame; gives one small overshoot
const REARM_GAP = 120; // ms of no edge scrolling before the next kick is allowed
const REST = 0.3; // px; below this (and slow) the bounce is over

export function useElasticScroll(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;

    let offset = 0; // + = content pushed down (hit the top), - = pushed up (hit the bottom)
    let velocity = 0;
    let frame = 0;
    let armed = true;
    let lastEdgeInput = 0;
    let touchY: number | null = null;

    const content = () => scroller.firstElementChild as HTMLElement | null;
    const atTop = () => scroller.scrollTop <= 0;
    const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;

    const render = () => {
      const el = content();
      if (!el) return;
      el.style.transition = 'none';
      el.style.transform = offset ? `translateY(${offset.toFixed(2)}px)` : '';
    };

    const step = () => {
      velocity = (velocity - offset * STIFFNESS) * DAMPING;
      offset += velocity;
      if (Math.abs(offset) < REST && Math.abs(velocity) < REST) {
        offset = 0;
        velocity = 0;
        frame = 0;
        render();
        return;
      }
      render();
      frame = requestAnimationFrame(step);
    };

    // One scroll delta (deltaY > 0 = scrolling down). Returns true when it hit
    // an edge, so the caller can cancel the (no-op) native scroll.
    const hit = (deltaY: number) => {
      const intoTop = deltaY < 0 && atTop();
      const intoBottom = deltaY > 0 && atBottom();
      if (!intoTop && !intoBottom) return false;
      const now = performance.now();
      if (now - lastEdgeInput > REARM_GAP) armed = true;
      lastEdgeInput = now;
      if (armed) {
        armed = false;
        velocity = Math.sign(-deltaY) * Math.min(Math.abs(deltaY) * IMPULSE, MAX_KICK);
        if (!frame) frame = requestAnimationFrame(step);
      }
      return true;
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // pinch-zoom
      if (hit(e.deltaY)) e.preventDefault();
    };

    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === null) return;
      const y = e.touches[0].clientY;
      const delta = touchY - y; // finger moving up = scrolling down
      touchY = y;
      if (hit(delta) && e.cancelable) e.preventDefault();
    };
    const onTouchEnd = () => {
      touchY = null;
    };

    scroller.addEventListener('wheel', onWheel, { passive: false });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: false });
    scroller.addEventListener('touchend', onTouchEnd);
    scroller.addEventListener('touchcancel', onTouchEnd);
    return () => {
      cancelAnimationFrame(frame);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
      scroller.removeEventListener('touchend', onTouchEnd);
      scroller.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [ref]);
}
