import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { setHostZone } from './clock.js';
import { resetDbForTests, run as exec, setSetting } from './db.js';
import { overSpend } from './run.js';

// Spending limits are monthly, on the host's calendar (Settings -> Usage).

const NOW = Date.UTC(2026, 9, 20, 12); // 20 October 2026, noon UTC
const day = 86_400_000;
let n = 0;
const spent = (agentId: string, at: number, usd: number) =>
  exec("INSERT INTO runs (id, agent_id, trigger, ferocity, status, started_at, cost_usd) VALUES (?, ?, 'scheduled', 0, 'succeeded', ?, ?)", `r${n++}`, agentId, at, usd);
const capAgent = (agentId: string, usd: number | null) => {
  exec('INSERT OR IGNORE INTO agent_state (agent_id, ferocity, state, updated_at) VALUES (?, 0, ?, ?)', agentId, 'active', NOW);
  exec('UPDATE agent_state SET spend_cap_usd = ? WHERE agent_id = ?', usd, agentId);
};

beforeEach(() => {
  resetDbForTests();
  setHostZone('UTC');
});

test("an agent's limit counts everything this month, not just today", () => {
  capAgent('a', 10);
  spent('a', NOW - 15 * day, 6); // 5 October
  spent('a', NOW - 2 * day, 3); // 18 October
  assert.equal(overSpend('a', NOW), false, '$9 of $10');
  spent('a', NOW - 1 * day, 1.5);
  assert.equal(overSpend('a', NOW), true, '$10.50 of $10, with nothing spent today');
});

test("last month's spending doesn't count", () => {
  capAgent('a', 10);
  spent('a', NOW - 25 * day, 50); // 25 September
  assert.equal(overSpend('a', NOW), false);
});

test('the whole agency’s limit counts every agent this month', () => {
  capAgent('a', null);
  capAgent('b', null);
  setSetting('spend_cap_org_usd', 20);
  spent('a', NOW - 10 * day, 12);
  spent('b', NOW - 3 * day, 7);
  assert.equal(overSpend('a', NOW), false);
  spent('b', NOW - 1 * day, 2);
  assert.equal(overSpend('a', NOW), true, 'over for every agent');
  assert.equal(overSpend('b', NOW), true);
});
