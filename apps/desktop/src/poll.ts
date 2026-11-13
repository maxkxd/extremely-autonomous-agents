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
//
// The Agents' browser page is a loop of its own (a list and a frame pulled again as
// soon as the last one lands), so it waits here instead: untilLooking().

const IDLE_MS = 60_000;

const looking = () => document.visibilityState === 'visible' && document.hasFocus();

// Resolves at once (false) if someone is looking; otherwise when they are (true: it had
// to wait), or when `signal` aborts, so a page that went away leaves no listener behind.
export function untilLooking(signal?: AbortSignal): Promise<boolean> {
  if (looking()) return Promise.resolve(false);
  return new Promise<boolean>(resolve => {
    const done = () => {
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      signal?.removeEventListener('abort', done);
      resolve(true);
    };
    const check = () => looking() && done();
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    signal?.addEventListener('abort', done);
  });
}

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
