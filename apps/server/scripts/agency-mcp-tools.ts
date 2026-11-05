// Writes packages/agency-mcp/tools.json: the agency's MCP tools as an owner
// sees them, which the public package lists when the app isn't running (so AI
// apps and registries still see what it does). Run after changing a tool in
// runner/agency-mcp.ts; agency-mcp.test.ts fails while it's out of date.
//
//   npm run agency-mcp-tools
import '../src/test-data-dir.js'; // a throwaway data folder: nothing real is opened
import { writeFile } from 'node:fs/promises';
import { bundledTools, BUNDLED_TOOLS_FILE } from '../src/runner/agency-mcp-bundle.js';

await writeFile(BUNDLED_TOOLS_FILE, JSON.stringify(bundledTools(), null, 2) + '\n');
console.log(`Wrote ${bundledTools().length} tools to ${BUNDLED_TOOLS_FILE}`);
