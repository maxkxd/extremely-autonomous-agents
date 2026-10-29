import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { keyTargets } from './index.js';
import { Integration } from './schema.js';
import { all, resetDbForTests } from '../runner/db.js';
import { toolHistory } from '../runner/engineer.js';

const can = (t: ReturnType<typeof keyTargets>, method: string, url: string) => {
  const u = new URL(url);
  return t.hosts.has(u.host) && t.writes.some(w => (w.method === null || w.method === method) && w.pattern.test(`${u.origin}${u.pathname}`));
};

test("check_key writes: an http integration's own tool endpoints only, at their method", () => {
  const t = keyTargets(
    Integration.parse({
      kind: 'http',
      id: 'zz-tracker',
      name: 'Tracker',
      what: 'x',
      auth: { type: 'bearer' },
      base_url: 'https://api.tracker.example/v1/',
      test: { tool: 'zz.list', args: {} },
      tools: [
        { id: 'zz.list', tier: 'T0', description: 'x', input: { type: 'object' }, request: { path: '/issues' } },
        { id: 'zz.comment', tier: 'T1', description: 'x', input: { type: 'object' }, request: { method: 'POST', path: '/issues/{{issue_id}}/comments' } },
      ],
    }),
  );
  assert.deepEqual([...t.hosts], ['api.tracker.example']);
  assert.equal(can(t, 'POST', 'https://api.tracker.example/v1/issues/123/comments'), true);
  assert.equal(can(t, 'POST', 'https://api.tracker.example/v1/issues/123/comments/'), true); // trailing slash
  assert.equal(can(t, 'PATCH', 'https://api.tracker.example/v1/issues/123/comments'), false); // not its method
  assert.equal(can(t, 'POST', 'https://api.tracker.example/v1/issues/123/resolve'), false); // a bare POST that acts
  assert.equal(can(t, 'POST', 'https://api.tracker.example/v1/issues'), false); // a read, not a write endpoint
  assert.equal(can(t, 'POST', 'https://api.tracker.example/v1/issues/1/2/comments'), false); // a wildcard is one segment
});

test("check_key on a code plugin: hosts and endpoints from the addresses its code calls, not its comments", () => {
  const code = `
    // See https://docs.example-tracker.io/api for the reference.
    const base = 'https://api.tracker.example/v1';
    await kit.fetch(\`https://api.tracker.example/v1/issues/\${args.issue_id}/comments/\`, { method: 'POST' });
    await kit.fetch(\`https://api.tracker.example/v1/orgs/\${org}/issues/\${id}/\`, { method: 'PUT' });
  `;
  const t = keyTargets(
    Integration.parse({ kind: 'code', id: 'zz-plugin', name: 'Plugin', what: 'x', auth: { type: 'bearer' }, module: 'zz-plugin', test: { tool: 'zz.x', args: {} } }),
    code,
  );
  assert.deepEqual([...t.hosts], ['api.tracker.example']); // not the docs host from the comment
  assert.equal(can(t, 'POST', 'https://api.tracker.example/v1/issues/77/comments/'), true);
  assert.equal(can(t, 'PATCH', 'https://api.tracker.example/v1/orgs/acme/issues/77/'), true);
  assert.equal(can(t, 'POST', 'https://api.tracker.example/v1/issues/77/resolve/'), false);
  // An MCP server's key is only checked with reads.
  assert.equal(keyTargets(Integration.parse({ kind: 'mcp', id: 'zz-mcp', name: 'M', what: 'x', auth: { type: 'bearer' }, url: 'https://mcp.example.com/mcp' })).writes.length, 0);
});

beforeEach(() => resetDbForTests());

test("tool history: how a tool has really done, per agent, so a stale failure shows as one", () => {
  const now = Date.now();
  const act = (tool: string, outcome: string, ago: number) =>
    all("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, at) VALUES ('r', 'zz-agent', ?, '[]', 'T1', ?, ?) RETURNING id", tool, outcome, now - ago);
  act('errors.resolve_issue', 'failed', 3 * 3_600_000);
  for (let i = 0; i < 4; i++) act('errors.resolve_issue', 'ok', 3_600_000 - i * 60_000);
  act('errors.list_issues', 'ok', 60_000);
  all(
    "INSERT INTO tool_health (agent_id, tool, last_ok, last_fail, last_error) VALUES ('zz-agent', 'errors.resolve_issue', ?, ?, 'HTTP 403') RETURNING agent_id",
    now - 1_000,
    now - 3 * 3_600_000,
  );
  const h = toolHistory(['errors.resolve_issue'], 'zz-agent', 14, now);
  assert.match(h, /errors\.resolve_issue \(zz-agent\): 4 ok, 1 failed in 14 days/);
  assert.match(h, /last failure 3h ago: HTTP 403/);
  assert.match(h, /oldest first: FAIL ok ok ok ok/);
  assert.match(toolHistory(['errors'], 'zz-agent', 14, now), /errors\.list_issues/); // a prefix: the whole server
  assert.match(toolHistory(['nope.tool'], undefined, 14, now), /No calls of nope\.tool/);
});
