import express from "express";
import bcrypt from "bcryptjs";
import { requireAuth, requirePermission } from "../middleware.js";
import { setFlash } from "../security.js";
import { assignCustomerUser, autoAssignCustomerUser } from "../customer-assignment.js";
import { assignSystemRoleForLegacyRole, hasPermission } from "../access-control.js";
import { userName, userNamesFromBody, validUserNames } from "../user-names.js";

const roles = ["admin", "agent", "requester"];

function canGrantAdmin(user) {
  return hasPermission(user, "users.grant_admin");
}

function allowedRoles(user) {
  return canGrantAdmin(user) ? roles : roles.filter((role) => role !== "admin");
}

function deniedAdminManagement(res) {
  return res.status(403).render("error", {
    title: "Kein Zugriff",
    message: "Für Administratorkonten ist die Berechtigung „Administratoren ernennen“ erforderlich."
  });
}

function positiveInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function customerOptions(pool) {
  return pool.query("SELECT id, name, customer_number, domain FROM customers WHERE status <> 'inactive' ORDER BY name");
}

async function userList(pool) {
  const result = await pool.query(
    `SELECT u.id, u.first_name, u.last_name, u.name, u.email, u.role, u.active, u.last_login_at, u.created_at,
            c.name AS customer_name, COUNT(t.id)::int AS assigned_tickets
     FROM users u
     LEFT JOIN tickets t ON t.assignee_id = u.id AND t.status NOT IN ('resolved', 'closed')
     LEFT JOIN customer_profiles cp ON cp.user_id = u.id
     LEFT JOIN customers c ON c.id = cp.customer_id
     GROUP BY u.id, u.first_name, u.last_name, u.name, u.email, u.role, u.active, u.last_login_at, u.created_at, c.name
     ORDER BY u.active DESC, u.name ASC`
  );
  result.rows = result.rows.map((user) => ({ ...user, name: userName(user.first_name, user.last_name) }));
  return result;
}

