#!/usr/bin/env node
// EXTREMELY's agency for AI apps, over MCP (stdio). What it does: lib.js.
import { APP, serve, VERSION } from './lib.js';

if (process.argv.includes('--version')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}
if (process.argv.includes('--help')) {
  process.stdout.write(`agency-mcp ${VERSION}: your EXTREMELY agency for AI apps, over MCP (stdio).\nAdd it to your AI app as the command: npx -y @extremely/agency-mcp\nNeeds the ${APP} app running on this computer: https://extremely.agency\n`);
  process.exit(0);
}

// One JSON-RPC message per line in, one answer per line out; logs only on stderr.
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) track(serve(line).then(out => out && process.stdout.write(out + '\n')));
  }
});
// Input closed (the AI app quit): finish the answers still on their way, then stop.
const pending = new Set();
const track = p => (pending.add(p), p.finally(() => pending.delete(p)));
process.stdin.on('end', async () => {
  while (pending.size) await Promise.allSettled([...pending]);
  process.exit(0);
});
