import '../test-data-dir.js';
import assert from 'node:assert/strict';
import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { deleteAgent } from '../agents.js';
import { DATA, listIds, save } from '../files.js';
import { allChoices, setChoices } from '../models/choice.js';
import { all, getSetting, one, resetDbForTests, run as exec, setSetting } from './db.js';
import { setGoal, storePace } from './goals.js';

// Deleting an agent must leave nothing keyed by its id, so remaking one of the
// same name starts completely clean.

const ID = 'cleanup-agent';
const files = {
  id: ID,
  name: 'Cleanup Agent',
  department: 'operations',
  charter: '# CHARTER\nTest.',
  tools: `agent_id: ${ID}\ntool_tiers: {}\n`,
  kpi: 'output:\n  - action: gmail.send_email\n    label: emails sent\n    amount: 10\n    period: day\n',
  models: [],
};

const count = (sql: string, ...args: (string | number)[]) => one<{ n: number }>(sql, ...args)!.n;

const seed = async (now: number) => {
  await save(files, { name: files.name, department: files.department, output: ['emails sent'], status: 'ready' });
  await setChoices(ID, [{ connection: 'openai', model: 'gpt-4', effort: 'high' }]);
  setGoal(ID, 'emails sent', 10, 'day', now);
  storePace(ID, 'emails sent=10/day', { every_min: 60, note: 'old pace' }, now);
  exec("INSERT INTO agent_state (agent_id, ferocity, state, updated_at) VALUES (?, 1, 'active', ?) ON CONFLICT(agent_id) DO UPDATE SET updated_at = excluded.updated_at", ID, now);
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, ended_at, acts) VALUES ('run-old', ?, 'scheduled', 1, 'succeeded', ?, ?, 4)", ID, now - 1000, now);
  exec("INSERT INTO actions (run_id, agent_id, tool, fields, tier, outcome, output, at) VALUES ('run-old', ?, 'gmail.send_email', '[]', 'T1', 'ok', 4, ?)", ID, now);
  exec("INSERT INTO memories (agent_id, text, created_at) VALUES (?, 'an old memory', ?)", ID, now);
  exec("INSERT INTO dm (agent_id, kind, body, at) VALUES (?, 'run', '{}', ?)", ID, now);
  exec("INSERT INTO bookings (agent_id, trigger, task, due_at, created_at) VALUES (?, 'run now', 'go', ?, ?)", ID, now, now);
  exec("INSERT INTO requests (agent_id, what, why, created_at, status) VALUES (?, 'Set a goal', 'none yet', ?, 'open')", ID, now);
  exec("INSERT INTO request_messages (request_id, from_who, text, at) VALUES ((SELECT id FROM requests WHERE agent_id = ?), 'engineer', 'hi', ?)", ID, now);
  exec("INSERT INTO approvals (id, agent_id, run_id, tool, args, created_at, expires_at) VALUES ('ap-old', ?, 'run-old', 'gmail.send_email', '{}', ?, ?)", ID, now, now + 1000);
  exec("INSERT INTO tasks (agent_id, from_agent, task, created_at) VALUES (?, 'other', 'do a thing', ?)", ID, now);
  exec("INSERT INTO tool_health (agent_id, tool, last_ok) VALUES (?, 'gmail.send_email', ?)", ID, now);
  exec("INSERT INTO action_pace (agent_id, tool, account, every_ms, updated_at) VALUES (?, 'gmail.send_email', '*', 1000, ?)", ID, now);
  exec("INSERT INTO accounts (id, agent_id, site, purpose, state, attempts, created_at, updated_at) VALUES ('acc-old', ?, 'x.com', 'post', 'working', 0, ?, ?)", ID, now, now);
  exec("INSERT INTO passwords (id, site, username, profile, agent_id, created_at) VALUES ('pw-old', 'x.com', 'bot', 1, ?, ?)", ID, now);
  setSetting('no_goal_asked', { [ID]: 1, other: 2 });
  setSetting('resume_at', { [ID]: now + 1000 });
  setSetting('run_days', { [ID]: [1, 2, 3] });
  setSetting('models_moved_off', { [ID]: { had: [], to: 'x' } });
  setSetting('builtin_tool_levels', { [ID]: { 'files.read_file': 'T0' } });
};

beforeEach(() => resetDbForTests());
after(async () => {
  await rm(join(DATA, ID), { recursive: true, force: true });
});

test('deleting an agent removes every row, setting and file, and remaking the same id starts clean', async () => {
  const now = Date.now();
  await seed(now);
  assert.ok((await listIds()).includes(ID));
  assert.equal(count('SELECT COUNT(*) AS n FROM agent_goals WHERE agent_id = ?', ID), 1);
  await deleteAgent(ID);

  assert.deepEqual(await listIds(), []);
  await access(join(DATA, ID)).then(
    () => {
      throw new Error('workspace dir should be gone');
    },
    () => {},
  );
  assert.equal((await allChoices())[ID], undefined);
  for (const sql of [
    'SELECT COUNT(*) AS n FROM agent_goals WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM agent_pace WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM agent_state WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM actions WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM memories WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM dm WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM bookings WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM requests WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM request_messages',
    'SELECT COUNT(*) AS n FROM approvals WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM tool_health WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM action_pace WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM accounts WHERE agent_id = ?',
    'SELECT COUNT(*) AS n FROM passwords WHERE agent_id = ?',
  ]) {
    const args = sql.includes('?') ? [ID] : [];
    assert.equal(count(sql, ...args), 0, sql);
  }
  for (const key of ['no_goal_asked', 'resume_at', 'run_days', 'models_moved_off', 'builtin_tool_levels']) {
    const map = getSetting<Record<string, unknown>>(key, {});
    assert.ok(!(ID in map), key);
  }
  assert.equal(getSetting<Record<string, unknown>>('no_goal_asked', {}).other, 2, 'other agents are untouched');

  // Remade under the same name and id: none of the predecessor's state comes back.
  await save(files, { name: files.name, department: files.department, output: ['emails sent'], status: 'ready' });
  assert.deepEqual(await listIds(), [ID]);
  assert.equal(count('SELECT COUNT(*) AS n FROM agent_goals WHERE agent_id = ?', ID), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM agent_pace WHERE agent_id = ?', ID), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM runs WHERE agent_id = ?', ID), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM memories WHERE agent_id = ?', ID), 0);
  assert.equal(count('SELECT COUNT(*) AS n FROM accounts WHERE agent_id = ?', ID), 0);
  assert.equal(getSetting<Record<string, unknown>>('no_goal_asked', {})[ID], undefined);
});