export function usersRouter({ pool }) {
  const router = express.Router();

  router.post("/preview/stop", requireAuth, async (req, res) => {
    if (!req.session.originalUserId) return res.redirect(req.user.role === "requester" ? "/portal" : "/users");
    const original = await pool.query("SELECT id, session_version FROM users WHERE id = $1 AND active = TRUE AND role = 'admin'", [req.session.originalUserId]);
    if (!original.rowCount) {
      delete req.session.originalUserId;
      req.session.userId = null;
      setFlash(req, "error", "Die Admin-Ansicht konnte nicht wiederhergestellt werden.");
      return res.redirect("/login");
    }
    req.session.userId = original.rows[0].id;
    req.session.sessionVersion = original.rows[0].session_version;
    delete req.session.originalUserId;
    delete req.session.originalSessionVersion;
    setFlash(req, "success", "Du bist wieder in deiner Admin-Ansicht.");
    res.redirect("/users");
  });

  router.use(requirePermission("users.manage"));

  router.get("/", async (req, res) => {
    const [result, customers] = await Promise.all([userList(pool), customerOptions(pool)]);
    res.render("users/index", { title: "Benutzer", users: result.rows, customers: customers.rows, roleOptions: allowedRoles(req.user), error: null, values: {} });
  });

  router.post("/", async (req, res) => {
    const { firstName, lastName, name } = userNamesFromBody(req.body);
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "");
    if (req.body.role === "admin" && !canGrantAdmin(req.user)) return deniedAdminManagement(res);
    const roleOptions = allowedRoles(req.user);
    const role = roleOptions.includes(req.body.role) ? req.body.role : "requester";
    const customerId = positiveInt(req.body.customer_id);
    const [result, customers] = await Promise.all([userList(pool), customerOptions(pool)]);
    const selectedCustomer = customerId ? customers.rows.find((customer) => customer.id === customerId) : null;
    if (!validUserNames(firstName, lastName) || !email.includes("@") || password.length < 10 || (customerId && !selectedCustomer)) {
      return res.status(422).render("users/index", {
        title: "Benutzer",
        users: result.rows,
        customers: customers.rows,
        roleOptions,
        error: customerId && !selectedCustomer ? "Der ausgewählte Kunde existiert nicht oder ist inaktiv."
          : "Vorname, Nachname und E-Mail-Adresse sind erforderlich; das Passwort muss mindestens 10 Zeichen haben.",
        values: req.body
      });
    }
    const duplicate = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (duplicate.rowCount) {
      return res.status(409).render("users/index", { title: "Benutzer", users: result.rows, customers: customers.rows, roleOptions, error: "Diese E-Mail-Adresse wird bereits verwendet.", values: req.body });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const client = await pool.connect();
    let assignment = { assigned: false };
    try {
      await client.query("BEGIN");
      const user = await client.query(
        "INSERT INTO users (first_name, last_name, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
        [firstName, lastName, name, email, passwordHash, role]
      );
      await assignSystemRoleForLegacyRole(client, user.rows[0].id, role);
      if (selectedCustomer) {
        await assignCustomerUser(client, { userId: user.rows[0].id, customerId: selectedCustomer.id });
        assignment = { assigned: true, customer: selectedCustomer };
      } else {
        assignment = await autoAssignCustomerUser(client, { userId: user.rows[0].id, email });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    setFlash(req, "success", assignment.assigned ? `${name} wurde angelegt und „${assignment.customer.name}“ zugeordnet.` : `${name} wurde angelegt.`);
    res.redirect("/users");
  });

  router.get("/:id/edit", async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const [result, customers] = await Promise.all([
      pool.query(
        `SELECT u.id, u.first_name, u.last_name, u.name, u.email, u.role, u.active,
                cp.customer_id, c.name AS customer_name
         FROM users u LEFT JOIN customer_profiles cp ON cp.user_id = u.id
         LEFT JOIN customers c ON c.id = cp.customer_id WHERE u.id = $1`,
        [id]
      ),
      customerOptions(pool)
    ]);
    if (!result.rowCount) return res.status(404).render("error", { title: "Benutzer nicht gefunden", message: "Das Benutzerkonto existiert nicht." });
    if (result.rows[0].role === "admin" && !canGrantAdmin(req.user)) return deniedAdminManagement(res);
    res.render("users/edit", { title: "Benutzer bearbeiten", editedUser: result.rows[0], roles: allowedRoles(req.user), customers: customers.rows, error: null, values: result.rows[0] });
  });

  router.post("/:id/preview", async (req, res) => {
    if (!canGrantAdmin(req.user)) {
      return res.status(403).render("error", { title: "Kein Zugriff", message: "Nur Administratoren können eine Portalvorschau starten." });
    }
    const id = Number.parseInt(req.params.id, 10);
    const target = await pool.query(
      "SELECT id, name, email, session_version FROM users WHERE id = $1 AND active = TRUE AND role = 'requester'",
      [id]
    );
    if (!target.rowCount) {
      setFlash(req, "error", "Die Portalvorschau ist nur für aktive Kundenbenutzer verfügbar.");
      return res.redirect(`/users/${id}/edit`);
    }
    req.session.originalUserId = req.user.id;
    req.session.originalSessionVersion = req.session.sessionVersion;
    req.session.userId = target.rows[0].id;
    req.session.sessionVersion = target.rows[0].session_version;
    await pool.query(
      "INSERT INTO activity_log (actor_id, action, details) VALUES ($1, 'portal_preview_started', $2)",
      [req.user.id, JSON.stringify({ previewedUserId: target.rows[0].id, previewedEmail: target.rows[0].email })]
    );
    res.redirect("/portal");
  });

  router.post("/:id/update", async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    const existingResult = await pool.query(
      `SELECT u.*, cp.customer_id, c.name AS customer_name
       FROM users u LEFT JOIN customer_profiles cp ON cp.user_id = u.id
       LEFT JOIN customers c ON c.id = cp.customer_id WHERE u.id = $1`,
      [id]
    );
    if (!existingResult.rowCount) return res.status(404).render("error", { title: "Benutzer nicht gefunden", message: "Das Benutzerkonto existiert nicht." });
    const existing = existingResult.rows[0];
    if (existing.role === "admin" && !canGrantAdmin(req.user)) return deniedAdminManagement(res);
    const { firstName, lastName, name } = userNamesFromBody(req.body);
    const email = String(req.body.email ?? "").trim().toLowerCase();
    if (req.body.role === "admin" && !canGrantAdmin(req.user)) return deniedAdminManagement(res);
    const roleOptions = allowedRoles(req.user);
    const role = id === req.user.id ? existing.role : (roleOptions.includes(req.body.role) ? req.body.role : existing.role);
    const password = String(req.body.password ?? "");
    const customerId = positiveInt(req.body.customer_id);
    const customers = await customerOptions(pool);
    const selectedCustomer = customerId ? customers.rows.find((customer) => customer.id === customerId) : null;
    const duplicate = await pool.query("SELECT id FROM users WHERE email = $1 AND id <> $2", [email, id]);
    const error = !validUserNames(firstName, lastName) ? "Vor- und Nachname müssen jeweils mindestens zwei Zeichen enthalten."
      : !email.includes("@") ? "Bitte gib eine gültige E-Mail-Adresse ein."
        : password && password.length < 10 ? "Das neue Passwort muss mindestens 10 Zeichen enthalten."
          : duplicate.rowCount ? "Diese E-Mail-Adresse wird bereits verwendet."
            : customerId && !selectedCustomer ? "Der ausgewählte Kunde existiert nicht oder ist inaktiv." : null;
    if (error) {
      return res.status(422).render("users/edit", {
        title: "Benutzer bearbeiten", editedUser: existing, roles: roleOptions, customers: customers.rows, error, values: { ...existing, ...req.body }
      });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const passwordHash = password ? await bcrypt.hash(password, 12) : existing.password_hash;
      const sessionMustChange = Boolean(password) || role !== existing.role;
      const updated = await client.query(
        `UPDATE users SET first_name = $1, last_name = $2, name = $3, email = $4, role = $5,
         password_hash = $6, session_version = session_version + $7, updated_at = NOW() WHERE id = $8 RETURNING session_version`,
        [firstName, lastName, name, email, role, passwordHash, sessionMustChange ? 1 : 0, id]
      );
      if (role !== existing.role) {
        await client.query(
          "DELETE FROM user_access_roles WHERE user_id = $1 AND role_id IN (SELECT id FROM access_roles WHERE code = $2 AND system_role = TRUE)",
          [id, existing.role]
        );
        await assignSystemRoleForLegacyRole(client, id, role);
      }
      if (selectedCustomer) {
        await assignCustomerUser(client, { userId: id, customerId: selectedCustomer.id });
      } else {
        await client.query("DELETE FROM customer_profiles WHERE user_id = $1", [id]);
        await autoAssignCustomerUser(client, { userId: id, email });
      }
      await client.query("COMMIT");
      if (id === req.user.id) req.session.sessionVersion = updated.rows[0].session_version;
    } catch (updateError) {
      await client.query("ROLLBACK");
      throw updateError;
    } finally {
      client.release();
    }
    setFlash(req, "success", `${name} wurde aktualisiert.`);
    res.redirect("/users");
  });

  router.post("/:id/toggle", async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (id === req.user.id) {
      setFlash(req, "error", "Du kannst dein eigenes Konto nicht deaktivieren.");
      return res.redirect("/users");
    }
    const target = await pool.query("SELECT role FROM users WHERE id = $1", [id]);
    if (!target.rowCount) return res.status(404).render("error", { title: "Benutzer nicht gefunden", message: "Das Benutzerkonto existiert nicht." });
    if (target.rows[0].role === "admin" && !canGrantAdmin(req.user)) return deniedAdminManagement(res);
    await pool.query("UPDATE users SET active = NOT active, session_version = session_version + 1, updated_at = NOW() WHERE id = $1", [id]);
    setFlash(req, "success", "Kontostatus wurde geändert.");
    res.redirect("/users");
  });

  return router;
}
