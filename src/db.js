import bcrypt from "bcryptjs";
import pg from "pg";

const { Pool } = pg;

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS user_sessions (
    sid VARCHAR NOT NULL PRIMARY KEY,
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_sessions_expire ON user_sessions(expire)`,
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'agent', 'requester')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS tickets (
    id SERIAL PRIMARY KEY,
    ticket_number VARCHAR(32) UNIQUE,
    subject VARCHAR(180) NOT NULL,
    description TEXT NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
    priority VARCHAR(16) NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    category VARCHAR(80) NOT NULL DEFAULT 'Allgemein',
    requester_id INTEGER NOT NULL REFERENCES users(id),
    assignee_id INTEGER REFERENCES users(id),
    due_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS comments (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    is_internal BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS activity_log (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER REFERENCES tickets(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id),
    action VARCHAR(80) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets(requester_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_updated ON tickets(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id, created_at)`
];

export async function createDatabase(config) {
  let pool;
  if (config.databaseUrl.startsWith("memory://")) {
    const { newDb } = await import("pg-mem");
    const memoryDb = newDb({ autoCreateForeignKeyIndices: true });
    memoryDb.public.registerFunction({ name: "current_database", returns: "text", implementation: () => "tixaro" });
    memoryDb.public.registerFunction({ name: "to_regclass", args: ["text"], returns: "text", implementation: () => "user_sessions" });
    memoryDb.public.registerFunction({
      name: "to_timestamp",
      args: ["text"],
      returns: "timestamp",
      implementation: (seconds) => new Date(Number(seconds) * 1000)
    });
    const adapter = memoryDb.adapters.createPg();
    pool = new adapter.Pool();
  } else {
    pool = new Pool({
      connectionString: config.databaseUrl,
      max: 12,
      ssl: config.databaseSsl ? { rejectUnauthorized: false } : false
    });
  }

  for (const statement of schemaStatements) {
    await pool.query(statement);
  }

  return pool;
}

export async function seedAdmin(pool, config) {
  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [config.adminEmail]);
  if (existing.rowCount > 0) return existing.rows[0].id;

  const passwordHash = await bcrypt.hash(config.adminPassword, 12);
  const result = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'admin') RETURNING id`,
    [config.adminName, config.adminEmail, passwordHash]
  );
  return result.rows[0].id;
}
