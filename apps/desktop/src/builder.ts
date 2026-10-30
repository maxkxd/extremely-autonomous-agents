import { ACCOUNT, AGENTS, type Agent, type Department } from './data';
import { agencyFetch, currentOrg } from './account';
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
export type Built = { agent: Agent; files: AgentFiles; setup?: { packId: string; index: number; member?: string } };

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

// Every request goes to the agency the app is in (account.ts says where, and with what token).
async function request<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await agencyFetch(
      path,
      body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...who(), ...body }) },
    );
  } catch (e) {
    throw new Error(currentOrg() ? (e as Error).message : OFFLINE);
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
  interviewed?: boolean; // its profile chat has been done (server/src/org.ts)
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
// existing: what's already written for it - the opener asks about what isn't.
export const profileOpener = (org: string, existing?: Profile | null) => {
  if (!org) return "Let's set up your organization. What's it called, what does it do, and who for?";
  const missing = [
    !existing?.what_it_does?.trim() && 'what it does',
    !existing?.customers?.trim() && 'who its customers are',
    !existing?.offering?.trim() && 'what it sells',
    !existing?.voice?.trim() && 'how it sounds when it writes',
  ].filter(Boolean) as string[];
  if (missing.length === 4) return `Before I build anything for ${org}: what does it do, and who for?`;
  const list = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0];
  return missing.length
    ? `Before I build anything for ${org}: I've got what you wrote. Tell me ${list}.`
    : `Before I build anything for ${org}: I've got what you wrote. Who are the key people agents should report to?`;
};
// Whether its chat is still to do (server/src/org.ts interviewDone, the same rule).
export const interviewDone = (p: Profile | null) => !!p && (!!p.interviewed || [p.what_it_does, p.customers, p.offering, p.voice].every(v => v?.trim()));

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
  setup?: { packId: string; index: number; member?: string };
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
      pack: out.setup ? { id: out.setup.packId, member: out.setup.member ?? out.agent.name } : null,
    },
  };
}

export const saveAgent = (b: Built) => post<{ ok: true }>('/api/agents', { files: b.files, setup: b.setup });
export const deleteAgentFiles = (id: string) => post<{ ok: true }>('/api/agents/delete', { id });

export type AgentStatus = { status: 'ready' | 'setting-up' | 'generic'; name: string; department: Department; output: string[]; owner: string | null; ownerId?: string | null; builtIn?: boolean; service?: boolean; pack?: { id: string; member: string } | null };
export const agentStatuses = () => request<Record<string, AgentStatus>>('/api/agents/status');

// Settings > Tools (server/src/toolSettings.ts): every tool the agents use, and its level.
export type ToolTier = 'T0' | 'T1' | 'T2';
export type ToolView = { id: string; name: string; source: string; does: string; tier: ToolTier | 'mixed'; agents: { id: string; name: string; tier: ToolTier }[] };
export const getTools = () => request<ToolView[]>('/api/tools');
export const setToolTier = (id: string, tier: ToolTier) => post<{ changed: number }>('/api/tools/tier', { id, tier });

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
  claudeCode?: { installed: boolean; version?: string; loggedIn: boolean; authMethod?: string; task?: 'installing' | 'signing-in' | 'updating'; needsUpdate?: string };
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
export const updateClaudeCode = () => post<{ ok: true }>('/api/connections/claude-code/update', {});

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
// The host's time zone: whose midnight the agency's days start at.
export const getHostZone = () => request<{ zone: string; set: boolean }>('/api/settings/host-timezone');
export const setHostZone = (zone: string) => post<{ zone: string }>('/api/settings/host-timezone', { zone });
// The whole agency's Stop.
export type AgencyState = 'active' | 'standby' | 'stopped';
export const getAgency = () => request<{ state: AgencyState }>('/api/runner/agency');
export const setAgency = (state: AgencyState) => post<{ state: AgencyState }>('/api/runner/agency', { state });
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
  needsYou: boolean; // shown on the Requests page only once it needs the person
  approvalId: string | null;
};
export const getLiveRequests = () => request<LiveRequest[]>('/api/runner/requests');
export const answerRequest = (id: number, status: 'done' | 'rejected', answer: string) =>
  post<{ ok: boolean }>('/api/runner/requests/answer', { id, status, answer });
