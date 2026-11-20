import { getSetting, setSetting } from './db.js';

// The agency's days run on its host's clock: the person whose computer (or
// account) runs it. "Today" for spend caps and run limits, the month in Usage,
// and the date agents are told all start at the host's midnight - not the
// server's, which may be a machine elsewhere once it's hosted. Set from the
// host's app (its time zone), else this computer's own.

const valid = (zone: string) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

export const hostZone = (): string => {
  const z = getSetting<string | null>('host_timezone', null);
  return z && valid(z) ? z : Intl.DateTimeFormat().resolvedOptions().timeZone;
};
export const hostZoneSet = () => !!getSetting<string | null>('host_timezone', null);
export function setHostZone(zone: string) {
  if (!valid(zone)) throw new Error(`"${zone}" isn't a time zone.`);
  setSetting('host_timezone', zone);
}

// The wall clock in a zone at an instant.
function wall(t: number, zone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(t)
      .map(x => [x.type, Number(x.value)]),
  ) as Record<string, number>;
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

// The instant a wall-clock time happens in a zone (offsets checked twice, for DST days).
// Fields past their range roll over (day 32, month 13, hour 24), as Date.UTC has them.
function instant(y: number, m: number, d: number, zone: string, h = 0): number {
  const target = Date.UTC(y, m - 1, d, h);
  let t = target;
  for (let i = 0; i < 2; i++) {
    const w = wall(t, zone);
    t += target - Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s);
  }
  return t;
}

export function startOfDay(now: number, zone = hostZone()): number {
  const w = wall(now, zone);
  return instant(w.y, w.m, w.d, zone);
}

export function startOfMonth(now: number, zone = hostZone()): number {
  const w = wall(now, zone);
  return instant(w.y, w.m, 1, zone);
}

// A goal's period (goals.ts): the stretch its number is for. Each starts on the host's
// clock: the top of the hour, midnight, Monday, the 1st, 1 January.
export const PERIODS = ['hour', 'day', 'week', 'month', 'year'] as const;
export type Period = (typeof PERIODS)[number];

// How many days back Monday is from a wall-clock date.
const sinceMonday = (y: number, m: number, d: number) => (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;

export function startOfHour(now: number, zone = hostZone()): number {
  const w = wall(now, zone);
  return instant(w.y, w.m, w.d, zone, w.h);
}

export function startOfWeek(now: number, zone = hostZone()): number {
  const w = wall(now, zone);
  return instant(w.y, w.m, w.d - sinceMonday(w.y, w.m, w.d), zone);
}

export function startOfYear(now: number, zone = hostZone()): number {
  const w = wall(now, zone);
  return instant(w.y, 1, 1, zone);
}

export function periodStart(period: Period, now: number, zone = hostZone()): number {
  if (period === 'hour') return startOfHour(now, zone);
  if (period === 'week') return startOfWeek(now, zone);
  if (period === 'month') return startOfMonth(now, zone);
  if (period === 'year') return startOfYear(now, zone);
  return startOfDay(now, zone);
}

// When the period now is in ends: the start of the next one.
export function periodEnd(period: Period, now: number, zone = hostZone()): number {
  const w = wall(now, zone);
  if (period === 'hour') return instant(w.y, w.m, w.d, zone, w.h + 1);
  if (period === 'week') return instant(w.y, w.m, w.d - sinceMonday(w.y, w.m, w.d) + 7, zone);
  if (period === 'month') return instant(w.y, w.m + 1, 1, zone);
  if (period === 'year') return instant(w.y + 1, 1, 1, zone);
  return instant(w.y, w.m, w.d + 1, zone);
}
