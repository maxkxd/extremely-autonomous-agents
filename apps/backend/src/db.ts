// Our backend's database (docs/architecture.md, "Accounts and organisations"):
// the directory - who people are, their organisations, members, invites, and
// each organisation's host. Never agents, runs, keys or anything an agent
// touches: those stay on the host.
//
// Railway's Postgres in production (DATABASE_URL); without one, PGlite - real
// Postgres running inside Node - so tests and local development need no
// database server. Both answer the same SQL.

export type Db = {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  close(): Promise<void>;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,               -- the sign-in provider's user id (Clerk)
  email TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',     -- from the sign-in provider, kept current
  created_at BIGINT NOT NULL
);
-- The name they chose in the app (Settings > Account); shown instead of the provider's.
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;

-- personal: everyone's own agency, one each, for good, never shared.
-- team: an organisation, hosted on its owner's machine.
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL
);
-- One personal agency per person, and one organisation owned per person.
CREATE UNIQUE INDEX IF NOT EXISTS orgs_one_personal ON orgs(owner_id) WHERE kind = 'personal';
CREATE UNIQUE INDEX IF NOT EXISTS orgs_one_owned ON orgs(owner_id) WHERE kind = 'team';

CREATE TABLE IF NOT EXISTS members (
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  joined_at BIGINT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email TEXT,                        -- only this person may accept, when set
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_by TEXT REFERENCES users(id),
  used_at BIGINT
);

-- Where an organisation's agency runs: its host's public key (members' apps
-- set up an end-to-end encrypted session to it through our relay), and the
-- hash of the secret the host signs in to the relay with.
CREATE TABLE IF NOT EXISTS hosts (
  org_id TEXT PRIMARY KEY REFERENCES orgs(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  registered_at BIGINT NOT NULL,
  last_seen BIGINT
);
`;

export async function migrate(db: Db) {
  const sql = SCHEMA.replace(/--.*$/gm, '');
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.query(statement);
}

export async function connect(url = process.env.DATABASE_URL): Promise<Db> {
  if (url) {
    const { default: pg } = await import('pg');
    // SSL over the internet; not on this computer or Railway's private network (*.railway.internal),
    // or when the address says sslmode=disable.
    const plain = /localhost|127\.0\.0\.1|\.railway\.internal|sslmode=disable/.test(url);
    const pool = new pg.Pool({ connectionString: url, ssl: plain ? false : { rejectUnauthorized: false } });
    return { query: (sql, params) => pool.query(sql, params) as never, close: () => pool.end() };
  }
  // No database server: Postgres inside Node, in memory (tests) or in a folder (PGLITE_DIR).
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite(process.env.PGLITE_DIR);
  return { query: (sql, params) => lite.query(sql, params) as never, close: () => lite.close() };
}
