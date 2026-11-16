import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { browserCensus, cleanUpBrowsers } from './browser.js';
import { startDiskSweep } from './disk-sweep.js';
import { claudeCrashes } from './harness.js';
import { CLEAN_AT, memoryFraction } from './pressure.js';
import { registerTools, type ToolDef } from './tools.js';

// The machine the agency runs on, as the Agency Doctor and the Agency Engineer
// see it. Runs failing with "exit null", "spawn EAGAIN", "Failed to start ...
// thread" or "The server stopped" aren't the agents' doing: the machine ran out
// of something. Without this they could only guess (the Doctor once called it
// cleared minutes before it came back); with it they read the numbers, clear
// what can be cleared, and report the rest.

// --- Errors the server logged --------------------------------------------------------

const ERRORS_KEPT = 60;
const recentErrors: { at: number; text: string; times: number }[] = [];
const logError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  logError(...args);
  const text = args.map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').replace(/\s+/g, ' ').slice(0, 300);
  const last = recentErrors.at(-1);
  if (last && last.text === text) {
    last.times++;
    last.at = Date.now();
  } else recentErrors.push({ at: Date.now(), text, times: 1 });
  if (recentErrors.length > ERRORS_KEPT) recentErrors.shift();
};

// --- The machine's limits ------------------------------------------------------------

const CGROUP = '/sys/fs/cgroup';
const num = async (file: string) => {
  const v = (await readFile(`${CGROUP}/${file}`, 'utf8').catch(() => '')).trim();
  return v === '' ? null : v === 'max' ? Infinity : Number(v);
};
const event = async (file: string, name: string) => Number(new RegExp(`^${name} (\\d+)`, 'm').exec(await readFile(`${CGROUP}/${file}`, 'utf8').catch(() => ''))?.[1] ?? 0);

export type Limits = {
  tasks?: { now: number; max: number; peak: number | null; refused: number };
  memory: { nowMb: number; maxMb: number | null; peakMb: number | null; oomKills: number };
  cpus: number;
};
export async function limits(): Promise<Limits> {
  const [pidsNow, pidsMax, pidsPeak, memNow, memMax, memPeak] = await Promise.all(
    ['pids.current', 'pids.max', 'pids.peak', 'memory.current', 'memory.max', 'memory.peak'].map(num),
  );
  const mb = (b: number | null) => (b == null || !Number.isFinite(b) ? null : Math.round(b / 1_048_576));
  return {
    ...(pidsNow != null ? { tasks: { now: pidsNow, max: pidsMax ?? Infinity, peak: pidsPeak, refused: await event('pids.events', 'max') } } : {}),
    memory:
      memNow != null
        ? { nowMb: mb(memNow)!, maxMb: mb(memMax), peakMb: mb(memPeak), oomKills: await event('memory.events', 'oom_kill') }
        : { nowMb: mb(totalmem() - freemem())!, maxMb: mb(totalmem()), peakMb: null, oomKills: 0 },
    cpus: availableParallelism(),
  };
}

// Processes and threads by what they are (Linux, where there's a ps that counts threads).
export type Group = { what: string; processes: number; threads: number; mb: number };
export function groupProcesses(ps: string): Group[] {
  const groups = new Map<string, Group>();
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [threads, kb, args] = [Number(m[1]), Number(m[2]), m[3]];
    // A browser here is the person's own (agents work in it through the extension) or a plugin's.
    const what = /chrome|chromium|msedge/i.test(args)
      ? 'browsers (Chrome or Edge)'
      : /^claude\b|claude-code|claude\.exe/.test(args)
        ? 'Claude Code'
        : /^(\/\S*\/)?node\b/.test(args)
          ? 'Node (the agency, plugins, sidecars)'
          : /esbuild/.test(args)
            ? 'esbuild'
            : /ffmpeg/.test(args)
              ? 'ffmpeg'
              : 'other';
    const g = groups.get(what) ?? { what, processes: 0, threads: 0, mb: 0 };
    g.processes++;
    g.threads += threads;
    g.mb += kb / 1024;
    groups.set(what, g);
  }
  return [...groups.values()].map(g => ({ ...g, mb: Math.round(g.mb) })).sort((a, b) => b.threads - a.threads);
}
const psThreads = () =>
  process.platform === 'linux'
    ? new Promise<string>(r => execFile('ps', ['-eo', 'nlwp=,rss=,args='], { maxBuffer: 16 << 20 }, (err, out) => r(err ? '' : out)))
    : Promise.resolve('');

