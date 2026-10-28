import type { Tier } from '../../catalog.js';

// The contract for an integration whose tools are code (kind: code): shipped
// ones like Gmail, and later the Fleet Engineer's code plugins.
//   tools   - each gets the agent's inputs and the integration's current key
//             or access token, and returns what the agent reads
//   account - who the key or sign-in belongs to, shown in Settings

export type CodeTool = {
  id: string; // server.tool
  tier: Tier;
  description: string;
  input: Record<string, unknown>; // JSON Schema
  run: (args: Record<string, unknown>, token: string | undefined) => Promise<string>;
};

export type CodeModule = {
  tools: CodeTool[];
  account?: (token: string | undefined) => Promise<string>;
};
