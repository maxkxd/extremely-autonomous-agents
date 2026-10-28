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
  trigger: 'scheduled' | 'self-booked' | 'your message' | 'handoff' | 'approval' | 'run now';
  outcome: 'succeeded' | 'failed' | 'stopped';
  cost: number; // dollars
  costKnown?: boolean; // false: a model whose price isn't known
  seconds: number;
  text: string; // the run's final result text
  tools: ToolLine[];
};

export type YourMessage = { kind: 'you'; minutesAgo: number; text: string };

export type DmEntry = RunPost | YourMessage;
