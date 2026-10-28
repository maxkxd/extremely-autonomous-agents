import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULT_PLAN, type AgentDef } from './agent.js';
import { decideApproval, expireApprovals, pendingApprovals } from './approvals.js';
import { one, resetDbForTests, run as exec } from './db.js';
import { stateOf } from './run.js';
import { execute, registerTools } from './tools.js';

const agent: AgentDef = {
  id: 'zz-approvals-test',
  name: 'Approvals Test',
  department: 'ops',
  owner: null,
  org: null,
  charter: '',
  models: [],
  tiers: { 'mail.send': 'T2' },
  approvalHours: { 'mail.send': 1 },
  newTools: [],
  output: [],
  maxRunsPerDay: 24,
  ferocity: { ...DEFAULT_PLAN, counts: [] },
  limits: [],
};

let sent: unknown[] = [];
let fail = false;
registerTools([
  {
    id: 'mail.send',
    tier: 'T2',
    description: 'send',
    schema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] },
    impl: async args => {
      if (fail) throw new Error('mailbox full');
      sent.push(args);
      return 'Sent.';
    },
  },
]);

const woken: { agent: string; task: string }[] = [];
const wake = (agentId: string, _t: string, task: string) => void woken.push({ agent: agentId, task });

async function queue(now = Date.now()) {
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at) VALUES ('r1', ?, 'scheduled', 0, 'running', ?)", agent.id, now);
  const ctx = { agent, runId: 'r1', level: 0, now: () => now, fleet: async () => [], wake: () => {} };
  const out = await execute(ctx, { id: 'c1', name: 'mail__send', args: { to: 'dana@acme.com', body: 'hi' } }, new Map([['mail__send', 'mail.send']]));
  assert.equal(out.outcome, 'queued');
  return out.approvalId!;
}

beforeEach(() => {
  resetDbForTests();
  sent = [];
  woken.length = 0;
  fail = false;
});

test('a T2 call waits, then runs exactly once when approved, and the agent hears the result', async () => {
  const id = await queue();
  assert.equal(sent.length, 0);
  assert.equal((await pendingApprovals()).length, 1);
  const r = await decideApproval(id, 'approved', null, wake, Date.now(), async () => agent);
  assert.equal(r.ran, true);
  assert.deepEqual(sent, [{ to: 'dana@acme.com', body: 'hi' }]);
  assert.match(woken[0].task, /APPROVED.*ran: Sent\./);
  await assert.rejects(decideApproval(id, 'approved', null, wake, Date.now(), async () => agent), /Already/);
  assert.equal(sent.length, 1);
  assert.equal((await pendingApprovals()).length, 0);
});

test('rejected never runs, and the agent gets the note', async () => {
  const id = await queue();
  await decideApproval(id, 'rejected', 'Wrong tone', wake, Date.now(), async () => agent);
  assert.equal(sent.length, 0);
  assert.match(woken[0].task, /REJECTED.*Wrong tone/);
  assert.equal(one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', id)?.status, 'rejected');
});

test('nobody deciding in time means it never happens', async () => {
  const now = Date.now();
  const id = await queue(now);
  assert.equal(expireApprovals(now + 2 * 3_600_000, wake), 1);
  assert.match(woken[0].task, /EXPIRED/);
  await assert.rejects(decideApproval(id, 'approved', null, wake, now + 3 * 3_600_000, async () => agent), /Already expired/);
  assert.equal(sent.length, 0);
});

test('a failing approved call is reported, not lost', async () => {
  const id = await queue();
  fail = true;
  const r = await decideApproval(id, 'approved', null, wake, Date.now(), async () => agent);
  assert.equal(r.ok, false);
  assert.match(woken[0].task, /failed: mailbox full/);
});

test("a call missing a required input is refused, never queued for a person", async () => {
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at) VALUES ('r2', ?, 'scheduled', 0, 'running', ?)", agent.id, Date.now());
  const ctx = { agent, runId: 'r2', level: 0, now: () => Date.now(), fleet: async () => [], wake: () => {} };
  const out = await execute(ctx, { id: 'c2', name: 'mail__send', args: { to: '', body: 'hi' } }, new Map([['mail__send', 'mail.send']]));
  assert.equal(out.outcome, 'refused');
  assert.match(out.content, /Missing to/);
  assert.equal((await pendingApprovals()).length, 0);
});

test("a stopped agent's approval waits: it can't be decided until the agent is back on", async () => {
  const id = await queue();
  stateOf(agent.id);
  exec("UPDATE agent_state SET state = 'stopped' WHERE agent_id = ?", agent.id);
  assert.equal((await pendingApprovals())[0].agentStopped, true);
  await assert.rejects(decideApproval(id, 'approved', null, wake, Date.now(), async () => agent), /stopped/);
  assert.equal(sent.length, 0);
  exec("UPDATE agent_state SET state = 'active' WHERE agent_id = ?", agent.id);
  await decideApproval(id, 'approved', null, wake, Date.now(), async () => agent);
  assert.equal(sent.length, 1);
});
