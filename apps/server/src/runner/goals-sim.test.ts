import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { held, reached, runsBetween, simulate, SIM_START, type RunCtx, type Scenario } from './goals-sim.js';

// The goal pace held to its goals over days (goals-sim.ts): the real arithmetic and the real
// scheduler decisions, a made-up clock, and agents that behave in every way that has gone
// wrong or could. Each case says what the count in the goal's window must do, as a share of
// the goal, once the goal has had one whole period to fill at its steady rate.
//
// What each agent does with what a run is asked for:
const between = (c: RunCtx, lo: number, hi: number) => lo + c.rng() * (hi - lo);
const obedient = (c: RunCtx) => c.asked; // exactly what it is asked, nothing when asked for nothing
const eager = (c: RunCtx) => (c.asked ? c.asked * between(c, 1, 1.5) : 0); // up to half as much again
const short = (c: RunCtx) => c.asked * between(c, 0.5, 1); // always a little short
const capped = (c: RunCtx) => Math.min(c.asked, 5); // can never make more than 5 a run
const flaky = (c: RunCtx) => (c.rng() < 0.3 ? 0 : c.asked); // three runs in ten make nothing
const minutes = (made: number) => 3 + made * 0.5;
const day = (amount: number, days = 4): Scenario => ({ goals: [{ atHour: 0, amount, period: 'day' }], days, make: obedient, minutes });
const pct = (x: number) => `${Math.round(x * 100)}%`;
const said = (h: ReturnType<typeof held>) => `low ${pct(h.low)}, average ${pct(h.mean)}, high ${pct(h.high)}`;

test('50 a day: reached in a day at a steady rate, then held flat by five runs of ten', () => {
  const r = simulate(day(50));
  const at = reached(r, 0.9)!;
  assert.ok(at > 12 && at <= 24, `90% after ${at} h: neither a sprint nor late`);
  const h = held(r, 30);
  assert.ok(h.low >= 0.96 && h.high <= 1.04, said(h));
  const runs = runsBetween(r, 30);
  assert.ok(runs.perDay >= 4.5 && runs.perDay <= 5.5, `${runs.perDay} runs a day`);
  assert.equal(runs.biggest, 10, 'no run grows past what its plan says a run makes');
  assert.deepEqual(h.levels, [1], 'its card keeps one level');
});

test('a small goal is held too: 5 a day, and 3 a week one at a time - never stuck for having reached it', () => {
  const five = simulate(day(5, 5));
  const h5 = held(five, 30);
  assert.ok(h5.low >= 0.8 && h5.mean >= 0.98 && h5.high <= 1, said(h5));
  assert.ok(runsBetween(five, 30).perDay <= 1.2);
  // 3 a week on a daily schedule. It used to make 3 on day one, run six more times that week
  // at its goal making nothing (as told), be marked stuck for it, and never work again.
  const week = simulate({ goals: [{ atHour: 0, amount: 3, period: 'week' }], days: 21, make: obedient, minutes });
  const hw = held(week, 7 * 24);
  assert.ok(hw.low >= 0.66 && hw.mean >= 0.97 && hw.high <= 1, said(hw));
  assert.ok(!week.samples.some(s => s.status === 'stuck'), 'never stuck');
  assert.equal(runsBetween(week, 0).biggest, 1, 'one at a time, 56 hours apart');
});

test('1,000 a day: a hundred runs of ten, on pace, one level - not three giant runs, not hundreds of tiny ones', () => {
  const r = simulate(day(1000, 3));
  const h = held(r, 30);
  assert.ok(h.low >= 0.97 && h.high <= 1.02, said(h));
  const runs = runsBetween(r, 30);
  assert.ok(runs.perDay >= 95 && runs.perDay <= 105, `${runs.perDay} runs a day`);
  assert.equal(runs.biggest, 10);
  assert.deepEqual(h.levels, [3]);
  assert.equal(h.flips, 0);
});

