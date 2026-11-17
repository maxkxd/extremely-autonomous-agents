import type { Tier } from '../../catalog.js';

// The contract for an integration whose tools are code (kind: code): shipped
// ones like Gmail, and later the Agency Engineer's code plugins.
//   tools   - each gets the agent's inputs, the integration's current key or
//             access token, and the kit; it returns what the agent reads
//   kit     - kit.fetch: the only way a tool reaches the network. Public
//             addresses only, every redirect checked (runner/net.ts), so no
//             tool can reach this computer or its network.
//   account - who the key or sign-in belongs to, shown in Settings

export type CodeTool = {
  id: string; // server.tool
  tier: Tier;
  description: string;
  input: Record<string, unknown>; // JSON Schema
  // Text, or text with pictures for the agent to look at (a frame, a contact sheet).
  run: (args: Record<string, unknown>, token: string | undefined, kit: Kit) => Promise<string | ToolResultWithImages>;
};

export type Kit = { fetch: (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number }) => Promise<Response> };

export type CodeModule = {
  tools: CodeTool[];
  account?: (token: string | undefined) => Promise<string>;
};

// What a code tool gives back with pictures: base64 data, image/png or image/jpeg.
export type ToolResultWithImages = { text: string; images: { data: string; mimeType: string }[] };
