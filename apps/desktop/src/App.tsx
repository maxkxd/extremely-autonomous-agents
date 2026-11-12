import { HelpButton } from './help/HelpButton';
import { useHasModels } from './NoModels';
import { helpTopicFor } from './help/topics';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronRight, Plus } from 'lucide-react';
import { Sidebar, viewLabel, type View } from './Sidebar';
import { Dashboard } from './Dashboard';
import { RangePicker } from './RangePicker';
import { Crayon } from './ModelConnectors';
import { AgencyControls } from './AgencyStop';
import { useElasticScroll } from './useElasticScroll';
import { LiveDM } from './LiveDM';
import { NewAgent } from './NewAgent';
import { AgentReveal } from './AgentReveal';
import { Settings, type SettingsSection } from './Settings';
import { NEW_SESSION, agentStatuses, getAgency, getLiveAgents, getIntegrations, getHostZone, setAgency, setHostPerson, setHostZone, answerRequest, decideApproval, deleteAgentFiles, getLiveApprovals, getLiveRequests, outputSlices, saveAgent, type AgencyState, type BuilderSession, type Built } from './builder';
import { subscribeToDecisions } from './live';
import { carryAssistantMessages, currentOrg, isAdmin, myAccountId, offline, onOffline, scoped, signOut, state } from './account';
import { OFFLINE_WHY } from './offline';
import { clockTime } from './clock';
import { SignIn, type SignInAsk } from './SignIn';
import { Elsewhere } from './Elsewhere';
import { Onboarding, onboarded } from './Onboarding';
import {
  ACCOUNT,
  AGENTS,
  addAgent,
  forgetAgent,
  removeAgent,
  updateAgent,
  type Approval,
  type Decisions,
  type ResourceRequest,
  type TimeRange,
} from './data';
import { Requests, requestItems, visibleRequests, type RequestResolution } from './Requests';
import { AgentsBrowser } from './AgentsBrowser';
import {
  Approvals,
  ApprovalsToolbar,
  DecisionTally,
  visibleApprovals,
  type ApprovalFailure,
  type ApprovalScope,
  type Resolution,
} from './Approvals';

const MIN_WIDTH = 240;
const MAX_WIDTH = 480;
const DEFAULT_WIDTH = 300;
// Dragging narrower than this snaps the sidebar shut instead of stopping at MIN_WIDTH.
const SNAP_SHUT_BELOW = 160;
const WIDTH_KEY = 'eaa.sidebarWidth';
const SHUT_KEY = 'eaa.sidebarShut';
const BUILDER_KEY = scoped('eaa.builderSession');

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable - sidebar size just won't persist.
  }
}

const clamp = (w: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w));

// Below this window width the sidebar is just its icons (at 800px it took a third of the window).
// Above it the sidebar grows with the window - 200px at the switch, ~300px by 1250px, more on
// big screens - up to the width you've dragged it to, so there's no big jump at the switch
// (it went 68px -> 300px from 999px to 1000px).
const NARROW_QUERY = '(max-width: 759px)';
const FLUID_MIN = 200;
const fluidCap = (vw: number) => FLUID_MIN + Math.max(0, vw - 760) * 0.2;
const windowWidth = () => window.innerWidth;
const onWindowWidth = (cb: () => void) => (window.addEventListener('resize', cb), () => window.removeEventListener('resize', cb));
const RAIL_WIDTH = 68;
const isNarrow = () => window.matchMedia(NARROW_QUERY).matches;
const onNarrowChange = (cb: () => void) => {
  const mq = window.matchMedia(NARROW_QUERY);
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
};

