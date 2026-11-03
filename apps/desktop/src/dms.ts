// Agent DM channels (docs/agent-dms.md): one post per run, plus direct
// messages. The posts themselves come from the server (LiveDM.tsx).

// One tool call in a run post. Field NAMES only, never values.
// status: ok / failed, or for a human-approved tool, decided by its approval:
// pending until it's approved (ok) or rejected / expired (failed).
export type ToolLine = { server: string; tool: string; fields: string[]; status: 'ok' | 'failed'; approvalId?: string };

export type RunPost = {
  kind: 'run';
  id: string; // short run id
  minutesAgo: number;
  trigger: 'scheduled' | 'self-booked' | 'your message' | 'handoff' | 'approval' | 'run now' | 'request' | 'request reply' | 'turned down' | 'connected' | 'event' | 'task done';
  outcome: 'succeeded' | 'failed' | 'stopped';
  cost: number; // dollars
  costKnown?: boolean; // false: a model whose price isn't known
  seconds: number;
  text: string; // the run's final result text
  tools: ToolLine[];
};

// by: who wrote it, from the server (in an organization, maybe not you); older messages have none.
export type YourMessage = { kind: 'you'; minutesAgo: number; text: string; by?: string };

// After a message sent while the agent is stopped: the app's reply that it's
// stopped and where to resume it (kept on the host; the agent answers once resumed).
export type StoppedReply = { kind: 'stopped'; minutesAgo: number };

export type DmEntry = RunPost | YourMessage | StoppedReply;
