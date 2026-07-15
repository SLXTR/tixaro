export const permissionDefinitions = [
  ["dashboard.view", "Dashboard anzeigen", "Kennzahlen und Arbeitsvorrat öffnen", "Allgemein", 10],
  ["statistics.view", "Statistiken anzeigen", "Kundenkarte, Kennzahlen und historische Bestände öffnen", "Allgemein", 15],
  ["tickets.view_own", "Eigene Tickets anzeigen", "Selbst erstellte Tickets und Antworten lesen", "Tickets", 20],
  ["tickets.view_all", "Alle Tickets anzeigen", "Tickets unabhängig von Queue und Ersteller lesen", "Tickets", 30],
  ["tickets.create", "Tickets anlegen", "Neue Tickets für sich oder andere erfassen", "Tickets", 40],
  ["tickets.manage", "Tickets bearbeiten", "Status, Priorität, Queue, SLA und Zuweisung ändern", "Tickets", 50],
  ["tickets.comment", "Antworten verfassen", "Öffentliche Antworten an Tickets schreiben", "Tickets", 60],
  ["tickets.internal", "Interne Notizen", "Interne Notizen und Aktivitätsverlauf sehen", "Tickets", 70],
  ["tickets.worklog", "Leistung erfassen", "Arbeitstakte buchen und korrigieren", "Tickets", 80],
  ["customers.view", "CRM anzeigen", "Kunden, Kontakte und Kundenhistorie lesen", "CRM & Ressourcen", 90],
  ["customers.manage", "CRM verwalten", "Kunden und Kontakte anlegen und bearbeiten", "CRM & Ressourcen", 100],
  ["assets.view", "Ressourcen anzeigen", "Inventar und zugeordnete Geräte lesen", "CRM & Ressourcen", 110],
  ["assets.manage", "Ressourcen verwalten", "Inventar anlegen, zuordnen und bearbeiten", "CRM & Ressourcen", 120],
  ["users.manage", "Benutzer verwalten", "Konten anlegen, bearbeiten, aktivieren und deaktivieren", "Administration", 130],
  ["users.grant_admin", "Administratoren ernennen", "Administratorkonten anlegen, ändern und deaktivieren", "Administration", 135],
  ["settings.manage", "Systemeinstellungen", "Queues, Nummernkreise, Vorlagen, Updates und Stammdaten verwalten", "Administration", 140],
  ["roles.manage", "Rollen verwalten", "Rollen und deren Berechtigungen konfigurieren", "Administration", 150],
  ["groups.manage", "Gruppen verwalten", "Mitgliedschaften, Rollen und Queue-Zugriffe konfigurieren", "Administration", 160],
  ["appearance.manage", "Erscheinungsbild", "Firmenname, Logo und Farben anpassen", "Administration", 170]
];

const systemRoles = [
  {
    code: "admin",
    name: "Administrator",
    description: "Vollzugriff auf Administration, Stammdaten und alle Tickets.",
    permissions: permissionDefinitions.map(([code]) => code)
  },
  {
    code: "agent",
    name: "Service-Mitarbeiter",
    description: "Operativer Vollzugriff auf Tickets, CRM und Ressourcen.",
    permissions: [
      "dashboard.view", "statistics.view", "tickets.view_all", "tickets.create", "tickets.manage", "tickets.comment",
      "tickets.internal", "tickets.worklog", "customers.view", "customers.manage", "assets.view", "assets.manage"
    ]
  },
  {
    code: "requester",
    name: "Kundenbenutzer",
    description: "Portalzugriff auf eigene Tickets und zugeordnete Ressourcen.",
    permissions: ["dashboard.view", "tickets.view_own", "tickets.create", "tickets.comment", "assets.view"]
  }
];

export function hasPermission(user, permission) {
  return Boolean(user?.permissions?.includes(permission));
}

export function queuePermission(user, queueName) {
  return user?.queuePermissions?.[queueName] ?? null;
}

