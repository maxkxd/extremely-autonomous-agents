import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agencyTools } from './agency-mcp.js';

// The public package's bundled tool list (packages/agency-mcp/tools.json), as
// MCP's tools/list gives them.
export const BUNDLED_TOOLS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'packages', 'agency-mcp', 'tools.json');

export const bundledTools = () =>
  agencyTools('owner').map(t => ({ name: t.name, ...(t.title ? { title: t.title } : {}), description: t.description, inputSchema: t.schema, ...(t.annotations ? { annotations: t.annotations } : {}) }));