// --- The report ----------------------------------------------------------------------

const HOUR = 3_600_000;
const pct = (a: number, b: number) => (Number.isFinite(b) && b > 0 ? Math.round((100 * a) / b) : null);

export async function hostHealth(now = Date.now()): Promise<string> {
  const [l, groups, browsers] = await Promise.all([limits(), psThreads().then(groupProcesses), browserCensus()]);
  const out: string[] = [];
  const warn: string[] = [];

  const lines: string[] = [`CPUs: ${l.cpus}`];
  if (l.tasks) {
    const p = pct(l.tasks.now, l.tasks.max);
    lines.push(`Processes and threads: ${l.tasks.now} of ${Number.isFinite(l.tasks.max) ? l.tasks.max : 'no limit'}${p != null ? ` (${p}%)` : ''}${l.tasks.peak ? `, highest ${l.tasks.peak}` : ''}; refused at the limit ${l.tasks.refused} times since the machine started`);
    if (p != null && p >= 85) warn.push(`Processes and threads are at ${p}% of the limit: anything new (Claude Code, a browser, a plugin) can fail to start. host.clean_up, then see what's using them below.`);
    if (l.tasks.refused) warn.push(`The machine has refused to start a thread or process ${l.tasks.refused} times: "exit null", "EAGAIN" and "Failed to start ... thread" errors come from this, not from the agents.`);
  }
  const m = l.memory;
  const mp = m.maxMb ? pct(m.nowMb, m.maxMb) : null;
  lines.push(`Memory: ${m.nowMb} MB${m.maxMb ? ` of ${m.maxMb} MB (${mp}%)` : ''}${m.peakMb ? `, highest ${m.peakMb} MB` : ''}${m.oomKills ? `; ${m.oomKills} programs ended for lack of memory` : ''}`);
  if (mp != null && mp >= 85) warn.push(`Memory is at ${mp}%.`);
  if (m.oomKills) warn.push(`${m.oomKills} programs were ended for lack of memory.`);
  out.push(`## The machine\n${lines.map(x => `- ${x}`).join('\n')}`);

  if (groups.length)
    out.push(`## What's using it\n${groups.map(g => `- ${g.what}: ${g.processes} processes, ${g.threads} threads, ${g.mb} MB`).join('\n')}`);

  // The person's own browsers, paired through the extension: the agents' tabs in them.
  const b = browsers.browsers;
  const browserLine = (x: (typeof b)[number]) =>
    x.online
      ? `- Browser ${x.n} (${x.name}): online, ${x.runs} run${x.runs === 1 ? '' : 's'} using it, ${x.tabs} agent tab${x.tabs === 1 ? '' : 's'} open${x.kept ? `, ${x.kept} kept for the person` : ''}${x.stray ? ` (${x.stray} no run is using - host.clean_up closes them)` : ''}`
      : `- Browser ${x.n} (${x.name}): offline${x.kept ? `, ${x.kept} page${x.kept === 1 ? '' : 's'} kept for the person in it` : ''}`;
  out.push(`## Browsers (the person's, through the extension)\n${b.map(browserLine).join('\n') || "- None connected: agents can't browse until the person connects one (Settings > Connectors > Browser)"}`);
  const strays = b.reduce((n, x) => n + x.stray, 0);
  if (strays >= 5) warn.push(`${strays} agent tabs are open in the person's browser that no run is using.`);
  if (b.length && !b.some(x => x.online)) warn.push("No browser is online: agents can't browse until the person opens one with the EXTREMELY extension.");

  const crashes = claudeCrashes.filter(c => c.at >= now - 24 * HOUR);
  if (crashes.length) {
    const byWhy = new Map<string, number>();
    for (const c of crashes) byWhy.set(c.why, (byWhy.get(c.why) ?? 0) + 1);
    const lastHour = crashes.filter(c => c.at >= now - HOUR).length;
    out.push(
      `## Claude Code crashes (runs carry on from where they were, up to 3 times)\n- ${crashes.length} in the last day, ${lastHour} in the last hour\n${[...byWhy].map(([why, n]) => `- ${n}x ${why}`).join('\n')}`,
    );
    if (lastHour >= 3) warn.push(`Claude Code crashed ${lastHour} times in the last hour.`);
  }

  const errors = recentErrors.filter(e => e.at >= now - 6 * HOUR);
  if (errors.length)
    out.push(`## Errors the agency logged (last 6 h, newest last)\n${errors.slice(-25).map(e => `- ${new Date(e.at).toISOString().slice(11, 16)}${e.times > 1 ? ` (${e.times}x)` : ''}: ${e.text}`).join('\n')}`);

  return [warn.length ? `# Needs attention\n${warn.map(w => `- ${w}`).join('\n')}` : '# Healthy: nothing near a limit', ...out].join('\n\n');
}

