import bcrypt from "bcryptjs";
import { assignSystemRoleForLegacyRole } from "./access-control.js";
import { saveBrandName } from "./appearance.js";
import { saveSystemConfiguration, validAppBaseUrl, validTimeZone } from "./system-configuration.js";
import { userName, validUserNames } from "./user-names.js";

function text(value, maxLength = 180) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function integer(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

export async function isInitialSetupComplete(pool) {
  const [users, marker] = await Promise.all([
    pool.query("SELECT id FROM users LIMIT 1"),
    pool.query("SELECT value_json FROM system_preferences WHERE key = 'setup_completed'")
  ]);
  return users.rowCount > 0 || marker.rows[0]?.value_json?.completed === true;
}

export function setupDefaults(config, appBaseUrl) {
  return {
    company_name: config.companyName || "Tixaro",
    app_base_url: appBaseUrl || config.appBaseUrl,
    time_zone: config.timeZone || "Europe/Berlin",
    queue_name: "Allgemeiner Support",
    response_hours: "8",
    resolution_hours: "48",
    first_name: "",
    last_name: "",
    email: ""
  };
}

export function validateSetupInput(body) {
  const values = {
    companyName: text(body.company_name, 80),
    appBaseUrl: text(body.app_base_url, 255),
    timeZone: text(body.time_zone, 80),
    queueName: text(body.queue_name, 80),
    responseHours: integer(body.response_hours, 0),
    resolutionHours: integer(body.resolution_hours, 0),
    firstName: text(body.first_name, 80),
    lastName: text(body.last_name, 80),
    email: text(body.email, 255).toLowerCase(),
    password: String(body.password ?? ""),
    passwordConfirmation: String(body.password_confirmation ?? "")
  };
  const errors = [];
  if (values.companyName.length < 2) errors.push("Der Firmenname muss mindestens zwei Zeichen enthalten.");
  if (!validAppBaseUrl(values.appBaseUrl)) errors.push("Die öffentliche URL muss eine vollständige HTTP- oder HTTPS-Adresse ohne Unterpfad sein.");
  if (!validTimeZone(values.timeZone)) errors.push("Bitte wähle eine gültige Zeitzone.");
  if (values.queueName.length < 2) errors.push("Die zentrale Queue benötigt einen Namen.");
  if (values.responseHours < 1 || values.responseHours > 720) errors.push("Die Erstreaktionszeit muss zwischen 1 und 720 Stunden liegen.");
  if (values.resolutionHours < values.responseHours || values.resolutionHours > 8760) errors.push("Die Lösungszeit muss mindestens der Erstreaktionszeit entsprechen.");
  if (!validUserNames(values.firstName, values.lastName)) errors.push("Vor- und Nachname müssen jeweils mindestens zwei Zeichen enthalten.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.push("Bitte gib eine gültige E-Mail-Adresse für das Administratorkonto ein.");
  if (values.password.length < 12) errors.push("Das Administratorpasswort muss mindestens zwölf Zeichen enthalten.");
  if (values.password !== values.passwordConfirmation) errors.push("Die beiden Passwörter stimmen nicht überein.");
  return { values, errors };
}

export async function completeInitialSetup(pool, values) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const [existingUser, completed, duplicateQueue] = await Promise.all([
      client.query("SELECT id FROM users LIMIT 1"),
      client.query("SELECT value_json FROM system_preferences WHERE key = 'setup_completed'"),
      client.query("SELECT id FROM ticket_queues WHERE LOWER(name) = LOWER($1) AND name <> 'Allgemeiner Support'", [values.queueName])
    ]);
    if (existingUser.rowCount || completed.rows[0]?.value_json?.completed === true) throw new Error("Die Ersteinrichtung wurde bereits abgeschlossen.");
    if (duplicateQueue.rowCount) throw new Error("Der gewählte Queue-Name wird bereits verwendet.");

    const passwordHash = await bcrypt.hash(values.password, 12);
    const admin = await client.query(
      `INSERT INTO users (first_name, last_name, name, email, password_hash, role)
       VALUES ($1, $2, $3, $4, $5, 'admin') RETURNING id`,
      [values.firstName, values.lastName, userName(values.firstName, values.lastName), values.email, passwordHash]
    );
    await assignSystemRoleForLegacyRole(client, admin.rows[0].id, "admin");
    await saveBrandName(client, values.companyName);
    await saveSystemConfiguration(client, values);
    await client.query(
      "UPDATE sla_policies SET response_minutes = $1, resolution_minutes = $2, updated_at = NOW() WHERE code = 'standard'",
      [values.responseHours * 60, values.resolutionHours * 60]
    );
    const queue = await client.query(
      `UPDATE ticket_queues SET name = $1, description = 'Zentrale Eingangsqueue', default_sla_code = 'standard', updated_at = NOW()
       WHERE name = 'Allgemeiner Support' RETURNING id`,
      [values.queueName]
    );
    if (!queue.rowCount) {
      await client.query(
        "INSERT INTO ticket_queues (name, description, default_sla_code, sort_order) VALUES ($1, 'Zentrale Eingangsqueue', 'standard', 10)",
        [values.queueName]
      );
    }
    await client.query(
      `INSERT INTO system_preferences (key, value_json, updated_at) VALUES ('setup_completed', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
      [JSON.stringify({ completed: true, completedAt: new Date().toISOString(), version: "1.0.2" })]
    );
    await client.query("COMMIT");
    return admin.rows[0].id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createSetupState(pool) {
  let completed;
  return {
    async isComplete(refresh = false) {
      if (refresh || completed === undefined) completed = await isInitialSetupComplete(pool);
      return completed;
    },
    markComplete() {
      completed = true;
    },
    guard: async (req, res, next) => {
      if (req.path === "/health" || req.path === "/theme.css" || req.path === "/brand-logo" || req.path.startsWith("/setup")) return next();
      try {
        if (!await (completed === undefined ? isInitialSetupComplete(pool).then((value) => (completed = value)) : completed)) return res.redirect("/setup");
        next();
      } catch (error) {
        next(error);
      }
    }
  };
}
