import { readFile } from 'node:fs/promises';

// How full the machine's memory is, and what the agency does about it. On the
// cloud host a container's memory limit is the cgroup's (memory.max). Its
// memory.current counts the file cache too, which the kernel gives back the
// moment anything needs it - it sat near 98% with nothing wrong - so what
// counts is memory.current less the inactive file cache (what "in use" means
// for docker stats). Where there is no cgroup limit (a person's own computer),
// nothing is read and nothing is held back.
//
//   CLEAN_AT  the host's 5-minute self-check closes the idle browsers (host.ts)
//   BRAKE_AT  the scheduler starts no new run (scheduler.ts); runs going carry on

const CGROUP = '/sys/fs/cgroup';
export const CLEAN_AT = 0.85;
export const BRAKE_AT = 0.9;

export const inactiveFile = (stat: string) => Number(/^inactive_file (\d+)/m.exec(stat)?.[1] ?? 0);

type Read = (file: string) => Promise<string>;
const readCgroup: Read = file => readFile(`${CGROUP}/${file}`, 'utf8');

// Memory in use as a fraction of the limit, or null with no limit to measure against.
export async function memoryFraction(read: Read = readCgroup): Promise<number | null> {
  try {
    const current = (await read('memory.current')).trim();
    const limit = (await read('memory.max')).trim();
    if (!/^\d+$/.test(current) || !/^\d+$/.test(limit) || Number(limit) <= 0) return null;
    const cache = inactiveFile(await read('memory.stat').catch(() => ''));
    return Math.max(0, Number(current) - cache) / Number(limit);
  } catch {
    return null;
  }
}

const pct = (f: number) => `${Math.round(f * 100)}%`;

// The brake: on at BRAKE_AT or more, off below it. Said in the log when it turns on and when it turns off.
export function makeBrake(log: (line: string) => void = line => console.error(line)) {
  let on = false;
  return {
    get on() {
      return on;
    },
    update(fraction: number | null): boolean {
      const next = fraction != null && fraction >= BRAKE_AT;
      if (next !== on) {
        on = next;
        log(
          next
            ? `[host] Memory is at ${pct(fraction!)}: no new run starts until it is below ${pct(BRAKE_AT)} (runs already going carry on).`
            : fraction == null
              ? '[host] Memory can no longer be read: new runs start again.'
              : `[host] Memory is down to ${pct(fraction)}: new runs start again.`,
        );
      }
      return on;
    },
  };
}
export const memoryBrake = makeBrake();

// Held back only while another run is going: with none, waiting frees nothing,
// and the one that starts is what gets the agency moving again.
export const holdsBack = (braked: boolean, runsGoing: number) => braked && runsGoing > 0;
