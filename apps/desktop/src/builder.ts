import { ACCOUNT, AGENTS, type Agent, type Department } from './data';
import { AGENT_PACKS } from './packs';
import type { StampedEntry } from './AgentDM';

// Client side of the agent builder (docs/agent-creation.md). The server
// (apps/server) does the thinking with Claude; the Charter, TOOLS.yaml and
// KPI.yaml it writes never reach the UI except as an opaque bundle we hand
// back when the person accepts.

export type Turn = { role: 'person' | 'builder'; text: string };

// Hidden files, as the server composed them.
export type AgentFiles = { id: string; name: string; department: Department; charter: string; tools: string; kpi: string; models?: ModelChoice[] };
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

export type AgentStatus = { status: 'ready' | 'setting-up' | 'generic'; name: string; department: Department; output: string[]; owner: string | null; builtIn?: boolean; service?: boolean };
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
  lastError?: string;
  broken?: string; // a saved key that didn't check out, and why
  claudeCode?: { installed: boolean; version?: string; loggedIn: boolean; authMethod?: string; task?: 'installing' | 'signing-in' };
};

export const getConnections = () => request<Connection[]>('/api/connections');
export const connectKey = (id: string, key: string, baseUrl?: string) => post<{ ok: true }>('/api/connections/key', { id, key, baseUrl });
export const retryKey = (id: string) => post<{ ok: true }>('/api/connections/retry', { id });
export const disconnectModel = (id: string) => post<{ ok: true }>('/api/connections/disconnect', { id });
export const startSignIn = (id: string) => post<{ url: string }>('/api/connections/oauth/start', { id });
export const startCopilot = () => post<{ userCode: string; verificationUri: string }>('/api/connections/copilot/start', {});
export const connectClaudeCode = () => post<{ ok: true }>('/api/connections/claude-code/check', {});
export const installClaudeCode = () => post<{ ok: true }>('/api/connections/claude-code/install', {});
export const signInClaudeCode = () => post<{ ok: true }>('/api/connections/claude-code/login', {});

// --- Which models each agent runs on (docs/model-connections.md) ---

export const EFFORTS = ['low', 'medium', 'high', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];
// Up to three, in order: the first is used, the others take over if it fails.
export type ModelChoice = { connection: string; model: string; effort: Effort };
// efforts: the levels each model takes; a model not listed has no effort setting.
export type AvailableModels = { connection: string; name: string; kind: 'plan' | 'key' | 'local'; models: string[]; efforts: Record<string, Effort[]> };

export const getAvailableModels = () => request<AvailableModels[]>('/api/models');
export const getAgentModels = () => request<Record<string, ModelChoice[]>>('/api/agents/models');
export const setAgentModels = (id: string, choices: ModelChoice[]) =>
  post<{ choices: ModelChoice[] }>('/api/agents/models', { id, choices });
// --- The runner (docs/runner.md): real agents' cards, state and runs ---

export type RunState = 'active' | 'draining' | 'stopped';
export type LiveAgent = {
  ferocity: number;
  state: RunState;
  running: boolean;
  runs: number;
  lastRun: { at: number; outcome: 'succeeded' | 'failed' | 'running' | 'stopped' } | null;
  output: { tool: string; label: string; value: number }[];
  cost: { label: string; value: number }[];
  costUnknown: boolean;
  decisions: { approved: number; rejected: number; expired: number };
  spendCapUsd: number | null;
  runsPerDay: number[]; // expected at each ferocity level
  perRun: number | null; // output actions per run, recently
};
export const getLiveAgents = (days: number) => request<Record<string, LiveAgent>>(`/api/runner/agents?days=${days}`);
export const setAgentRunner = (id: string, patch: { ferocity?: number; state?: RunState; spendCapUsd?: number | null }) =>
  post<{ ok: boolean }>('/api/runner/agent', { id, ...patch });
export const runNow = (id: string) => post<{ ok: boolean }>('/api/runner/run-now', { id });
// A real agent's DM channel: run posts and your messages, oldest first.
export const getDm = (id: string) =>
  request<(StampedEntry & { at: number })[]>(`/api/dm?id=${encodeURIComponent(id)}`).then(list =>
    list.map(e => ({ ...e, minutesAgo: 0 }) as StampedEntry),
  );
