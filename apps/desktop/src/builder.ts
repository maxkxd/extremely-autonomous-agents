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

// Who's asking, the organisation they belong to (null for a personal account)
// and its members (just them while it's being created). Read on every request:
// an account can become an organization.
const who = () => ({ person: ACCOUNT.name, org: ACCOUNT.org?.name ?? null, members: ACCOUNT.org?.members ?? [ACCOUNT.name] });

const OFFLINE = 'The app server is not running. Start apps/server (npm run dev).';

async function request<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(
      path,
      body === undefined
        ? undefined
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...who(), ...body }) },
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
  // member: the account this person is, if the server matched one (read only here).
  people: KeyPerson[];
  notes: string[];
};
export type KeyPerson = { name: string; role: string; member?: string | null };

// org: the organization's name - passed explicitly while it's being created.
export const getProfile = (org = ACCOUNT.org?.name ?? '') =>
  request<{ profile: Profile | null }>(`/api/org?name=${encodeURIComponent(org)}`).then(r => r.profile);
export const profileTurn = (org: string, turns: Turn[]) =>
  post<{ reply: string; confidence: number; ready: boolean; profile: Profile }>('/api/org/turn', { org, turns });
// link: have the server match the key people to members right away.
export const saveProfile = (org: string, profile: Profile, link = false) => post<{ ok: true }>('/api/org', { org, profile, link });
// Matches any key people not yet checked against the members, and returns every link.
export const linkKeyPeople = (org: string) => post<{ people: KeyPerson[] }>('/api/org/links', { org }).then(r => r.people);
// The profile chat opens with this, so it needs no round trip.
export const profileOpener = (org: string) =>
  org ? `Before I build anything for ${org}: what does it do, and who for?` : "Let's set up your organization. What's it called, what does it do, and who for?";

// --- The person (every account has one, organization or not) ---

export type Person = { name: string; full_name?: string; call_me?: string; email: string; role: string; about: string; notes: string[] };
export const getPerson = () => request<{ person: Person }>(`/api/person?name=${encodeURIComponent(ACCOUNT.name)}`).then(r => r.person);
export const savePerson = (profile: Person) => post<{ ok: true }>('/api/person', { profile });

// --- Settings ---

export const getCatalog = () => request<{ server: string; what: string; tools: number }[]>('/api/catalog');
export const getHealth = () => request<{ anthropicKey: boolean }>('/api/health');

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

// --- AI model connections (docs/model-connections.md) ---

export type Connection = {
  id: string;
  name: string;
  kind: 'plan' | 'key' | 'local';
  what: string;
  keyUrl?: string;
  keyPrefix?: string;
  baseUrl?: string;
  editableBaseUrl?: boolean;
  oneClick?: boolean;
  connected: boolean;
  label?: string;
  models: number;
  pending?: { userCode?: string; verificationUri?: string };
  setupNeeded?: string;
  claudeCode?: { installed: boolean; version?: string; loggedIn: boolean; authMethod?: string };
};

export const getConnections = () => request<Connection[]>('/api/connections');
export const connectKey = (id: string, key: string, baseUrl?: string) => post<{ ok: true }>('/api/connections/key', { id, key, baseUrl });
export const disconnectModel = (id: string) => post<{ ok: true }>('/api/connections/disconnect', { id });
export const startSignIn = (id: string) => post<{ url: string }>('/api/connections/oauth/start', { id });
export const startCopilot = () => post<{ userCode: string; verificationUri: string }>('/api/connections/copilot/start', {});
export const connectClaudeCode = () => post<{ ok: true }>('/api/connections/claude-code/check', {});