// --- Tools ---------------------------------------------------------------------------

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

export const HOST_TOOLS = { 'host.health': 'T0', 'host.clean_up': 'T1' } as const;

const TOOLS: ToolDef[] = [
  {
    id: 'host.health',
    tier: 'T0',
    description:
      "The machine the agency runs on: its process/thread and memory limits and how close they are, what's using them (Claude Code, plugins), the person's browsers agents work in (online or not, agent tabs open), Claude Code crashes and their cause, and errors the agency logged. Look here first when runs fail with \"exit null\", \"EAGAIN\", \"Failed to start ... thread\", \"Target crashed\" or \"The server stopped\".",
    schema: obj({}),
    impl: () => hostHealth(),
  },
  {
    id: 'host.clean_up',
    tier: 'T1',
    description:
      "Free memory: closes agent tabs no run is using in the person's browsers (a site's popups and tabs from runs that ended). Never touches a run in progress, a page kept for the person, or the person's own tabs. Says what it did, with the numbers before and after.",
    schema: obj({}),
    impl: async () => {
      const before = await limits();
      const { pages } = await cleanUpBrowsers();
      const after = await limits();
      const t = (x: Limits) => (x.tasks ? `${x.tasks.now} processes/threads, ` : '') + `${x.memory.nowMb} MB`;
      if (!pages) return `Nothing to clear: every agent tab open is in use by a run or kept for the person. Now ${t(after)}.`;
      return `Closed ${pages} agent tab${pages === 1 ? '' : 's'} no run was using. Before: ${t(before)}. After: ${t(after)}.`;
    },
  },
];

registerTools(TOOLS);

// The caches and old agency copies the disk fills with are cleared at start and
// once a day (disk-sweep.ts).
startDiskSweep();

// It looks after itself too: close to the process/thread limit, or with memory
// at CLEAN_AT or more (pressure.ts), it clears what nobody is using without
// waiting for the Doctor's next look. (At BRAKE_AT the scheduler also starts no
// new run until memory drops.)
const SELF_CHECK_MS = 5 * 60_000;
if (process.platform === 'linux')
  setInterval(async () => {
    const t = (await limits()).tasks;
    const crowded = !!t && Number.isFinite(t.max) && t.now >= 0.9 * t.max;
    const memory = await memoryFraction();
    const full = memory != null && memory >= CLEAN_AT;
    if (!crowded && !full) return;
    const { pages } = await cleanUpBrowsers();
    const why = [crowded ? `At ${t!.now} of ${t!.max} processes/threads` : '', full ? `Memory at ${Math.round(memory! * 100)}%` : ''].filter(Boolean).join(', ');
    console.error(`[host] ${why}: closed ${pages} agent tab${pages === 1 ? '' : 's'} no run was using.`);
  }, SELF_CHECK_MS).unref();