export const sendDm = (id: string, text: string) => post<{ ok: boolean }>('/api/dm', { id, text });
// Requests real agents filed (docs/requests.md), and your answer to one.
export type LiveRequest = {
  id: number;
  agent_id: string;
  what: string;
  why: string;
  evidence: string | null;
  expected_effect: string | null;
  status: string;
  stage: 'engineer' | 'waiting_you' | 'approval' | 'person' | null;
  created_at: number;
  thread: { from: 'you' | 'engineer'; text: string; at: number }[];
  engineerBusy: boolean;
  approvalId: string | null;
};
export const getLiveRequests = () => request<LiveRequest[]>('/api/runner/requests');
export const answerRequest = (id: number, status: 'done' | 'rejected', answer: string) =>
  post<{ ok: boolean }>('/api/runner/requests/answer', { id, status, answer });
export const sendToIde = (id: number, ide: string) =>
  post<{ opened: boolean; folder: string; prompt: string; ide: string }>('/api/runner/requests/ide', { id, ide });
export const sendRequestMessage = (id: number, text: string) => post<{ ok: boolean }>('/api/runner/requests/message', { id, text });

// Whether the Fleet Engineer may write code plugins (Settings -> Connectors).
export const getCodePlugins = () => request<{ allowed: boolean }>('/api/settings/code-plugins');
export const setCodePlugins = (allowed: boolean) => post<{ allowed: boolean }>('/api/settings/code-plugins', { allowed });

// Integrations (docs/integrations.md): the services agents' tools run on.
export type IntegrationView = {
  id: string;
  name: string;
  what: string;
  kind: 'http' | 'mcp' | 'code';
  keyUrl?: string;
  keyHelp: string | null;
  needsKey: boolean;
  signIn: { clientUrl: string | null; help: string | null; hasClient: boolean } | null; // OAuth
  shipped: boolean;
  connected: boolean;
  draft: boolean; // the Fleet Engineer's, not live until approved
  approvalId: string | null; // its go-live, waiting on you
  by: string | null;
  test: { ok: boolean; at: number; message: string } | null;
  tools: { id: string; tier: string }[];
};
export type IntegrationsView = { integrations: IntegrationView[]; problems: { file: string; error: string }[]; profile: { open: boolean; inUse: boolean } };
export const getIntegrations = () => request<IntegrationsView>('/api/integrations');
export const connectIntegration = (id: string, key?: string) => post<{ ok: boolean; message: string }>('/api/integrations/connect', { id, key });
export const disconnectIntegration = (id: string) => post<{ ok: boolean }>('/api/integrations/disconnect', { id });
export const removeIntegration = (id: string) => post<{ ok: boolean }>('/api/integrations/remove', { id });
export const addMcpIntegration = (b: { url: string; name?: string; auth: 'none' | 'bearer' | 'signin'; key?: string }) =>
  post<{ id: string; ok: boolean; message: string; signIn?: string }>('/api/integrations/add', b);
export const startIntegrationSignIn = (id: string, client: { clientId?: string; clientSecret?: string }) =>
  post<{ url: string }>('/api/integrations/sign-in', { id, ...client });

// Approvals: real agents' T2 calls waiting on a person.
export type LiveApproval = { id: string; agentId: string; agentName: string; owner: string | null; agentStopped: boolean; tool: string; args: Record<string, unknown>; createdAt: number; expiresAt: number };
export const getLiveApprovals = () => request<{ approvals: LiveApproval[] }>('/api/runner/approvals').then(r => r.approvals);
export const decideApproval = (id: string, decision: 'approved' | 'rejected', note?: string) =>
  post<{ ok: boolean; ran: boolean; result: string | null }>('/api/runner/approvals/decide', { id, decision, note });
export const openAgentBrowser = () => post<{ ok: boolean }>('/api/browser/sign-in', {});

// Daily spend caps (Settings -> Usage): the organisation's, and each agent's.
export type Usage = {
  orgCapUsd: number | null;
  spentTodayUsd: number;
  agents: {
    id: string;
    name: string;
    department: string;
    capUsd: number | null;
    spentTodayUsd: number;
    monthUsd: number; // this calendar month
    monthRuns: number;
    monthUnknownRuns: number; // runs on a model with no known price
  }[];
};
export const getUsage = () => request<Usage>('/api/usage');
export const setOrgCap = (orgCapUsd: number | null) => post<{ ok: boolean }>('/api/usage', { orgCapUsd });

// Whether a model really works on this account: one tiny test request when
// it's picked. unsure: the check got no real answer (busy, down).
export type ModelCheck = { ok: boolean; reason?: string; unsure?: boolean; at: number; pending?: boolean };
export const getModelChecks = () => request<Record<string, ModelCheck>>('/api/models/checks');
export const checkModel = (connection: string, model: string, force = false) =>
  post<{ check: ModelCheck; available: AvailableModels[] }>('/api/models/check', { connection, model, force });