export const sendToIde = (id: number, ide: string) =>
  post<{ opened: boolean; folder: string; prompt: string; ide: string }>('/api/runner/requests/ide', { id, ide });
export const sendRequestMessage = (id: number, text: string) => post<{ ok: boolean }>('/api/runner/requests/message', { id, text });

// Whether the Agency Engineer may write code plugins (Settings -> Connectors).
// The agency's own MCP server, for the person's AI IDE; and who the host is.
export const getAgencyMcp = () => request<{ url: string }>('/api/settings/agency-mcp');
export const setHostPerson = (name: string, org: string | null) => post<{ ok: boolean }>('/api/settings/host-person', { name, org });
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
  // A sign-in of fields the service takes (an id and secret, a refresh token, a region).
  fields: { name: string; label: string; help: string | null; secret: boolean; optional: boolean; saved: boolean; value: string | null }[] | null;
  signIn: { clientUrl: string | null; help: string | null; hasClient: boolean; redirect: string | null } | null; // OAuth
  shipped: boolean;
  connected: boolean;
  draft: boolean; // the Agency Engineer's, not live until approved
  approvalId: string | null; // its go-live, waiting on you
  by: string | null;
  test: { ok: boolean; at: number; message: string } | null;
  tools: { id: string; tier: string }[];
  // Its events (docs/events.md): checked every N minutes (poll), and/or pushed to a webhook address.
  events: { id: string; description: string; poll: number | null; webhook: boolean; signed: boolean; secretHelp: string | null; setupHelp: string | null }[];
  webhookSecretSet: boolean;
};
export type IntegrationsView = { integrations: IntegrationView[]; problems: { file: string; error: string }[]; profile: { open: boolean; inUse: boolean } };
// Events: their webhook addresses, and the tunnel that makes those public.
export type TunnelState = { status: 'off' | 'starting' | 'on' | 'missing' | 'error'; url: string | null; error: string | null };
export type EventInfo = { id: string; integration: string; live: boolean; description: string; agents: string[]; webhook: string | null; told: number; poll: { everyMinutes: number; last: number | null; error: string | null } | null };
export const getEvents = () => request<{ tunnel: TunnelState; base: string; events: EventInfo[] }>('/api/events');
export const setTunnel = (on: boolean) => post<{ tunnel: TunnelState; base: string }>('/api/events/tunnel', { on });
export const setWebhookSecret = (id: string, secret: string) => post<{ ok: boolean }>('/api/integrations/webhook-secret', { id, secret });
export const getIntegrations = () => request<IntegrationsView>('/api/integrations');
export const connectIntegration = (id: string, key?: string, fields?: Record<string, string>) =>
  post<{ ok: boolean; message: string }>('/api/integrations/connect', { id, key, fields });
export const disconnectIntegration = (id: string) => post<{ ok: boolean }>('/api/integrations/disconnect', { id });
export const removeIntegration = (id: string) => post<{ ok: boolean }>('/api/integrations/remove', { id });
export const addMcpIntegration = (b: { url: string; name?: string; auth: 'none' | 'bearer' | 'signin'; key?: string }) =>
  post<{ id: string; ok: boolean; message: string; signIn?: string }>('/api/integrations/add', b);
export const startIntegrationSignIn = (id: string, client: { clientId?: string; clientSecret?: string }) =>
  post<{ url: string }>('/api/integrations/sign-in', { id, ...client });

// Approvals: real agents' T2 calls waiting on a person.
export type LiveApproval = { id: string; agentId: string; agentName: string; owner: string | null; agentStopped: boolean; tool: string; args: Record<string, unknown>; createdAt: number; expiresAt: number };
export const getLiveApprovals = () => request<{ approvals: LiveApproval[] }>('/api/runner/approvals').then(r => r.approvals);
// levels: for a card giving tools, the level the person set for each ("agent|tool" -> T0-T2).
export const decideApproval = (id: string, decision: 'approved' | 'rejected', note?: string, levels?: Record<string, string>) =>
  post<{ ok: boolean; ran: boolean; result: string | null }>('/api/runner/approvals/decide', { id, decision, note, levels });
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