test('whatever its runs make of what they are asked, the count comes to the goal', () => {
  for (const [name, make, least, most] of [
    ['eager', eager, 0.85, 1.2],
    ['short', short, 0.8, 1.15],
    ['capped', capped, 0.9, 1.05],
    ['flaky', flaky, 0.75, 1.15],
  ] as const) {
    const r = simulate({ ...day(50, 5), make });
    const h = held(r, 30);
    assert.ok(h.mean >= 0.93 && h.mean <= 1.08, `${name}: ${said(h)}`);
    assert.ok(h.low >= least && h.high <= most, `${name}: ${said(h)}`);
    assert.ok(runsBetween(r, 30).perDay <= 12, `${name}: ${runsBetween(r, 30).perDay} runs a day`);
    assert.ok(h.flips <= 1, `${name}: its level changed ${h.flips} times a day`);
  }
  // The same at 1,000 a day, where a creeping ask once ended at runs of 4, 235 of them a day.
  const big = simulate({ ...day(1000, 3), make: short });
  assert.ok(held(big, 30).mean >= 0.97, said(held(big, 30)));
  assert.ok(runsBetween(big, 30).typical >= 6, `runs of ${runsBetween(big, 30).typical}`);
});

test('a plan that is wrong about what a run makes is corrected by what its runs show', () => {
  // The plan says 40 a run; it can make 5.
  const low = simulate({ ...day(50, 5), floor: 40, make: capped });
  assert.ok(held(low, 30).mean >= 0.97, said(held(low, 30)));
  assert.ok(runsBetween(low, 30).perDay <= 11);
  // The plan says 2 a run and it does exactly that: 500 runs a day, side by side, still on its goal.
  const tiny = simulate({ ...day(1000, 3), floor: 2 });
  assert.ok(held(tiny, 30).mean >= 0.97, said(held(tiny, 30)));
});

test('changing the goal shows at once and takes effect at once', () => {
  const up = simulate({ ...day(50, 5), goals: [{ atHour: 0, amount: 50, period: 'day' }, { atHour: 48, amount: 500, period: 'day' }] });
  const before = up.samples.find(s => s.hour >= 47.7)!;
  const after = up.samples.find(s => s.hour >= 48)!;
  assert.deepEqual([before.level, after.level], [1, 2], 'its card changes level with the goal, in the same moment');
  const first = up.runs.find(x => x.start >= SIM_START + 48 * 3_600_000 && x.asked > 0)!;
  assert.ok(first.start - (SIM_START + 48 * 3_600_000) < 60_000, 'a run toward the new goal starts within a minute');
  const at = reached(up, 0.9, 48)! - 48;
  assert.ok(at > 12 && at <= 24, `the new goal is 90% reached ${at} h later`);
  assert.ok(held(up, 78).low >= 0.96 && held(up, 78).high <= 1.04, said(held(up, 78)));
  // Lowered far below what it has made: its card calms at once, and it makes the new 50 a day
  // from that moment - not nothing for a day while the old 500 leave the window, then a day
  // of starting again from an empty one.
  const down = simulate({ ...day(500, 5), goals: [{ atHour: 0, amount: 500, period: 'day' }, { atHour: 48, amount: 50, period: 'day' }] });
  const calm = down.samples.find(s => s.hour >= 48)!;
  assert.deepEqual([calm.level, calm.status], [1, 'goal hit']);
  const made = down.runs.filter(x => x.start >= SIM_START + 48 * 3_600_000 && x.start < SIM_START + 72 * 3_600_000).reduce((n, x) => n + x.made, 0);
  assert.ok(made >= 40 && made <= 60, `${made} made in the day after it was lowered`);
  assert.ok(held(down, 72).low >= 0.9 && held(down, 72).high <= 1.1, said(held(down, 72)));
});

test('more runs at once are only room: they start a gap apart, never back to back', () => {
  // Hour-long runs at 1,000 a day need five lanes. Kept full, as they used to be, the four
  // beside the main one alone would be 96 runs a day on top of its own.
  const r = simulate({ ...day(1000, 3), minutes: () => 60 });
  const h = held(r, 30);
  assert.ok(h.low >= 0.97 && h.high <= 1.02, said(h));
  const runs = runsBetween(r, 30);
  assert.ok(runs.perDay >= 95 && runs.perDay <= 105, `${runs.perDay} runs a day`);
  assert.ok(runs.atOnce >= 4 && runs.atOnce <= 6, `${runs.atOnce} at once`);
});