// An organization that can't be reached right now (its host offline, or not
// hosted anywhere yet) gets a page saying so instead of the agency.
// A new install opens on the first-run screen (connect an AI model) in your own agency.
// What a person reads of a request's evidence: not the tools' input schemas
// ("crm.add_note expects: {...}"), which are for the Agency Engineer.
const personEvidence = (evidence: string | null | undefined) =>
  (evidence ?? '')
    .split('\n')
    .filter(l => !/^(Input it expects:|[\w.-]+ expects: [{[])/.test(l.trim()))
    .join('\n')
    .trim();

export function App() {
  const org = currentOrg();
  const [firstRun, setFirstRun] = useState(() => !org && !onboarded());
  if (firstRun) return <Onboarding onDone={() => setFirstRun(false)} />;
  return org && state.unreachable ? <Elsewhere org={org} /> : <Agency />;
}

// Offline (account.ts): since when, kept in step.
const useOfflineSince = () => useSyncExternalStore(onOffline, () => offline.since);

function Agency() {
  const offlineSince = useOfflineSince();
  // Your AI assistant's messages for an organization hosted elsewhere, carried while the app is open.
  useEffect(() => carryAssistantMessages(), []);
  // #agents-browser: straight to the Agents' browser page (no menu item for it yet).
  const [view, setView] = useState<View>(() => (location.hash === '#agents-browser' ? 'browser' : 'dashboard'));
  // A page of the agents' browser opened for the person (in the cloud, builder.ts openAgentBrowser): shown on its page.
  const [browserTab, setBrowserTab] = useState<string | null>(null);
  useEffect(() => {
    const on = (e: Event) => (setBrowserTab((e as CustomEvent<{ tab: string }>).detail.tab), setView('browser'));
    window.addEventListener('eaa:agents-browser', on);
    return () => window.removeEventListener('eaa:agents-browser', on);
  }, []);
  const [dmStopped, setDmStopped] = useState(false); // the agent whose DM is open is stopped (LiveDM)
  useEffect(() => setDmStopped(false), [view]);
  const [range, setRange] = useState<TimeRange>('week');
  // The built-in agents' cards, hidden on the Dashboard only (hidden by default; remembered here).
  const [hideBuiltIns, setHideBuiltIns] = useState(() => {
    try {
      return localStorage.getItem(scoped('eaa.hideBuiltIns')) !== '0';
    } catch {
      return true;
    }
  });
  const toggleBuiltIns = () =>
    setHideBuiltIns(h => {
      try {
        localStorage.setItem(scoped('eaa.hideBuiltIns'), h ? '0' : '1');
      } catch {
        // Storage unavailable - it just won't be remembered.
      }
      return !h;
    });
  // The whole agency's Standby and Stop (the dashboard's), kept in step with the server.
  const [agency, setAgencyState] = useState<AgencyState>('active');
  // Whether the server has answered yet: until then the dashboard's cards (and
  // their request and approval counts) wait rather than guess.
  const [agencyReady, setAgencyReady] = useState(false);
  const agencySetAt = useRef(0);
  useEffect(() => {
    const load = () =>
      getAgency().then(a => {
        if (Date.now() - agencySetAt.current > 4000) setAgencyState(a.state);
        setAgencyReady(true);
      }, () => {});
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, []);
  // The agency's days run on its host's clock. Until orgs exist, whoever runs
  // the app is the host: the first time it opens, the server takes its time zone.
  useEffect(() => {
    // Only the host computer's own person says who the host is (an org's members don't).
    if (!currentOrg() || currentOrg()?.role === 'owner') void setHostPerson(ACCOUNT.name, ACCOUNT.org?.name ?? null).catch(() => {});
    getHostZone().then(
      h => {
        if (!h.set && isAdmin()) void setHostZone(Intl.DateTimeFormat().resolvedOptions().timeZone).catch(() => {});
      },
      () => {},
    );
  }, []);
  const changeAgency = (next: AgencyState) => {
    const was = agency;
    agencySetAt.current = Date.now();
    setAgencyState(next);
    setAgency(next).catch(() => setAgencyState(was));
  };
  // Approvals: resolved ones drop out of every count (sidebar badge, dashboard).
  // `resolved` records a decision the moment it's made (so counters react
  // straight away); `gone` drops the card once its exit animation has played.
  const [resolved, setResolved] = useState<Record<string, Resolution>>({});
  const [approvalFailures, setApprovalFailures] = useState<ApprovalFailure[]>([]);
  const [gone, setGone] = useState<Record<string, true>>({});
  // Real agents' T2 calls waiting on you (docs/runner.md), decided on the server.
  const [liveApprovals, setLiveApprovals] = useState<Approval[]>([]);
  const [approvalsReady, setApprovalsReady] = useState(false);
  // Ones you've decided leave the server's list; keep them so the tallies still know them.
  const decidedLive = useRef(new Map<string, Approval>());
  useEffect(() => {
    const load = () =>
      getLiveApprovals().then(
        ({ list, withdrawn }) => {
          setApprovalsReady(true);
          setLiveApprovals(prev => [
            ...list.map(a => ({
              id: a.id,
              live: true,
              agentId: a.agentId,
              tool: a.tool,
              // The card shows text: lists and objects as their JSON.
              args: Object.fromEntries(Object.entries(a.args).map(([k, v]) => [k, typeof v === 'string' || typeof v === 'number' ? v : JSON.stringify(v)])),
              card: a.card ?? null,
              minutesAgo: 0,
              createdAt: a.createdAt,
              expiresAt: a.expiresAt,
              paused: a.agentStopped,
              pausedByAgency: !!a.agencyStopped,
              owner: a.owner,
              // The Agency Engineer is owned by no one: its approvals belong to
              // the owner of the agent they're for.
              // The Agency Engineer's card is for the agent it gives tools to; the Agency Doctor's for the one it's about.
              forAgentId:
                a.agentId === 'fleet' && typeof a.args.for_agent === 'string'
                  ? a.args.for_agent
                  : a.agentId === 'doctor' && typeof a.args.agent_id === 'string'
                    ? a.args.agent_id
                    : undefined,
            })),
            ...[...decidedLive.current.values()].filter(d => !list.some(a => a.id === d.id)),
            // Taken back by its agent: kept long enough to play leaving.
            ...prev.filter(p => withdrawn.includes(p.id) && !list.some(a => a.id === p.id) && !decidedLive.current.has(p.id)).map(p => ({ ...p, withdrawn: true })),
          ]);
        },
        () => {},
      );
    load();
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, []);
  const allApprovals = liveApprovals;
  // Bumped when an agent is deleted, so everything re-reads AGENTS.
  const [, setAgentsVersion] = useState(0);
  const exists = (id?: string) => !id || AGENTS.some(a => a.id === id);
  const pending = allApprovals.filter(a => !gone[a.id] && exists(a.agentId) && exists(a.forAgentId));
  const [scope, setScope] = useState<ApprovalScope>('mine');
  // Going to one approval (from a request, or a draft in Settings): it's
  // centred on the Approvals page and glows blue for a moment.
  const [focusApproval, setFocusApproval] = useState<string | null>(null);
  const [agentFilterRaw, setAgentFilter] = useState<string | null>(null);
  // A filter on an agent with nothing left in scope falls back to all agents.
  const agentFilter =
    agentFilterRaw && visibleApprovals(pending, scope).some(a => a.agentId === agentFilterRaw) ? agentFilterRaw : null;
  const approvalCounts: Record<string, number> = {};
  for (const a of pending) approvalCounts[a.agentId] = (approvalCounts[a.agentId] ?? 0) + 1;
  // Decisions made in this session, per agent - they all happened today, so they
  // add to the dashboard's counts in every time frame and to today's tally.
  const sessionDecisions: Record<string, Decisions> = {};
  for (const [id, r] of Object.entries(resolved)) {
    const agentId = allApprovals.find(a => a.id === id)!.agentId;
    const d = (sessionDecisions[agentId] ??= { approved: 0, rejected: 0, expired: 0 });
    d[r]++;
  }
  // Decisions arriving live from elsewhere in the org (other people, expiries).
  const [liveDecisions, setLiveDecisions] = useState<Record<string, Decisions>>({});
  useEffect(
    () =>
      subscribeToDecisions(e =>
        setLiveDecisions(prev => {
          const d = prev[e.agentId] ?? { approved: 0, rejected: 0, expired: 0 };
          return { ...prev, [e.agentId]: { ...d, [e.outcome]: d[e.outcome] + 1 } };
        }),
      ),
    [],
  );
  // Everything decided since the app opened, yours plus live: added on top of
  // each agent's history on the dashboard.
  const newDecisions: Record<string, Decisions> = {};
  for (const src of [sessionDecisions, liveDecisions]) {
    for (const [id, d] of Object.entries(src)) {
      const t = (newDecisions[id] ??= { approved: 0, rejected: 0, expired: 0 });
      t.approved += d.approved;
      t.rejected += d.rejected;
      t.expired += d.expired;
    }
  }
  // Today's tally on Approvals is only YOUR decisions.
  const decidedToday = Object.values(sessionDecisions).reduce(
    (t, d) => ({ approved: t.approved + d.approved, rejected: t.rejected + d.rejected }),
    { approved: 0, rejected: 0 },
  );
  // Requests: same shape as approvals - decided on click, removed after the exit.
  const [, setRequestResolved] = useState<Record<string, RequestResolution>>({});
  const [requestGone, setRequestGone] = useState<Record<string, true>>({});
  // Requests agents filed, with their Agency Engineer conversations. Your DIY
  // note or reason is the agent's answer.
  const [liveRequests, setLiveRequests] = useState<ResourceRequest[]>([]);
  const [requestsReady, setRequestsReady] = useState(false);
  // The ones on the page last time: one of them closed since (the Agency Engineer
  // finished it) stays for one more look, to play its exit.
  const shownRequests = useRef<Set<number>>(new Set());
  useEffect(() => {
    const load = () =>
      getLiveRequests().then(
        list => {
          setRequestsReady(true);
          const shown = list.filter(r => r.status === 'open' && r.needsYou);
          const closing = list.filter(r => r.status !== 'open' && shownRequests.current.has(r.id));
          shownRequests.current = new Set(shown.map(r => r.id));
          setLiveRequests(
            [...shown, ...closing]
              // Only once the Agency Engineer has worked out it needs you.
              .map(r => ({
                id: `live-${r.id}`,
                live: r.id,
                agentId: r.agent_id,
                // "Set up Media", "Set up Indexnow" are the tool's server, not a service anyone
                // knows: once the Agency Engineer picked the service, it's named, as a group of them is.
                summary: r.waitingOn && /^(set up|connect) /i.test(r.what) ? `Connect ${r.waitingOn.name}` : r.what,
                // A tool's input schema is for the Agency Engineer, not the person reading.
                detail: [r.why, personEvidence(r.evidence) && `Details: ${personEvidence(r.evidence)}`, r.expected_effect && `What changes once I have it: ${r.expected_effect}`]
                  .filter(Boolean)
                  .join('\n\n'),
                minutesAgo: Math.max(0, Math.round((Date.now() - r.created_at) / 60_000)),
                liveThread: r.thread.map(m => ({ from: m.from, text: m.text })),
                stage: r.stage,
                busy: r.engineerBusy,
                approvalId: r.approvalId,
                waitingOn: r.waitingOn,
                joinedTo: r.joinedTo ?? null,
                closedAs: r.status === 'open' ? undefined : r.status === 'rejected' ? ('rejected' as const) : ('done' as const),
              })),
          );
        },
        () => {},
      );
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, []);
  const pendingRequests = liveRequests.filter(r => !requestGone[r.id] && exists(r.agentId));
  // Still open: what the counts are (one flying off has already gone from them).
  const openRequests = pendingRequests.filter(r => !r.closedAs);
  const [requestScope, setRequestScope] = useState<ApprovalScope>('mine');
  const [requestFilterRaw, setRequestFilter] = useState<string | null>(null);
  const requestFilter =
    requestFilterRaw && visibleRequests(pendingRequests, requestScope).some(r => r.agentId === requestFilterRaw)
      ? requestFilterRaw
      : null;
  const requestCounts: Record<string, number> = {};
  for (const r of openRequests) requestCounts[r.agentId] = (requestCounts[r.agentId] ?? 0) + 1;
  // Agents the runner actually runs (they have files on the server): their DM
  // channels are real. Checked on start and whenever agents come or go.
  // The server's agents are the fleet: one made anywhere else (another device,
  // a pack, later the Agency Engineer) joins this list when it's next checked.
  const [realIds, setRealIds] = useState<Set<string>>(new Set());
  // Only the built-in agents so far (once the server has said so, so it never flashes on).
  // What the Requests badge counts: what's in your Mine. For an owner or admin that includes a
  // teammate's shared sign-in waiting on them (it says "Waiting on you"); a member's badge counts only theirs.
  const requestsBadgeCount = requestItems(isAdmin() ? visibleRequests(openRequests, 'mine') : visibleApprovals(openRequests, 'mine'));
  const firstAgent = realIds.size > 0 && AGENTS.every(a => a.builtIn);
  // Until an AI works only "Connect a model" glows; then New agent's yellow pulse (and its tip).
  const hasModels = useHasModels();
  const firstGlow = firstAgent && hasModels === true;
  // The crayon tip only where it fits: in a narrower window it ran under Stop agency
  // and Built-ins. Its width is kept from when it was last shown.
  const headerRef = useRef<HTMLElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const tipWidth = useRef(0);
  const [tipFits, setTipFits] = useState(true);
  useEffect(() => {
    const h = headerRef.current;
    if (!firstGlow || !h) return;
    const check = () => {
      if (tipRef.current) tipWidth.current = tipRef.current.offsetWidth;
      const title = h.querySelector<HTMLElement>('.header-title');
      const right = h.querySelector<HTMLElement>('.header-right');
      if (!title || !right) return;
      const rest = [...title.children].filter(c => c !== tipRef.current).reduce((n, c) => n + (c as HTMLElement).offsetWidth + 20, 0);
      setTipFits(rest + tipWidth.current + right.scrollWidth + 48 <= h.clientWidth);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(h);
    return () => ro.disconnect();
  }, [firstGlow, view]);
  useEffect(() => {
    const sync = () =>
      agentStatuses().then(s => {
        let added = false;
        for (const [id, a] of Object.entries(s)) {
          const have = AGENTS.find(x => x.id === id);
          if (have) {
            // What only the server knows, kept current on one this browser already has.
            // Its owner's name too: the one they have now, after a rename (access.ts).
            const owner = a.builtIn ? 'Built-in' : (a.owner ?? have.owner);
            if (!!have.service !== !!a.service || !!have.builtIn !== !!a.builtIn || have.name !== a.name || have.owner !== owner || have.createdAt !== a.createdAt || (have.ownerId ?? null) !== (a.ownerId ?? null) || JSON.stringify(have.pack ?? null) !== JSON.stringify(a.pack ?? null)) {
              Object.assign(have, { name: a.name, owner, ownerId: a.ownerId ?? null, createdAt: a.createdAt, pack: a.pack ?? null, builtIn: a.builtIn || undefined, service: a.service || undefined });
              added = true;
            }
            continue;
          }
          addAgent({
            id,
            name: a.name,
            department: a.department,
            owner: a.builtIn ? 'Built-in' : (a.owner ?? ACCOUNT.name),
            ownerId: a.ownerId ?? null,
            createdAt: a.createdAt,
            builtIn: a.builtIn || undefined,
            service: a.service || undefined,
            output: outputSlices(a.output),
            cost: [],
            runs: 0,
            lastRun: null,
            decisions: { approved: 0, rejected: 0, expired: 0 },
            ferocity: 0,
            settingUp: a.status === 'setting-up' || undefined,
            pack: a.pack ?? null,
          });
          added = true;
        }
        // Ones this browser kept that the server doesn't have aren't agents.
        for (const a of [...AGENTS]) if (!(a.id in s)) {
          forgetAgent(a.id);
          added = true;
        }
        setRealIds(new Set(Object.keys(s)));
        if (added) setAgentsVersion(v => v + 1);
      }, () => {});
    sync();
    const t = window.setInterval(sync, 10_000);
    return () => window.clearInterval(t);
  }, [AGENTS.length]);
  const mainBody = useRef<HTMLDivElement>(null);
  useElasticScroll(mainBody);
  // Each page opens at its top (New agent opened at the bottom, where the last DM was).
  // A DM scrolls itself to its newest post.
  useLayoutEffect(() => {
    if (!view.startsWith('agent:')) mainBody.current?.scrollTo({ top: 0 });
  }, [view]);

  // Settings (a pop-up over the app), and signing out. There's no real sign-in
  // yet, so signing out just shows the signed-out screen.
  const [settings, setSettings] = useState<SettingsSection | null>(null);
  // "Open Sentry Errors in Settings" (a request's message): Connectors, that integration glowing.
  const [settingsFocus, setSettingsFocus] = useState<string | null>(null);
  // Settings > Tools: the tool to bring into view (an approval's menu).
  const [toolFocus, setToolFocus] = useState<string | null>(null);
  const openIntegration = (name: string | null) => {
    setSettings('connectors');
    if (!name) return;
    const want = name.trim().toLowerCase();
    getIntegrations().then(
      v => setSettingsFocus(v.integrations.find(i => i.id === want || i.name.toLowerCase() === want)?.id ?? null),
      () => {},
    );
  };
  const openApproval = (id?: string | null) => {
    const ap = id ? pending.find(a => a.id === id) : undefined;
    if (ap) {
      if (!visibleApprovals([ap], scope).length && isAdmin()) setScope('all');
      setAgentFilter(null);
      setFocusApproval(ap.id);
    }
    setSettings(null);
    setView('approvals');
  };
  // Another request named in a request's text: there, open, glowing.
  const [focusRequest, setFocusRequest] = useState<number | null>(null);
  // Suggest alternative (a setup item): the reply box ready to type in, too.
  const [focusReply, setFocusReply] = useState(false);
  const openRequest = (live: number, reply = false) => {
    const r = openRequests.find(x => x.live === live);
    if (!r) return;
    if (!visibleRequests([r], requestScope).length && isAdmin()) setRequestScope('all');
    setRequestFilter(null);
    setFocusRequest(live);
    setFocusReply(reply);
    setView('requests');
  };
  // Signing in (for organizations) from anywhere: Settings, the account menu.
  const [signingIn, setSigningIn] = useState<SignInAsk | null>(null);
  useEffect(() => {
    const open = (e: Event) => setSigningIn((e as CustomEvent<SignInAsk>).detail ?? { mode: 'in', from: null });
    window.addEventListener('eaa:sign-in', open);
    return () => window.removeEventListener('eaa:sign-in', open);
  }, []);
  // Logging out while one of your agents is mid-run asks first (it used to just happen).
  const [loggingOut, setLoggingOut] = useState<string[] | null>(null);
  const logInOut = async () => {
    if (!state.me) return setSigningIn({ mode: 'in', from: null });
    const live = await getLiveAgents(1).catch(() => ({}) as Record<string, { running: boolean }>);
    const me = myAccountId();
    const running = AGENTS.filter(a => !a.builtIn && live[a.id]?.running && (!currentOrg() || !a.ownerId || a.ownerId === me)).map(a => a.name);
    if (running.length) setLoggingOut(running);
    else void signOut();
  };
  // Settings at a section, from anywhere (NoModels.tsx: "Connect a model").
  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent<{ section: SettingsSection; focus?: string }>).detail;
      setToolFocus(d.section === 'tools' ? (d.focus ?? null) : null);
      // A connector to bring into view (Connect these first's Connect buttons).
      if (d.section === 'connectors' && d.focus) setSettingsFocus(d.focus);
      setSettings(d.section);
    };
    window.addEventListener('eaa:settings', open);
    return () => window.removeEventListener('eaa:settings', open);
  }, []);
  const [, setOrgTick] = useState(0);

  // Creating an agent (docs/agent-creation.md). The conversation lives here so
  // it survives leaving the New agent page.
  // Kept on this computer, so a half-built agent's conversation survives a reload or restart
  // (it came back empty, with nothing to say it had gone). Mid-thought or mid-build, it
  // comes back as a conversation to carry on.
  const [builder, setBuilder] = useState<BuilderSession>(() => {
    const s = readStored<BuilderSession | null>(BUILDER_KEY, null);
    return s?.turns?.length ? { ...s, phase: s.phase === 'building' || s.phase === 'matching' ? 'chat' : s.phase, open: false, thinking: false, error: null } : NEW_SESSION;
  });
  useEffect(() => writeStored(BUILDER_KEY, builder.turns.length ? builder : null), [builder]);
  // The new agents on the black screen: one you built, or a whole pack.
  const [reveal, setReveal] = useState<{ built: Built[]; leaving: boolean; error: string | null } | null>(null);
  const [arrivingIds, setArrivingIds] = useState<string[]>([]);
  const cancelReveal = useCallback(() => setReveal(null), []);
  const acceptReveal = async () => {
    if (!reveal) return;
    try {
      await Promise.all(reveal.built.map(b => saveAgent(b)));
    } catch (e) {
      setReveal({ ...reveal, error: (e as Error).message });
      return;
    }
    for (const b of reveal.built) addAgent(b.agent);
    // Building an agent ends its conversation; adding a pack leaves yours alone.
    if (reveal.built.length === 1 && builder.phase === 'chat') setBuilder(NEW_SESSION);
    setReveal({ ...reveal, leaving: true, error: null });
    setArrivingIds(reveal.built.map(b => b.agent.id));
    setView('dashboard');
    mainBody.current?.scrollTo({ top: 0 });
    window.setTimeout(() => setReveal(null), 450);
  };
  // The smash plays once: forget the new agent as soon as it has landed, or
  // when you leave the dashboard, so coming back doesn't replay it.
  useEffect(() => {
    if (!arrivingIds.length) return;
    if (view !== 'dashboard') return setArrivingIds([]);
    const t = window.setTimeout(() => setArrivingIds([]), 1000);
    return () => window.clearTimeout(t);
  }, [arrivingIds, view]);

  // Pack agents are customized on the server after they're added. While any
  // is still setting up, check every few seconds; when one is ready its card
  // picks up its final details and any DM sent meanwhile gets answered.
  const [, setAgentsTick] = useState(0);
  const anySettingUp = AGENTS.some(a => a.settingUp);
  useEffect(() => {
    if (!anySettingUp) return;
    const check = async () => {
      let statuses;
      try {
        statuses = await agentStatuses();
      } catch {
        return; // server down: try again next tick
      }
      let changed = false;
      for (const a of AGENTS) {
        const s = statuses[a.id];
        if (!a.settingUp || !s || s.status === 'setting-up') continue;
        updateAgent(a.id, { settingUp: false, output: outputSlices(s.output) });
        changed = true;
      }
      if (changed) setAgentsTick(t => t + 1);
    };
    check();
    const id = window.setInterval(check, 3000);
    return () => window.clearInterval(id);
  }, [anySettingUp]);
  const [width, setWidth] = useState(() => clamp(readStored(WIDTH_KEY, DEFAULT_WIDTH)));
  const [shut, setShut] = useState(() => readStored(SHUT_KEY, false));

  useEffect(() => writeStored(WIDTH_KEY, width), [width]);
  useEffect(() => writeStored(SHUT_KEY, shut), [shut]);
  // A narrow window gets just the sidebar's icons; the full one opens over the page.
  const narrow = useSyncExternalStore(onNarrowChange, isNarrow);
  const vw = useSyncExternalStore(onWindowWidth, windowWidth);
  const sideWidth = Math.round(Math.min(width, fluidCap(vw)));
  const [railOpen, setRailOpen] = useState(false);
  useEffect(() => {
    if (!narrow) setRailOpen(false);
  }, [narrow]);

  // The sidebar's left edge is the window's left edge, so the pointer's x is the width.
  // onTap runs instead when the pointer is released without moving (click on the rail).
  const startDrag = useCallback((e: React.PointerEvent, onTap?: () => void) => {
    e.preventDefault();
    document.body.classList.add('resizing');
    let moved = false;
    const onMove = (ev: PointerEvent) => {
      moved = true;
      if (ev.clientX < SNAP_SHUT_BELOW) {
        setShut(true);
      } else {
        setShut(false);
        setWidth(clamp(ev.clientX));
      }
    };
    const onUp = () => {
      document.body.classList.remove('resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!moved) onTap?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  return (
    <div className={`app${offlineSince ? ' offline' : ''}`}>
      {shut ? (
        <div
          className="sidebar-rail"
          title="Open sidebar (click or drag)"
          onPointerDown={e => startDrag(e, () => setShut(false))}
        >
          <ChevronRight size={14} />
        </div>
      ) : (
        <Sidebar
          view={view}
          onSelect={setView}
          width={narrow ? RAIL_WIDTH : sideWidth}
          onResizeStart={startDrag}
          approvalsBadge={approvalsReady ? visibleApprovals(pending, 'mine').length : null}
          requestsBadge={requestsReady ? requestsBadgeCount : null}
          onOpenSettings={setSettings}
          onLogOut={logInOut}
          compact={narrow}
          onExpand={() => setRailOpen(true)}
        />
      )}
      {narrow && railOpen && (
        <>
          <div className="sidebar-backdrop" onClick={() => setRailOpen(false)} />
          <Sidebar
            view={view}
            onSelect={v => {
              setRailOpen(false);
              setView(v);
            }}
            width={DEFAULT_WIDTH}
            onResizeStart={startDrag}
            approvalsBadge={approvalsReady ? visibleApprovals(pending, 'mine').length : null}
            requestsBadge={requestsReady ? requestsBadgeCount : null}
            onOpenSettings={s => {
              setRailOpen(false);
              setSettings(s);
            }}
            onLogOut={logInOut}
            overlay
          />
        </>
      )}
      <main className="main">
        {offlineSince && (
          <div className="offline-banner" role="status">
            Host offline since {new Date(offlineSince).toLocaleDateString([], { weekday: 'short' })} {clockTime(offlineSince)}. Showing what you last saw; changes wait until it's back.
          </div>
        )}
        <header className="main-header" ref={headerRef}>
          <div className="header-title">
            <h1>{viewLabel(view)}</h1>
            {/* An agent's DM: stopped (it, or the whole agency) says so up here, like its card. */}
            {view.startsWith('agent:') && dmStopped && <span className="state-pill stopped">Stopped</span>}
            {view === 'approvals' && <DecisionTally approved={decidedToday.approved} rejected={decidedToday.rejected} />}
            {view === 'dashboard' && (
              <>
                <button className={`new-agent-btn${firstGlow ? ' first' : ''}`} onClick={() => setView('new-agent')} disabled={!!offlineSince} title={offlineSince ? OFFLINE_WHY : undefined}>
                  <Plus size={14} strokeWidth={2} />
                  New agent
                </button>
                {/* Nothing but the built-ins yet: where to begin, in crayon like the tip in Settings. */}
                {firstGlow && tipFits && (
                  <span className="first-agent-tip" ref={tipRef}>
                    <Crayon className="first-agent-arrow" viewBox="0 0 60 50" shaft="M57 30 C 44 21, 26 20, 8 28" head="M17 19 C 14 22, 11 25, 6 29 C 11 32, 14 34, 18 38" />
                    <span className="mtip-text">Start here to build your first agent</span>
                  </span>
                )}
              </>
            )}
          </div>
          <div className="header-right">
          {view === 'dashboard' && (
            <div className="header-tools">
              {isAdmin() && <AgencyControls state={agency} onChange={changeAgency} />}
              {/* A switch: on shows the built-in agents' cards. */}
              <button className="builtins-toggle" role="switch" aria-checked={!hideBuiltIns} onClick={toggleBuiltIns} title={hideBuiltIns ? 'Show the built-in agents on the Dashboard' : 'Hide the built-in agents on the Dashboard'}>
                <span className={`switch sm${hideBuiltIns ? '' : ' on'}`} aria-hidden />
                Built-ins
              </button>
              <RangePicker value={range} onChange={setRange} />
            </div>
          )}
          {view === 'requests' && (
            <ApprovalsToolbar
              pending={pendingRequests}
              scope={requestScope}
              setScope={setRequestScope}
              agentFilter={requestFilter}
              setAgentFilter={setRequestFilter}
            />
          )}
          {view === 'approvals' && (
            <ApprovalsToolbar
              pending={pending}
              scope={scope}
              setScope={setScope}
              agentFilter={agentFilter}
              setAgentFilter={setAgentFilter}
            />
          )}
          {/* The page's help (help/): glows until read; Getting started first. */}
          {helpTopicFor(view) && <HelpButton key={helpTopicFor(view)} topic={helpTopicFor(view)!} onNavigate={setView} quiet={hasModels !== true} />}
          </div>
        </header>
        <div className="main-body" ref={mainBody}>
          {view === 'dashboard' ? (
            <Dashboard
              onOpenRequest={openRequest}
              range={range}
              hideBuiltIns={hideBuiltIns}
              agency={agency}
              onNavigate={setView}
              approvalCounts={approvalCounts}
              requestCounts={requestCounts}
              newDecisions={newDecisions}
              arrivingIds={arrivingIds}
              agencyReady={agencyReady}
              agentsKnown={realIds.size > 0}
              newAgentGlow={firstGlow}
              countsReady={approvalsReady && requestsReady}
              onDeleteAgent={async id => {
                await deleteAgentFiles(id);
                removeAgent(id);
                setAgentsVersion(v => v + 1);
              }}
            />
          ) : view === 'approvals' ? (
            <Approvals
              loading={!approvalsReady}
              pending={pending}
              scope={scope}
              agentFilter={agentFilter}
              focus={focusApproval}
              onFocused={() => setFocusApproval(null)}
              onDecide={(id, r, note) => {
                setResolved(prev => ({ ...prev, [id]: r }));
                // A real one: the server runs it (approved) and tells the agent.
                // Expiry is the server's call, so the countdown running out sends nothing.
                const live = liveApprovals.find(a => a.id === id);
                if (live) decidedLive.current.set(id, live);
                if (live && r !== 'expired')
                  decideApproval(id, r, note || undefined).then(
                    out =>
                      !out.ok &&
                      setApprovalFailures(prev => [
                        ...prev.filter(f => f.id !== id),
                        { id, agentId: live.agentId, why: String(out.result ?? '').replace(/^Approved, but it failed:\s*/, '') },
                      ]),
                    e => {
                      window.alert((e as Error).message);
                      // Not decided after all: bring the card back.
                      decidedLive.current.delete(id);
                      setResolved(({ [id]: _, ...rest }) => rest);
                      setGone(({ [id]: _, ...rest }) => rest);
                    },
                  );
              }}
              onGone={id => setGone(prev => ({ ...prev, [id]: true }))}
              failures={approvalFailures}
              onDismissFailure={id => setApprovalFailures(prev => prev.filter(f => f.id !== id))}
            />
          ) : view === 'requests' ? (
            <Requests
              loading={!requestsReady}
              pending={pendingRequests}
              scope={requestScope}
              agentFilter={requestFilter}
              onDecide={(id, r, note) => {
                setRequestResolved(prev => ({ ...prev, [id]: r }));
                const live = liveRequests.find(x => x.id === id)?.live;
                if (live) answerRequest(live, r === 'rejected' ? 'rejected' : 'done', note).catch(() => {});
              }}
              onGone={id => setRequestGone(prev => ({ ...prev, [id]: true }))}
              onOpenApprovals={openApproval}
              onOpenBrowser={() => setView('browser')}
              // A member opens only their own requests (someone else's showed as a link that did nothing).
              refs={{
                onRequest: openRequest,
                canOpen: id => openRequests.some(r => r.live === id && (isAdmin() || visibleRequests([r], 'mine').length > 0)),
                onSettings: openIntegration,
              }}
              focus={focusRequest}
              focusReply={focusReply}
              onFocused={() => (setFocusRequest(null), setFocusReply(false))}
            />
          ) : view === 'new-agent' ? (
            <NewAgent
              session={builder}
              setSession={setBuilder}
              onBuilt={built => {
                // The builder steps aside for what it built (it stayed open underneath).
                setBuilder(s => ({ ...s, open: false }));
                setReveal({ built, leaving: false, error: null });
              }}
              agencyStopped={agency === 'stopped'}
              agentsReady={realIds.size > 0}
            />
          ) : view === 'browser' ? (
            <AgentsBrowser openTab={browserTab} onOpened={() => setBrowserTab(null)} />
          ) : view.startsWith('agent:') ? (
            <LiveDM key={view} agentId={view.slice('agent:'.length)} approvalOutcomes={resolved} onOpenDashboard={() => setView('dashboard')} onStopped={setDmStopped} />
          ) : (
            <div className="main-empty">Coming next.</div>
          )}
        </div>
      </main>
      {settings && (
        <Settings
          section={settings}
          onSection={setSettings}
          onClose={() => setSettings(null)}
          onOpenApproval={openApproval}
          focusIntegration={settingsFocus}
          onFocused={() => setSettingsFocus(null)}
          focusTool={toolFocus}
          onToolFocused={() => setToolFocus(null)}
          onOrgChange={() => setOrgTick(t => t + 1)}
          onLogOut={logInOut}
        />
      )}
      {/* Signed in: the app starts again, with your organizations. */}
      {loggingOut && (
        <div className="confirm-scrim" onMouseDown={e => e.target === e.currentTarget && setLoggingOut(null)}>
          <div className="confirm" role="alertdialog" aria-labelledby="logout-title">
            <h2 id="logout-title">Log out?</h2>
            <p>
              {loggingOut.join(', ')} {loggingOut.length === 1 ? 'is' : 'are'} running right now. {currentOrg() ? "It carries on on the organization's computer; you just won't see it until you sign in again." : 'Logging out takes you back to your own agency.'}
            </p>
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={() => setLoggingOut(null)}>
                Cancel
              </button>
              <button className="confirm-delete" onClick={() => (setLoggingOut(null), void signOut())}>
                Log out
              </button>
            </div>
          </div>
        </div>
      )}
      {signingIn && <SignIn mode={signingIn.mode} from={signingIn.from} onCancel={() => setSigningIn(null)} onDone={() => location.reload()} />}
      {reveal && (
        <AgentReveal
          agents={reveal.built.map(b => b.agent)}
          models={reveal.built.map(b => b.files.models ?? [])}
          leaving={reveal.leaving}
          error={reveal.error}
          onCancel={cancelReveal}
          onAccept={acceptReveal}
        />
      )}
    </div>
  );
}
