import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { DEFAULT_PLAN, type AgentDef } from './agent.js';
import { decideApproval, expireApprovals, pendingApprovals, recentlyWithdrawn } from './approvals.js';
import { setKeptPageCheck } from './kept-pages.js';
import { one, resetDbForTests, run as exec } from './db.js';
import { stateOf } from './run.js';
import { execute, onApprovalSettled, registerTools, withdrawMine } from './tools.js';

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
  events: [],
  newEvents: [],
  output: [],
  maxRunsPerDay: 24,
  ferocity: { ...DEFAULT_PLAN, counts: [] },
  limits: [],
};

let sent: unknown[] = [];
const approvedCtx: boolean[] = [];
const settled: string[] = [];
onApprovalSettled(runId => void settled.push(runId));
let fail = false;
registerTools([
  {
    id: 'mail.send',
    tier: 'T2',
    description: 'send',
    schema: { type: 'object', properties: { to: { type: 'string' }, body: { type: 'string' } }, required: ['to', 'body'] },
    impl: async (args, ctx) => {
      if (fail) throw new Error('mailbox full');
      approvedCtx.push(!!ctx.approved);
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
  settled.length = 0;
  approvedCtx.length = 0;
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

test('an approved call that keeps failing goes to the Agency Engineer, and the agent is told to stop queuing it', async () => {
  const now = Date.now();
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at) VALUES ('r1', ?, 'scheduled', 0, 'running', ?)", agent.id, now);
  const ctx = { agent, runId: 'r1', level: 0, now: () => now, fleet: async () => [], wake: () => {} };
  fail = true;
  for (const to of ['a@acme.com', 'b@acme.com', 'c@acme.com']) {
    const out = await execute(ctx, { id: to, name: 'mail__send', args: { to, body: 'hi' } }, new Map([['mail__send', 'mail.send']]));
    await decideApproval(out.approvalId!, 'approved', null, wake, now, async () => agent);
  }
  assert.ok(one("SELECT 1 FROM requests WHERE what = 'Fix the tool mail.send: it keeps failing' AND status = 'open'"));
  const told = woken.filter(w => w.agent === agent.id).map(w => w.task);
  assert.doesNotMatch(told[1], /Agency Engineer/); // twice could be the input
  assert.match(told[2], /with the Agency Engineer to fix\. Don't queue it again/);
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

test('the same proposal twice in one turn makes one card, not two (its preview takes a while)', async () => {
  registerTools([
    {
      id: 'zz.publish',
      tier: 'T2',
      description: 'publish',
      schema: { type: 'object', properties: { integration_id: { type: 'string' }, for_agent: { type: 'string' } }, required: ['integration_id', 'for_agent'] },
      preview: async () => (await new Promise(r => setTimeout(r, 30)), { checked: true }),
      impl: async () => 'Published.',
    },
  ]);
  const slow = { ...agent, tiers: { ...agent.tiers, 'zz.publish': 'T2' as const } };
  const now = Date.now();
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at) VALUES ('r2', ?, 'scheduled', 0, 'running', ?)", agent.id, now);
  const ctx = { agent: slow, runId: 'r2', level: 0, now: () => now, fleet: async () => [], wake: () => {} };
  const names = new Map([['zz__publish', 'zz.publish']]);
  const outs = await Promise.all([
    execute(ctx, { id: 'c1', name: 'zz__publish', args: { integration_id: 'drive-more', for_agent: 'agent-one' } }, names),
    execute(ctx, { id: 'c2', name: 'zz__publish', args: { integration_id: 'drive-more', for_agent: 'agent-two' } }, names),
  ]);
  assert.deepEqual(outs.map(o => o.outcome).sort(), ['queued', 'refused']);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM approvals WHERE tool = 'zz.publish'")!.n, 1);
});

// A browser click waiting for a person keeps its page past its run (browser.ts);
// it closes when the click is decided, whichever way. The approved call runs
// knowing it's an approved one, so a page that's gone is said plainly.
test("however it's decided, the run's kept page is let go; an approved call knows it is one", async () => {
  await decideApproval(await queue(), 'approved', null, wake, Date.now(), async () => agent);
  assert.deepEqual(approvedCtx, [true]);
  resetDbForTests();
  await decideApproval(await queue(), 'rejected', null, wake, Date.now(), async () => agent);
  resetDbForTests();
  const now = Date.now();
  await queue(now);
  expireApprovals(now + 2 * 3_600_000, wake);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(settled, ['r1', 'r1', 'r1']);
});

test("a browser click whose kept page has closed is withdrawn, and its agent told", () => {
  const now = Date.now();
  const add = (id: string, page: string) =>
    exec("INSERT INTO approvals (id, agent_id, run_id, tool, args, created_at, expires_at) VALUES (?, ?, 'r1', 'signed_in_browser.click_to_post', ?, ?, ?)", id, agent.id, JSON.stringify({ ref: 4, what: 'Post it', _page: page }), now, now + 86_400_000);
  add('kept', 'wp_alive');
  add('gone', 'wp_closed');
  setKeptPageCheck(page => page === 'wp_alive');
  try {
    assert.equal(expireApprovals(now, wake), 1);
    assert.equal(one<{ status: string }>("SELECT status FROM approvals WHERE id = 'gone'")?.status, 'expired');
    assert.equal(one<{ status: string }>("SELECT status FROM approvals WHERE id = 'kept'")?.status, 'pending');
    assert.match(woken.at(-1)!.task, /WITHDRAWN: the page it was waiting on closed/);
  } finally {
    setKeptPageCheck(() => true);
  }
});

// An agent taking back its own waiting approvals (approvals.withdraw_mine).
async function queueTo(to: string, now: number) {
  if (!one('SELECT id FROM runs WHERE id = ?', 'r1')) exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at) VALUES ('r1', ?, 'scheduled', 0, 'running', ?)", agent.id, now);
  const ctx = { agent, runId: 'r1', level: 0, now: () => now, fleet: async () => [], wake: () => {} };
  const out = await execute(ctx, { id: to, name: 'mail__send', args: { to, body: 'Hi - Max here' } }, new Map([['mail__send', 'mail.send']]));
  return out.approvalId!;
}
const statusOf = (id: string) => one<{ status: string }>('SELECT status FROM approvals WHERE id = ?', id)!.status;

test('a rejected one of a batch tells its agent it can withdraw the others, which then leave the page', async () => {
  const t = Date.now() - 60_000;
  const [a, b, c] = [await queueTo('a@x.com', t), await queueTo('b@x.com', t + 1), await queueTo('c@x.com', t + 2)];
  await decideApproval(a, 'rejected', 'Sign off as the team, not Max', wake, t + 10, async () => agent);
  assert.match(woken.at(-1)!.task, /2 other actions still waiting[\s\S]*approvals\.withdraw_mine/);
  const out = withdrawMine(agent.id, { approval_ids: [b, c], why: 'Same sign-off' }, t + 30);
  assert.match(out, /Withdrew 2/);
  assert.deepEqual([statusOf(b), statusOf(c)], ['withdrawn', 'withdrawn']);
  assert.deepEqual(recentlyWithdrawn(t + 40).sort(), [b, c].sort());
  assert.equal((await pendingApprovals()).length, 0);
});

test('an agent can only withdraw its own approvals that are still waiting', async () => {
  const t = Date.now() - 60_000;
  const b = await queueTo('b@x.com', t);
  exec("INSERT INTO approvals (id, agent_id, run_id, tool, args, created_at, expires_at) VALUES ('apv_other', 'someone-else', 'r9', 'mail.send', '{}', ?, ?)", t, t + 9e6);
  assert.throws(() => withdrawMine(agent.id, { approval_ids: ['apv_other'], why: 'x' }, t + 5), /none of those/);
  assert.match(withdrawMine(agent.id, { approval_ids: [b, 'apv_other'], why: 'x' }, t + 5), /Withdrew 1[\s\S]*apv_other/);
  assert.equal(statusOf('apv_other'), 'pending');
});
