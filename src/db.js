import bcrypt from "bcryptjs";
import pg from "pg";
import { backfillCustomerUsers, migrateCustomerDomains } from "./customer-assignment.js";
import { assignSystemRoleForLegacyRole, syncAccessControl } from "./access-control.js";
import { splitUserName, userName } from "./user-names.js";

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
    first_name VARCHAR(80) NOT NULL DEFAULT 'Unbekannt',
    last_name VARCHAR(80) NOT NULL DEFAULT 'Konto',
    name VARCHAR(120) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'agent', 'requester')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    session_version INTEGER NOT NULL DEFAULT 1,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS permission_definitions (
    code VARCHAR(80) PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    description TEXT,
    category VARCHAR(80) NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 100
  )`,
  `CREATE TABLE IF NOT EXISTS access_roles (
    id SERIAL PRIMARY KEY,
    code VARCHAR(80) NOT NULL UNIQUE,
    name VARCHAR(120) NOT NULL UNIQUE,
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    system_role BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS role_permissions (
    role_id INTEGER NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE,
    permission_code VARCHAR(80) NOT NULL REFERENCES permission_definitions(code) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_code)
  )`,
  `CREATE TABLE IF NOT EXISTS user_access_roles (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
  )`,
  `CREATE TABLE IF NOT EXISTS access_groups (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE,
    description TEXT,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS group_members (
    group_id INTEGER NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  )`,
  `CREATE TABLE IF NOT EXISTS group_access_roles (
    group_id INTEGER NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
    role_id INTEGER NOT NULL REFERENCES access_roles(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, role_id)
  )`,
  `CREATE TABLE IF NOT EXISTS customers (
    id SERIAL PRIMARY KEY,
    customer_number VARCHAR(32) NOT NULL UNIQUE,
    name VARCHAR(180) NOT NULL,
    industry VARCHAR(120),
    domain VARCHAR(255),
    email VARCHAR(255),
    phone VARCHAR(80),
    website VARCHAR(255),
    address TEXT,
    city VARCHAR(120),
    latitude NUMERIC(9,6),
    longitude NUMERIC(9,6),
    notes TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'prospect', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS customer_profiles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    job_title VARCHAR(120),
    department VARCHAR(120),
    phone VARCHAR(80),
    site VARCHAR(120),
    preferred_language VARCHAR(12) NOT NULL DEFAULT 'de',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS sla_policies (
    id SERIAL PRIMARY KEY,
    code VARCHAR(32) NOT NULL UNIQUE,
    name VARCHAR(80) NOT NULL UNIQUE,
    response_minutes INTEGER NOT NULL CHECK (response_minutes > 0),
    resolution_minutes INTEGER NOT NULL CHECK (resolution_minutes >= response_minutes),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS ticket_queues (
    id SERIAL PRIMARY KEY,
    name VARCHAR(80) NOT NULL UNIQUE,
    parent_id INTEGER REFERENCES ticket_queues(id) ON DELETE SET NULL,
    description TEXT,
    default_sla_code VARCHAR(32) REFERENCES sla_policies(code) ON DELETE SET NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS ticket_type_options (
    id SERIAL PRIMARY KEY,
    name VARCHAR(80) NOT NULL UNIQUE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS group_queue_permissions (
    group_id INTEGER NOT NULL REFERENCES access_groups(id) ON DELETE CASCADE,
    queue_id INTEGER NOT NULL REFERENCES ticket_queues(id) ON DELETE CASCADE,
    permission_level VARCHAR(12) NOT NULL CHECK (permission_level IN ('read', 'write')),
    PRIMARY KEY (group_id, queue_id)
  )`,
  `CREATE TABLE IF NOT EXISTS system_preferences (
    key VARCHAR(80) PRIMARY KEY,
    value_json JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS response_templates (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE,
    template_type VARCHAR(20) NOT NULL CHECK (template_type IN ('reply', 'signature', 'auto_reply')),
    subject VARCHAR(180),
    body TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS asset_type_options (
    id SERIAL PRIMARY KEY,
    name VARCHAR(80) NOT NULL UNIQUE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order INTEGER NOT NULL DEFAULT 100,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS assets (
    id SERIAL PRIMARY KEY,
    asset_number VARCHAR(32) NOT NULL UNIQUE,
    asset_type VARCHAR(80) NOT NULL,
    name VARCHAR(180) NOT NULL,
    status VARCHAR(24) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stock', 'repair', 'retired', 'lost')),
    manufacturer VARCHAR(120),
    model VARCHAR(120),
    serial_number VARCHAR(160),
    operating_system VARCHAR(160),
    location VARCHAR(160),
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    purchase_date DATE,
    warranty_until DATE,
    notes TEXT,
    attributes JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS asset_assignment_history (
    id SERIAL PRIMARY KEY,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    assigned_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    location VARCHAR(160),
    asset_status VARCHAR(24) NOT NULL CHECK (asset_status IN ('active', 'stock', 'repair', 'retired', 'lost')),
    valid_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    valid_until TIMESTAMPTZ,
    changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS mail_channels (
    id SERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE,
    email_address VARCHAR(255) NOT NULL,
    queue_id INTEGER REFERENCES ticket_queues(id) ON DELETE SET NULL,
    inbound_type VARCHAR(12) NOT NULL DEFAULT 'none' CHECK (inbound_type IN ('none', 'imap', 'pop3', 'graph')),
    outbound_type VARCHAR(12) NOT NULL DEFAULT 'none' CHECK (outbound_type IN ('none', 'smtp', 'graph')),
    inbound_host VARCHAR(255),
    inbound_port INTEGER,
    inbound_secure BOOLEAN NOT NULL DEFAULT TRUE,
    inbound_username VARCHAR(255),
    inbound_secret TEXT,
    outbound_host VARCHAR(255),
    outbound_port INTEGER,
    outbound_secure BOOLEAN NOT NULL DEFAULT FALSE,
    outbound_username VARCHAR(255),
    outbound_secret TEXT,
    graph_tenant_id VARCHAR(120),
    graph_client_id VARCHAR(120),
    graph_client_secret TEXT,
    graph_mailbox VARCHAR(255),
    poll_interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK (poll_interval_minutes BETWEEN 1 AND 1440),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    last_checked_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error TEXT,
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
    ticket_type VARCHAR(40) NOT NULL DEFAULT 'Anfrage',
    channel VARCHAR(24) NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'portal', 'email', 'phone_outbound', 'phone_inbound')),
    sla VARCHAR(24) NOT NULL DEFAULT 'standard',
    response_due_at TIMESTAMPTZ,
    resolution_due_at TIMESTAMPTZ,
    first_response_at TIMESTAMPTZ,
    sla_paused_at TIMESTAMPTZ,
    billed_ticks INTEGER NOT NULL DEFAULT 0 CHECK (billed_ticks >= 0),
    requester_id INTEGER NOT NULL REFERENCES users(id),
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
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
    work_minutes INTEGER NOT NULL DEFAULT 0 CHECK (work_minutes >= 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS mail_events (
    id SERIAL PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES mail_channels(id) ON DELETE CASCADE,
    ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
    direction VARCHAR(12) NOT NULL CHECK (direction IN ('inbound', 'outbound')),
    external_id VARCHAR(512) NOT NULL,
    internet_message_id VARCHAR(512),
    sender VARCHAR(255),
    recipients TEXT,
    subject TEXT,
    status VARCHAR(20) NOT NULL CHECK (status IN ('imported', 'sent', 'failed', 'skipped')),
    error TEXT,
    received_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (channel_id, direction, external_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ticket_assets (
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    is_primary BOOLEAN NOT NULL DEFAULT FALSE,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (ticket_id, asset_id)
  )`,
  `CREATE TABLE IF NOT EXISTS ticket_work_logs (
    id SERIAL PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL REFERENCES users(id),
    description TEXT NOT NULL,
    ticks INTEGER NOT NULL CHECK (ticks <> 0 AND ticks BETWEEN -32 AND 32),
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
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_type VARCHAR(40) NOT NULL DEFAULT 'Anfrage'`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS channel VARCHAR(24) NOT NULL DEFAULT 'web'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(80) NOT NULL DEFAULT 'Unbekannt'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(80) NOT NULL DEFAULT 'Konto'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS session_version INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla VARCHAR(24) NOT NULL DEFAULT 'standard'`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS response_due_at TIMESTAMPTZ`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolution_due_at TIMESTAMPTZ`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_response_at TIMESTAMPTZ`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS sla_paused_at TIMESTAMPTZ`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS billed_ticks INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE tickets ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL`,
  `ALTER TABLE comments ADD COLUMN IF NOT EXISTS work_minutes INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS latitude NUMERIC(9,6)`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS longitude NUMERIC(9,6)`,
  `ALTER TABLE customers ADD COLUMN IF NOT EXISTS domain VARCHAR(255)`,
  `UPDATE tickets SET category = 'Allgemeiner Support' WHERE category = 'Allgemein'`,
  `UPDATE tickets SET response_due_at = created_at + INTERVAL '8 hours' WHERE response_due_at IS NULL`,
  `UPDATE tickets SET resolution_due_at = created_at + INTERVAL '48 hours' WHERE resolution_due_at IS NULL`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_queue ON tickets(category)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_sla_response ON tickets(response_due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_sla_resolution ON tickets(resolution_due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets(requester_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_customer ON tickets(customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_tickets_updated ON tickets(updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_comments_ticket ON comments(ticket_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_work_logs_ticket ON ticket_work_logs(ticket_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_profiles_customer ON customer_profiles(customer_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_domain_unique ON customers(domain)`,
  `CREATE INDEX IF NOT EXISTS idx_assets_customer ON assets(customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assets_assigned_user ON assets(assigned_user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_history_asset ON asset_assignment_history(asset_id, valid_from DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_asset_history_period ON asset_assignment_history(valid_from, valid_until)`,
  `CREATE INDEX IF NOT EXISTS idx_mail_channels_due ON mail_channels(active, last_checked_at)`,
  `CREATE INDEX IF NOT EXISTS idx_mail_events_ticket ON mail_events(ticket_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ticket_assets_asset ON ticket_assets(asset_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ticket_queues_parent ON ticket_queues(parent_id)`,
  `INSERT INTO asset_assignment_history (asset_id, customer_id, assigned_user_id, location, asset_status, valid_from)
   SELECT a.id, a.customer_id, a.assigned_user_id, a.location, a.status, a.created_at
   FROM assets a
   LEFT JOIN asset_assignment_history h ON h.asset_id = a.id
   WHERE h.id IS NULL`
];

const configurationSeedStatements = [
  `INSERT INTO sla_policies (code, name, response_minutes, resolution_minutes, sort_order) VALUES
    ('standard', 'Standard', 480, 2880, 10),
    ('priority', 'Priorität', 240, 1440, 20),
    ('critical', 'Kritisch', 60, 480, 30)
   ON CONFLICT (code) DO NOTHING`,
  `INSERT INTO ticket_queues (name, description, default_sla_code, sort_order) VALUES
    ('Allgemeiner Support', 'Allgemeine Anfragen und Erstaufnahme', 'standard', 10),
    ('Managed IT-Service', 'Laufende Managed-Service-Leistungen', 'standard', 20),
    ('Arbeitsplätze & Geräte', 'Clients, Peripherie und mobile Geräte', 'priority', 30),
    ('Microsoft 365 & Cloud', 'Microsoft 365 und Cloud-Dienste', 'standard', 40),
    ('Netzwerk', 'LAN, WLAN, VPN und Standortverbindungen', 'priority', 50),
    ('IT-Sicherheit', 'Sicherheitsvorfälle und Schutzmaßnahmen', 'critical', 60)
   ON CONFLICT (name) DO NOTHING`,
  `INSERT INTO ticket_type_options (name, sort_order) VALUES
    ('Anfrage', 10), ('Störung', 20), ('Serviceauftrag', 30), ('Änderung', 40)
   ON CONFLICT (name) DO NOTHING`,
  `INSERT INTO asset_type_options (name, sort_order) VALUES
    ('Computer', 10), ('Notebook', 20), ('Monitor', 30), ('Smartphone', 40), ('Drucker', 50),
    ('Server', 60), ('Netzwerkgerät', 70), ('Softwarelizenz', 80), ('Arbeitsplatz', 90), ('Sonstiges', 100)
   ON CONFLICT (name) DO NOTHING`,
  `INSERT INTO response_templates (name, template_type, subject, body, sort_order) VALUES
    ('Eingangsbestätigung', 'auto_reply', '[{{ticket.number}}] Anfrage eingegangen', 'Guten Tag {{requester.first_name}},\n\nwir haben Ihre Anfrage {{ticket.number}} erhalten und kümmern uns darum.\n\nFreundliche Grüße\n{{company.name}}', 10),
    ('Weitere Informationen benötigt', 'reply', NULL, 'Guten Tag {{requester.first_name}},\n\nfür die weitere Bearbeitung benötigen wir noch folgende Informationen:\n\n- betroffener Benutzer oder Arbeitsplatz\n- genaue Fehlermeldung\n- Zeitpunkt des Auftretens\n\nFreundliche Grüße', 20),
    ('Standardsignatur', 'signature', NULL, 'Freundliche Grüße\n{{agent.first_name}} {{agent.last_name}}\n{{company.name}}', 100)
   ON CONFLICT (name) DO NOTHING`,
  `INSERT INTO ticket_queues (name, description, default_sla_code, sort_order)
   SELECT DISTINCT category, 'Aus bestehenden Tickets übernommen', 'standard', 900
   FROM tickets WHERE category IS NOT NULL AND category <> ''
   ON CONFLICT (name) DO NOTHING`,
  `INSERT INTO ticket_type_options (name, sort_order)
   SELECT DISTINCT ticket_type, 900 FROM tickets WHERE ticket_type IS NOT NULL AND ticket_type <> ''
   ON CONFLICT (name) DO NOTHING`,
  `INSERT INTO asset_type_options (name, sort_order)
   SELECT DISTINCT asset_type, 900 FROM assets WHERE asset_type IS NOT NULL AND asset_type <> ''
   ON CONFLICT (name) DO NOTHING`
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
  const existingUsers = await pool.query("SELECT id, first_name, last_name, name FROM users");
  for (const user of existingUsers.rows) {
    const needsSplit = !String(user.first_name ?? "").trim() || !String(user.last_name ?? "").trim()
      || user.first_name === "Unbekannt" || user.last_name === "Konto";
    const names = needsSplit ? splitUserName(user.name) : { firstName: user.first_name, lastName: user.last_name };
    await pool.query(
      "UPDATE users SET first_name = $1, last_name = $2, name = $3 WHERE id = $4",
      [names.firstName, names.lastName, userName(names.firstName, names.lastName), user.id]
    );
  }
  for (const statement of configurationSeedStatements) {
    await pool.query(statement);
  }
  await migrateCustomerDomains(pool);
  await syncAccessControl(pool);
  await backfillCustomerUsers(pool);

  return pool;
}

export async function seedAdmin(pool, config) {
  if (!config.adminPassword || config.adminPassword.length < 10) throw new Error("Für das automatische Administratorkonto wird ein sicheres Passwort benötigt.");
  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [config.adminEmail]);
  if (existing.rowCount > 0) {
    await assignSystemRoleForLegacyRole(pool, existing.rows[0].id, "admin");
    return existing.rows[0].id;
  }

  const passwordHash = await bcrypt.hash(config.adminPassword, 12);
  const { firstName, lastName } = splitUserName(config.adminName);
  const result = await pool.query(
    `INSERT INTO users (first_name, last_name, name, email, password_hash, role)
     VALUES ($1, $2, $3, $4, $5, 'admin') RETURNING id`,
    [firstName, lastName, userName(firstName, lastName), config.adminEmail, passwordHash]
  );
  await assignSystemRoleForLegacyRole(pool, result.rows[0].id, "admin");
  return result.rows[0].id;
}
