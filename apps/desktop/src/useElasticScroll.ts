import { useEffect, type RefObject } from 'react';

// Rubber-band overscroll for one scroll container. Chrome on Windows doesn't
// bounce inner scrollers, so we do it ourselves: scrolling past the top or
// bottom pulls the content with growing resistance (up to MAX_PULL px), and it
// springs back once the scrolling stops (wheel/trackpad) or the finger lifts.
// Moves the scroller's first child, so it works for whatever view is shown.

const MAX_PULL = 90; // furthest the content can be pulled, in px
const RESISTANCE = 220; // how much raw scroll it takes to approach MAX_PULL
const RELEASE_AFTER = 110; // ms without wheel input = the gesture ended
const SPRING = 'transform 520ms cubic-bezier(0.22, 1.25, 0.36, 1)'; // slight overshoot

export function useElasticScroll(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;

    let raw = 0; // accumulated overscroll; + = pulled down (past top), - = pulled up (past bottom)
    let releaseTimer: number | undefined;
    let touchY: number | null = null;

    const content = () => scroller.firstElementChild as HTMLElement | null;
    const atTop = () => scroller.scrollTop <= 0;
    const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;

    const apply = () => {
      const el = content();
      if (!el) return;
      const pull = Math.sign(raw) * MAX_PULL * (1 - Math.exp(-Math.abs(raw) / RESISTANCE));
      el.style.transition = 'none';
      el.style.transform = pull ? `translateY(${pull}px)` : '';
    };

    const release = () => {
      raw = 0;
      const el = content();
      if (!el) return;
      el.style.transition = SPRING;
      el.style.transform = '';
    };

    // Returns true if this scroll delta was consumed as overscroll.
    const overscroll = (deltaY: number) => {
      const pastTop = deltaY < 0 && atTop();
      const pastBottom = deltaY > 0 && atBottom();
      // Scrolling back toward the content while pulled: unwind the pull first.
      const unwinding = raw !== 0 && Math.sign(-deltaY) !== Math.sign(raw);
      if (!pastTop && !pastBottom && !unwinding) return false;
      raw -= deltaY;
      if (unwinding && Math.sign(raw) !== Math.sign(raw + deltaY)) raw = 0;
      apply();
      return true;
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // pinch-zoom
      if (!overscroll(e.deltaY)) return;
      e.preventDefault();
      window.clearTimeout(releaseTimer);
      releaseTimer = window.setTimeout(release, RELEASE_AFTER);
    };

    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === null) return;
      const y = e.touches[0].clientY;
      const delta = touchY - y; // finger up = scroll down
      touchY = y;
      if (overscroll(delta) && e.cancelable) e.preventDefault();
    };
    const onTouchEnd = () => {
      touchY = null;
      if (raw !== 0) release();
    };

    scroller.addEventListener('wheel', onWheel, { passive: false });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: false });
    scroller.addEventListener('touchend', onTouchEnd);
    scroller.addEventListener('touchcancel', onTouchEnd);
    return () => {
      window.clearTimeout(releaseTimer);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
      scroller.removeEventListener('touchend', onTouchEnd);
      scroller.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [ref]);
}
