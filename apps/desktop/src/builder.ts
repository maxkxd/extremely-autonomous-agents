import { ACCOUNT, AGENTS, type Agent, type Department } from './data';
import { AGENT_PACKS } from './packs';

// Client side of the agent builder (docs/agent-creation.md). The server
// (apps/server) does the thinking with Claude; the Charter, TOOLS.yaml and
// KPI.yaml it writes never reach the UI except as an opaque bundle we hand
// back when the person accepts.

export type Turn = { role: 'person' | 'builder'; text: string };

// Hidden files, as the server composed them.
export type AgentFiles = { id: string; name: string; department: Department; charter: string; tools: string; kpi: string };
// setup: a pack agent, customized for the organisation in the background once added.
export type Built = { agent: Agent; files: AgentFiles; setup?: { packId: string; index: number } };

// One creation, from the first words typed into the custom card to the build.
export type BuilderSession = {
  phase: 'idle' | 'matching' | 'recommended' | 'chat' | 'building';
  turns: Turn[];
  // The pack it recommended (at most once) and why.
  recommended: { packId: string; reason: string } | null;
  declinedPack: string | null; // its name, once the person carried on anyway
  open: boolean; // the pop-up is showing (closing it keeps the conversation)
  confidence: number; // 0-100, the builder's own estimate
  ready: boolean;
  thinking: boolean;
  error: string | null;
};

export const NEW_SESSION: BuilderSession = {
  phase: 'idle',
  turns: [],
  recommended: null,
  declinedPack: null,
  open: false,
  confidence: 0,
  ready: false,
  thinking: false,
  error: null,
};

// The organisation every agent works for (its profile is kept per organisation).
const ORG = ACCOUNT.org?.name ?? ACCOUNT.name;

const OFFLINE = 'The app server is not running. Start apps/server (npm run dev).';

async function request<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      path,
      body === undefined
        ? undefined
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ org: ORG, ...body }) },
    );
  } catch {
    throw new Error(OFFLINE);
  }
  const data = await res.json().catch(() => ({ error: OFFLINE }));
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong.');
  return data as T;
}
const post = <T>(path: string, body: object) => request<T>(path, body);

// --- The organisation profile ---

export type Profile = {
  name: string;
  what_it_does: string;
  customers: string;
  offering: string;
  voice: string;
  people: { name: string; role: string }[];
  notes: string[];
};

export const getProfile = () => request<{ profile: Profile | null }>(`/api/org?name=${encodeURIComponent(ORG)}`).then(r => r.profile);
export const profileTurn = (turns: Turn[]) =>
  post<{ reply: string; confidence: number; ready: boolean; profile: Profile }>('/api/org/turn', { turns });
export const saveProfile = (profile: Profile) => post<{ ok: true }>('/api/org', { profile });
// The profile chat opens with this, so it needs no round trip.
export const PROFILE_OPENER = `Before I build anything for ${ORG}: what does it do, and who for?`;

// --- Building ---

export const matchPack = (description: string) =>
  post<{ pack_id: string | null; reason: string }>('/api/builder/match', {
    description,
    packs: AGENT_PACKS.map(p => ({ id: p.id, name: p.name, tagline: p.tagline, agents: p.agents })),
  });

export const nextTurn = (turns: Turn[], declinedPack: string | null) =>
  post<{ reply: string; confidence: number; ready: boolean }>('/api/builder/turn', { turns, declinedPack });

type ServerAgent = {
  agent: { id: string; name: string; department: Department; output: string[] };
  files: AgentFiles;
  setup?: { packId: string; index: number };
};

export async function buildAgent(turns: Turn[]): Promise<Built> {
  return toBuilt(await post<ServerAgent>('/api/builder/build', { turns, takenIds: AGENTS.map(a => a.id) }));
}

// A pack's agents come pre-built (apps/server/packs), so this is instant. They
// are customized for the organisation in the background once added.
export async function addPack(packId: string): Promise<Built[]> {
  const out = await post<{ agents: ServerAgent[] }>('/api/packs/add', { packId, takenIds: AGENTS.map(a => a.id) });
  return out.agents.map(toBuilt);
}

export const outputSlices = (labels: string[]) =>
  labels.map(label => ({ label: label.charAt(0).toUpperCase() + label.slice(1), value: 0 }));

function toBuilt(out: ServerAgent): Built {
  return {
    files: out.files,
    setup: out.setup,
    // A brand-new card: no runs, nothing spent, and always starting on Chill.
    agent: {
      id: out.agent.id,
      name: out.agent.name,
      department: out.agent.department,
      owner: ACCOUNT.name,
      output: outputSlices(out.agent.output),
      cost: [{ label: 'Model usage', value: 0 }],
      runs: 0,
      lastRun: null,
      decisions: { approved: 0, rejected: 0, expired: 0 },
      ferocity: 0,
      settingUp: !!out.setup,
    },
  };
}

export const saveAgent = (b: Built) => post<{ ok: true }>('/api/agents', { files: b.files, setup: b.setup });
export const deleteAgentFiles = (id: string) => post<{ ok: true }>('/api/agents/delete', { id });

export type AgentStatus = { status: 'ready' | 'setting-up' | 'generic'; name: string; department: Department; output: string[] };
export const agentStatuses = () => request<Record<string, AgentStatus>>('/api/agents/status');
