import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { availableParallelism, freemem, totalmem } from 'node:os';
import { browserCensus, cleanUpBrowsers } from './browser.js';
import { claudeCrashes } from './harness.js';
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
    const what = /chrome|chromium|msedge/i.test(args)
      ? /--user-data-dir=\S*playwright/.test(args)
        ? 'throwaway browser'
        : /--user-data-dir=\S*person-\d/.test(args)
          ? "person's sign-in window"
          : 'agents’ browser'
      : /^claude\b|claude-code|claude\.exe/.test(args)
        ? 'Claude Code'
        : /^(\/\S*\/)?node\b/.test(args)
          ? 'Node (the agency, plugins, sidecars)'
          : /esbuild/.test(args)
            ? 'esbuild'
            : /Xvfb|ffmpeg|xdotool/.test(args)
              ? 'virtual screens'
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

  const b = browsers;
  out.push(
    `## Browsers\n${[
      ...b.agents.map(a => `- Agents' browser, profile ${a.profile} (pid ${a.pid}): ${a.runs} run${a.runs === 1 ? '' : 's'} using it, ${a.pages} pages open${a.stray ? ` (${a.stray} no run is using - host.clean_up closes them)` : ''}`),
      ...b.personWindows.map(p => `- A person's sign-in window, profile ${p.profile} (pid ${p.pid})`),
      ...(b.throwaway ? [`- Throwaway browsers in runs: ${b.throwaway}`] : []),
      ...(b.leftovers.length ? [`- Leftovers nobody is using: ${b.leftovers.length} (pids ${b.leftovers.join(', ')}) - host.clean_up ends them`] : []),
    ].join('\n') || '- None open'}`,
  );
  const strays = b.agents.reduce((n, a) => n + a.stray, 0);
  if (strays >= 5) warn.push(`${strays} pages are open in the agents' browser that no run is using.`);
  if (b.leftovers.length) warn.push(`${b.leftovers.length} leftover browser${b.leftovers.length === 1 ? '' : 's'} nobody is using.`);

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
      "The machine the agency runs on: its process/thread and memory limits and how close they are, what's using them (browsers, Claude Code, plugins), the browsers open and any leftovers, Claude Code crashes and their cause, and errors the agency logged. Look here first when runs fail with \"exit null\", \"EAGAIN\", \"Failed to start ... thread\", \"Target crashed\" or \"The server stopped\".",
    schema: obj({}),
    impl: () => hostHealth(),
  },
  {
    id: 'host.clean_up',
    tier: 'T1',
    description:
      "Free the machine: closes pages in the agents' browser no run is using (a site's popups and tabs from runs that ended), ends leftover browsers nobody is using, and closes agents' browsers no run is using right now (sign-ins are kept; each starts again fresh when a run needs it). Never touches a run in progress or a person's window. Says what it did, with the numbers before and after.",
    schema: obj({}),
    impl: async () => {
      const before = await limits();
      const { ended, closed, pages } = await cleanUpBrowsers();
      const after = await limits();
      const t = (x: Limits) => (x.tasks ? `${x.tasks.now} processes/threads, ` : '') + `${x.memory.nowMb} MB`;
      if (!ended.length && !closed.length && !pages) return `Nothing to clear: no leftover browsers, and every agents' browser is in use by a run. Now ${t(after)}.`;
      return `Closed ${pages} page${pages === 1 ? '' : 's'} no run was using; ended ${ended.length} leftover browser${ended.length === 1 ? '' : 's'}; closed the agents' browser for profile${closed.length === 1 ? '' : 's'} ${closed.join(', ') || '-'}. Before: ${t(before)}. After: ${t(after)}.`;
    },
  },
];

registerTools(TOOLS);

// It looks after itself too: close to the process/thread limit, it clears what
// nobody is using without waiting for the Doctor's next look.
const SELF_CHECK_MS = 5 * 60_000;
if (process.platform === 'linux')
  setInterval(async () => {
    const t = (await limits()).tasks;
    if (!t || !Number.isFinite(t.max) || t.now < 0.9 * t.max) return;
    const { ended, closed } = await cleanUpBrowsers();
    console.error(`[host] At ${t.now} of ${t.max} processes/threads: ended ${ended.length} leftover browsers, closed ${closed.length} idle agents' browsers.`);
  }, SELF_CHECK_MS).unref();
