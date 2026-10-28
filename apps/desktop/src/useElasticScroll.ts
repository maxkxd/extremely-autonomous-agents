import { useEffect, type RefObject } from 'react';

// Rubber-band overscroll for one scroll container. Chrome on Windows doesn't
// bounce inner scrollers, so we do it ourselves, as a spring:
//   - scrolling past the top/bottom pushes the content, with resistance that
//     grows as it nears MAX_PULL
//   - a spring pulls it back toward 0 on EVERY frame, starting immediately. So
//     a trackpad's fading momentum events can't hold it up - they just get
//     out-pulled - and it settles fast once the push stops
//   - within one scroll gesture, each event pushes less than the last
//     (FATIGUE), so the real swipe pulls and the trailing momentum barely does
//   - the pull is the actual on-screen offset, never a hidden running total, so
//     scrolling back the other way only has to undo what you can see
// A held finger (touch) is the exception: the spring waits until it lifts.
// Moves the scroller's first child, so it works for whatever view is shown.

const MAX_PULL = 90; // px; the pull can approach but never pass this
const INPUT_GAIN = 0.9; // share of the scroll delta that becomes pull, before resistance
const FATIGUE = 6; // events into a gesture before input is down to ~37% strength
const GESTURE_GAP = 160; // ms without overscroll input = next event starts a new gesture
const STIFFNESS = 0.085; // spring strength back toward 0
const DAMPING = 0.74; // velocity kept per frame; < ~0.8 gives a small, quick overshoot
const REST = 0.25; // px; below this (and slow) we snap to 0 and stop animating

export function useElasticScroll(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const scroller = ref.current;
    if (!scroller) return;

    let pull = 0; // + = content pulled down (past the top), - = pulled up (past the bottom)
    let velocity = 0;
    let frame = 0;
    let touchY: number | null = null;
    let gestureEvents = 0;
    let lastInput = 0;

    const content = () => scroller.firstElementChild as HTMLElement | null;
    const atTop = () => scroller.scrollTop <= 0;
    const atBottom = () => scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;

    const render = () => {
      const el = content();
      if (!el) return;
      el.style.transition = 'none';
      el.style.transform = pull ? `translateY(${pull.toFixed(2)}px)` : '';
    };

    const step = () => {
      frame = 0;
      if (touchY === null) {
        velocity = (velocity - pull * STIFFNESS) * DAMPING;
        pull += velocity;
      }
      if (touchY === null && Math.abs(pull) < REST && Math.abs(velocity) < REST) {
        pull = 0;
        velocity = 0;
        render();
        return;
      }
      render();
      frame = requestAnimationFrame(step);
    };
    const run = () => {
      if (!frame) frame = requestAnimationFrame(step);
    };

    // Feed one scroll delta (deltaY > 0 = scrolling down). Returns true if it
    // was used as overscroll / unwinding, so the caller should cancel the scroll.
    const feed = (deltaY: number) => {
      const pastTop = deltaY < 0 && atTop();
      const pastBottom = deltaY > 0 && atBottom();
      const unwinding = pull !== 0 && Math.sign(-deltaY) !== Math.sign(pull);
      if (unwinding) {
        // Scrolling back toward the content: give back visible pull 1:1.
        const next = pull - deltaY;
        pull = Math.sign(next) === Math.sign(pull) ? next : 0;
        velocity = 0;
      } else if (pastTop || pastBottom) {
        const now = performance.now();
        if (now - lastInput > GESTURE_GAP) gestureEvents = 0;
        lastInput = now;
        const room = 1 - Math.min(Math.abs(pull) / MAX_PULL, 1);
        const fade = Math.exp(-gestureEvents++ / FATIGUE);
        pull -= deltaY * INPUT_GAIN * room * room * fade;
        pull = Math.max(-MAX_PULL, Math.min(MAX_PULL, pull));
      } else {
        return false;
      }
      render();
      run();
      return true;
    };

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // pinch-zoom
      if (feed(e.deltaY)) e.preventDefault();
    };

    const onTouchStart = (e: TouchEvent) => {
      touchY = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (touchY === null) return;
      const y = e.touches[0].clientY;
      const delta = touchY - y; // finger moving up = scrolling down
      touchY = y;
      if (feed(delta) && e.cancelable) e.preventDefault();
    };
    const onTouchEnd = () => {
      touchY = null;
      run();
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