test('runs that fail or make nothing cost the goal little, and one that finds its feet again recovers', () => {
  const failing = simulate({ ...day(50, 5), fails: c => c.rng() < 0.2 });
  assert.ok(held(failing, 30).mean >= 0.95, said(held(failing, 30)));
  // Nothing for two days (a tool is down), then fine: stuck and backing off meanwhile, then back.
  const down = simulate({ ...day(50, 7), make: c => (c.t < SIM_START + 48 * 3_600_000 ? 0 : c.asked) });
  assert.ok(down.samples.some(s => s.hour < 48 && s.status === 'stuck'));
  assert.ok(runsBetween(down, 12, 48).perDay <= 6, 'stuck, it runs no more than a few times a day');
  const back = reached(down, 0.9, 48)! - 48;
  assert.ok(back <= 48, `back at 90% ${back} h after its runs work again`);
  assert.ok(held(down, 120).low >= 0.95, said(held(down, 120)));
  // Stuck, and its person changes the goal: a fresh try at once, not up to a day's wait.
  const fresh = simulate({ ...day(50, 4), goals: [{ atHour: 0, amount: 50, period: 'day' }, { atHour: 40, amount: 60, period: 'day' }], make: c => (c.t < SIM_START + 38 * 3_600_000 ? 0 : c.asked) });
  const tried = fresh.runs.find(x => x.start >= SIM_START + 40 * 3_600_000)!;
  assert.ok(tried.start - (SIM_START + 40 * 3_600_000) < 60_000 && tried.made > 0);
});

test('drafts for a person: rejected ones are made up for, expired ones are not chased', () => {
  const rejected = simulate({ ...day(50, 5), approval: { share: 1, afterMin: () => 120, verdict: r => (r() < 0.2 ? 'rejected' : 'approved') } });
  const h = held(rejected, 30);
  assert.ok(h.mean >= 0.95 && h.mean <= 1.08 && h.high <= 1.2, said(h));
  // Nobody looks at any of them: every draft expires a day later and comes off the count.
  // More runs would only queue more to expire, so it keeps to five runs a day.
  const ignored = simulate({ ...day(50, 5), approval: { share: 1, afterMin: () => 24 * 60, verdict: () => 'expired' } });
  const runs = runsBetween(ignored, 30);
  assert.ok(runs.perDay <= 6, `${runs.perDay} runs a day`);
  assert.ok(!ignored.samples.some(s => s.status === 'stuck' || s.level > 1));
});

test('a frequent schedule is not added to: 50 a day on an hourly schedule is its 24 runs, each asked for 2', () => {
  const r = simulate({ ...day(50), everyHours: 1 });
  assert.ok(held(r, 30).low >= 0.95 && held(r, 30).high <= 1.02, said(held(r, 30)));
  const runs = runsBetween(r, 30);
  assert.ok(runs.perDay <= 26, `${runs.perDay} runs a day`);
  assert.equal(runs.biggest, 2);
});

test("the Conductor's numbers cannot run it away from its goal", () => {
  const every = (o: object) => Array.from({ length: 140 }, (_, i) => ({ atHour: i * 0.7, ...o }));
  // 30 a run: fewer, bigger runs, the same goal.
  const bigger = simulate({ ...day(50), conductor: every({ per_run: 30 }) });
  assert.ok(held(bigger, 30).low >= 0.95 && held(bigger, 30).high <= 1.05, said(held(bigger, 30)));
  assert.ok(runsBetween(bigger, 30).perDay <= 2.5);
  // "Every minute, five at once", over and over: the goal is still the goal.
  const wild = simulate({ ...day(50), conductor: every({ every_min: 1, parallel: 5 }) });
  assert.ok(held(wild, 30).high <= 1.2, said(held(wild, 30)));
  assert.ok(runsBetween(wild, 30).perDay <= 6);
});

test('a steady rate does not race to make up lost time: off 8 hours a night, it holds what its waking hours make', () => {
  // The rule as decided (22 Nov 2026): no faster for being behind. This case is here so the
  // cost of that is a known number, not a surprise: about four fifths of the goal.
  const r = simulate({ ...day(50, 5), off: h => h % 24 >= 10 && h % 24 < 18 });
  const h = held(r, 48);
  assert.ok(h.mean >= 0.7 && h.mean <= 0.9 && h.high <= 1, said(h));
  // Off once for six hours: short for the day after, then back at its goal by itself.
  const once = simulate({ ...day(50, 5), off: x => x >= 60 && x < 66 });
  assert.ok(held(once, 66, 88).low >= 0.75, said(held(once, 66, 88)));
  assert.ok(held(once, 92).low >= 0.96, said(held(once, 92)));
});