export function canAccessQueue(user, queueName, required = "read") {
  if (hasPermission(user, "tickets.view_all")) return true;
  const level = queuePermission(user, queueName);
  if (required === "read") return level === "read" || level === "write";
  return level === "write";
}

export async function assignSystemRoleForLegacyRole(client, userId, legacyRole) {
  const role = await client.query("SELECT id FROM access_roles WHERE code = $1", [legacyRole]);
  if (!role.rowCount) return;
  await client.query(
    `INSERT INTO user_access_roles (user_id, role_id) VALUES ($1, $2)
     ON CONFLICT (user_id, role_id) DO NOTHING`,
    [userId, role.rows[0].id]
  );
}

export async function syncAccessControl(pool) {
  for (const [code, name, description, category, sortOrder] of permissionDefinitions) {
    await pool.query(
      `INSERT INTO permission_definitions (code, name, description, category, sort_order)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
         category = EXCLUDED.category, sort_order = EXCLUDED.sort_order`,
      [code, name, description, category, sortOrder]
    );
  }
  for (const role of systemRoles) {
    const stored = await pool.query(
      `INSERT INTO access_roles (code, name, description, system_role)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description,
         system_role = TRUE, active = TRUE RETURNING id`,
      [role.code, role.name, role.description]
    );
    for (const permission of role.permissions) {
      await pool.query(
        `INSERT INTO role_permissions (role_id, permission_code) VALUES ($1, $2)
         ON CONFLICT (role_id, permission_code) DO NOTHING`,
        [stored.rows[0].id, permission]
      );
    }
  }
  const users = await pool.query("SELECT id, role FROM users");
  for (const user of users.rows) await assignSystemRoleForLegacyRole(pool, user.id, user.role);
}

export async function loadAccessContext(client, userId) {
  const [roles, groups, permissions, queuePermissions] = await Promise.all([
    client.query(
      `SELECT DISTINCT r.id, r.code, r.name, r.system_role
       FROM access_roles r
       LEFT JOIN user_access_roles ur ON ur.role_id = r.id
       LEFT JOIN group_access_roles gr ON gr.role_id = r.id
       LEFT JOIN group_members gm ON gm.group_id = gr.group_id
       LEFT JOIN access_groups g ON g.id = gm.group_id
       WHERE r.active = TRUE AND (ur.user_id = $1 OR (gm.user_id = $1 AND g.active = TRUE))
       ORDER BY r.name`,
      [userId]
    ),
    client.query(
      `SELECT g.id, g.name FROM access_groups g
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1 AND g.active = TRUE ORDER BY g.name`,
      [userId]
    ),
    client.query(
      `SELECT DISTINCT rp.permission_code
       FROM role_permissions rp
       JOIN access_roles r ON r.id = rp.role_id AND r.active = TRUE
       LEFT JOIN user_access_roles ur ON ur.role_id = r.id
       LEFT JOIN group_access_roles gr ON gr.role_id = r.id
       LEFT JOIN group_members gm ON gm.group_id = gr.group_id
       LEFT JOIN access_groups g ON g.id = gm.group_id
       WHERE ur.user_id = $1 OR (gm.user_id = $1 AND g.active = TRUE)`,
      [userId]
    ),
    client.query(
      `SELECT q.name, MAX(CASE WHEN gqp.permission_level = 'write' THEN 2 ELSE 1 END)::int AS access_rank
       FROM group_queue_permissions gqp
       JOIN ticket_queues q ON q.id = gqp.queue_id
       JOIN access_groups g ON g.id = gqp.group_id AND g.active = TRUE
       JOIN group_members gm ON gm.group_id = g.id
       WHERE gm.user_id = $1
       GROUP BY q.name`,
      [userId]
    )
  ]);
  return {
    accessRoles: roles.rows,
    accessGroups: groups.rows,
    permissions: permissions.rows.map((row) => row.permission_code),
    queuePermissions: Object.fromEntries(queuePermissions.rows.map((row) => [row.name, Number(row.access_rank) === 2 ? "write" : "read"]))
  };
}
