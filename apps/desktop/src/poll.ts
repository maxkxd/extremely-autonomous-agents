// Every repeating check the app makes on the server goes through here, so it only
// polls at full speed while someone is looking. Each check is a round trip through
// the relay for a cloud org, and egress is billed, so a minimised app polling every
// few seconds all day cost more than the org's own work did.
//
// - Focused: every `ms`, as before.
// - Not focused (behind another window, minimised, in the tray): at most once a minute.
//   The desktop window keeps backgroundThrottling off (apps/electron/main.cjs), so the
//   page never reports itself hidden there; focus is the signal that still works.
// - Hidden browser tab: not at all.
// Coming back (focus, or the tab shown again) checks straight away if one is due.

const IDLE_MS = 60_000;

const looking = () => document.visibilityState === 'visible' && document.hasFocus();

export function every(fn: () => unknown, ms: number): () => void {
  let last = Date.now();
  let timer: number | undefined;
  const run = () => {
    last = Date.now();
    void fn();
  };
  const schedule = () => {
    window.clearTimeout(timer);
    if (document.visibilityState === 'hidden') return;
    const gap = looking() ? ms : Math.max(ms, IDLE_MS);
    timer = window.setTimeout(() => {
      run();
      schedule();
    }, Math.max(0, last + gap - Date.now()));
  };
  const back = () => {
    if (looking() && Date.now() - last >= ms) run();
    schedule();
  };
  window.addEventListener('focus', back);
  window.addEventListener('blur', schedule);
  document.addEventListener('visibilitychange', back);
  schedule();
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener('focus', back);
    window.removeEventListener('blur', schedule);
    document.removeEventListener('visibilitychange', back);
  };
}
