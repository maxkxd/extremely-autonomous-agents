import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../paths.js';

// The runner's store (docs/runner.md): one SQLite file on the organisation's
// host. Everything about running agents lives here - their card state, runs,
// the actions they took, memory, DM posts, requests, tasks, approvals,
// bookings and spend. Agent definitions stay as files (files.ts).

const FILE = join(DATA_DIR, 'agency.db');

let db: DatabaseSync | null = null;

// path: ':memory:' for tests.
export function openDb(path = FILE): DatabaseSync {
  if (db) return db;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // Columns added after a store may already exist.
  for (const sql of [
    'ALTER TABLE approvals ADD COLUMN note TEXT',
    'ALTER TABLE approvals ADD COLUMN result TEXT',
    // Requests: where each stands (docs/requests.md) - engineer (the Agency Engineer
    // has it), waiting_you (it asked you something), approval (its go-live waits on
    // you), person (it handed it to you); null on ones from before routing.
    'ALTER TABLE requests ADD COLUMN stage TEXT',
    // A run booked again after a restart cut it short: the run it carries on.
    'ALTER TABLE bookings ADD COLUMN resume_from TEXT',
    // Who decided an approval and answered a request (access.ts): their name and id.
    'ALTER TABLE approvals ADD COLUMN decided_by TEXT',
    'ALTER TABLE approvals ADD COLUMN decided_by_id TEXT',
    'ALTER TABLE requests ADD COLUMN answered_by TEXT',
    'ALTER TABLE requests ADD COLUMN answered_by_id TEXT',
  ])
    try {
      db.exec(sql);
    } catch {
      // already there
    }
  return db;
}

// Tests start from a clean store.
export function resetDbForTests() {
  db?.close();
  db = null;
  return openDb(':memory:');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_state (
  agent_id TEXT PRIMARY KEY,
  ferocity INTEGER NOT NULL DEFAULT 0,          -- 0 Chill .. 4 Apocalyptic
  state TEXT NOT NULL DEFAULT 'active',         -- active | draining | stopped
  last_scheduled_at INTEGER,                    -- when its schedule last started a run (ms)
  fail_streak INTEGER NOT NULL DEFAULT 0,       -- runs failed in a row, for backoff
  backoff_until INTEGER,
  spend_cap_usd REAL,                           -- per-agent daily cap (null = none)
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  trigger TEXT NOT NULL,          -- scheduled | self-booked | apocalyptic | handoff | your message | approval
  task TEXT,                      -- what this run was asked to do (handoff task, your message, booking reason)
  ferocity INTEGER NOT NULL,
  status TEXT NOT NULL,           -- running | succeeded | failed
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  connection TEXT,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,                  -- null = unknown price
  acts INTEGER NOT NULL DEFAULT 0, -- output actions counted toward the floor
  floor INTEGER,
  nudges INTEGER NOT NULL DEFAULT 0,
  summary TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent_id, started_at);

CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,             -- server.tool
  fields TEXT NOT NULL,           -- JSON array of argument NAMES only
  tier TEXT NOT NULL,
  outcome TEXT NOT NULL,          -- ok | failed | queued | refused
  output INTEGER NOT NULL DEFAULT 0, -- how many output acts it counted for
  approval_id TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS actions_agent ON actions(agent_id, tool, at);

CREATE TABLE IF NOT EXISTS tool_health (
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  last_ok INTEGER,
  last_fail INTEGER,
  last_error TEXT,
  PRIMARY KEY (agent_id, tool)
);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note', -- note | compacted
  from_at INTEGER,                   -- compacted: the span it covers
  to_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_agent ON memories(agent_id, created_at);

CREATE TABLE IF NOT EXISTS dm (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL,             -- run | you
  run_id TEXT,
  body TEXT NOT NULL,             -- JSON
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dm_agent ON dm(agent_id, at);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  run_id TEXT,
  what TEXT NOT NULL,
  why TEXT NOT NULL,
  evidence TEXT,
  expected_effect TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | done | rejected
  answer TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  delivered_at INTEGER              -- when the agent was told the answer
);

-- A request's conversation: the agent's ask is the request itself; then the
-- Agency Engineer and the person (docs/requests.md).
CREATE TABLE IF NOT EXISTS request_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  from_who TEXT NOT NULL,           -- engineer | you
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,           -- who owes it
  from_agent TEXT,                  -- who handed it over (null: a person)
  task TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | done
  result TEXT,
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  delivered_at INTEGER              -- when the delegating agent was told the result
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,               -- JSON, exactly as the agent called it
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER                -- (+ note: the person's reason; result: what running it returned)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  trigger TEXT NOT NULL,            -- self-booked | handoff | your message | approval
  task TEXT,
  due_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_due ON bookings(agent_id, due_at);

-- Each person's own agency MCP address in an organisation (agency-mcp.ts):
-- it acts as them. role: as last checked, for the tools it lists.
CREATE TABLE IF NOT EXISTS mcp_people (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Who did what (access.ts): every change a person made through the app, and
-- what it was about (ids and choices, never keys or what they wrote).
CREATE TABLE IF NOT EXISTS person_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  actor_id TEXT NOT NULL,           -- local: the host computer's own person
  actor_name TEXT NOT NULL,
  role TEXT NOT NULL,               -- owner | admin | member
  via TEXT NOT NULL,                -- local | token
  route TEXT NOT NULL,              -- e.g. POST /api/runner/approvals/decide
  about TEXT                        -- JSON
);
CREATE INDEX IF NOT EXISTS person_actions_at ON person_actions(at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every item an event has seen (docs/events.md), so each wakes its agents once.
CREATE TABLE IF NOT EXISTS event_items (
  event_id TEXT NOT NULL,           -- server.event
  item_id TEXT NOT NULL,            -- the service's id for it
  source TEXT NOT NULL,             -- poll | webhook | baseline (seen when first polled: not told)
  summary TEXT NOT NULL,            -- JSON: what the agent was shown
  at INTEGER NOT NULL,
  PRIMARY KEY (event_id, item_id)
);
`;

// Small helpers so callers don't repeat prepare().
export const all = <T>(sql: string, ...args: (string | number | null)[]) => openDb().prepare(sql).all(...args) as T[];
export const one = <T>(sql: string, ...args: (string | number | null)[]) => openDb().prepare(sql).get(...args) as T | undefined;
export const run = (sql: string, ...args: (string | number | null)[]) => openDb().prepare(sql).run(...args);

export function getSetting<T>(key: string, fallback: T): T {
  const row = one<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return row ? (JSON.parse(row.value) as T) : fallback;
}
export const setSetting = (key: string, value: unknown) =>
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
