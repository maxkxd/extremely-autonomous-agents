// The run watchdog: a per-tool-call timeout, idle detection and a run ceiling,
// so one hung await can never hold an agent forever.
//
// Why: a run has no limit on its length or turns by design - it ends when its
// work is done. But nothing noticed a run that had stopped doing anything: a
// model call that never answered, a tool whose promise never settled, a plan's
// CLI that died without saying so. The agent stayed "running" and every booked
// run behind it waited, with no error anywhere. Modelled on the World Asset
// Register agency's watchdog (agency-runner/src/run-watchdog.ts), three layers,
// each catching what the one above lets through:
//
//   1. Per-tool-call timeout (callTimeoutMs, used by tools.ts execute()): a tool
//      call is raced against its budget. On timeout the model gets an error
//      result ("timed out; the run continues"), it counts as the tool failing -
//      so a tool that keeps hanging reaches the Agency Engineer like any broken
//      tool - and the run goes on. One slow tool is not a dead run.
//   2. Idle detection (IDLE_MS): nothing has moved - no tool call started or
//      ended, no model turn finished - for 20 minutes, and no tool call is in
//      flight (that one has its own deadline from layer 1). The run is aborted.
//   3. Run ceiling (CEILING_MS): a run busy for 4 hours without finishing is
//      cut. Runs here are long on purpose (a launch film run took 4h20m), so the
//      ceiling is a backstop for a loop, not a target.
//
// What happens next: the run ends 'failed' with a sentence saying what it was
// waiting on, and - because the agency must carry on without anyone stepping
// in - the agent gets a run booked to pick up where it stopped. If the aborted
// run doesn't let go (a hang outside anything the abort reaches), the
// scheduler frees the agent itself after GRACE_MS (scheduler.ts). Rows left
// 'running' with nothing behind them are swept the same way.

export const TOOL_TIMEOUT_MS = 10 * 60_000;
export const IDLE_MS = 20 * 60_000;
export const CEILING_MS = 4 * 60 * 60_000;
export const GRACE_MS = 10 * 60_000;

// Tools that legitimately run longer than the default, by id or by prefix.
const LONG_TOOLS: [RegExp, number][] = [
  [/^signed_in_browser\.(wait|show_person|start_sign_up)$/, 20 * 60_000],
  [/^video\.render$/, 60 * 60_000],
  [/^(veo|media|clips|web-video)\./, 30 * 60_000],
  [/^engineer\.(install_program|publish_integration|test_integration)$/, 30 * 60_000],
];
export function callTimeoutMs(tool: string): number {
  const hit = LONG_TOOLS.find(([re]) => re.test(tool));
  return hit ? Math.max(TOOL_TIMEOUT_MS, hit[1]) : TOOL_TIMEOUT_MS;
}

export function toolTimedOut(tool: string, ms: number): string {
  return `${tool} timed out after ${Math.round(ms / 60_000)} min and was abandoned - it did NOT finish, so don't assume it took effect. The run continues. Retry it once if it matters; again and again is pointless, the service behind it is most likely down.`;
}

// Races a tool call against its budget. The original promise is left to settle
// on its own; its result is dropped.
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<{ ok: false }>(res => {
    timer = setTimeout(() => res({ ok: false }), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([p.then(value => ({ ok: true as const, value })), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- Per-run activity -----------------------------------------------------------

export type Trip = { kind: 'idle' | 'ceiling'; at: number; waitingOn: string; waitedMs: number; limitMs: number };
type Watch = { runId: string; agentId: string; startedAt: number; last: number; lastWhat: string; inFlight: Map<number, { tool: string; since: number }>; nextCall: number; trip?: Trip; signal?: AbortSignal };
const watches = new Map<string, Watch>();

export function watchRun(runId: string, agentId: string, startedAt: number, signal?: AbortSignal) {
  watches.set(runId, { runId, agentId, startedAt, last: startedAt, lastWhat: 'the model', inFlight: new Map(), nextCall: 0, signal });
}
export function endWatch(runId: string): Trip | undefined {
  const w = watches.get(runId);
  watches.delete(runId);
  return w?.trip;
}
export function touch(runId: string, what: string, now: number) {
  const w = watches.get(runId);
  if (!w) return;
  w.last = now;
  w.lastWhat = what;
}
export function callStarted(runId: string, tool: string, now: number): number {
  const w = watches.get(runId);
  if (!w) return -1;
  const n = w.nextCall++;
  w.inFlight.set(n, { tool, since: now });
  w.last = now;
  w.lastWhat = tool;
  return n;
}
export function callEnded(runId: string, n: number, now: number) {
  const w = watches.get(runId);
  if (!w) return;
  w.inFlight.delete(n);
  w.last = now;
  w.lastWhat = 'the model';
}
export const tripOf = (runId: string) => watches.get(runId)?.trip;

// The trip, in a sentence a person reads in the run's error.
export function describeTrip(t: Trip): string {
  const waited = `${Math.round(t.waitedMs / 60_000)} min`;
  return t.kind === 'ceiling'
    ? `Stopped by the watchdog: still busy after the ${Math.round(t.limitMs / 3_600_000)}-hour run limit, last waiting on ${t.waitingOn} (${waited}).`
    : `Stopped by the watchdog: nothing happened for ${Math.round(t.limitMs / 60_000)} min while waiting on ${t.waitingOn} - it was hung (${waited} on that).`;
}

// Which runs have tripped as of now: each is marked, and the caller aborts it.
// Pure arithmetic on the clock it's given, so it can be tested with made-up times.
export function sweep(now: number, limits = { idle: IDLE_MS, ceiling: CEILING_MS }): Watch[] {
  const tripped: Watch[] = [];
  for (const w of watches.values()) {
    if (w.trip) continue;
    const oldestCall = [...w.inFlight.values()].sort((a, b) => a.since - b.since)[0];
    if (now - w.startedAt > limits.ceiling) {
      w.trip = { kind: 'ceiling', at: now, waitingOn: oldestCall?.tool ?? w.lastWhat, waitedMs: now - (oldestCall?.since ?? w.last), limitMs: limits.ceiling };
    } else if (!oldestCall && limits.idle > 0 && now - w.last > limits.idle) {
      w.trip = { kind: 'idle', at: now, waitingOn: w.lastWhat, waitedMs: now - w.last, limitMs: limits.idle };
    }
    if (w.trip) tripped.push(w);
  }
  return tripped;
}
export const watched = () => [...watches.values()];
