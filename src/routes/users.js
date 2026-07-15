import express from "express";
import bcrypt from "bcryptjs";
import { requireRole } from "../middleware.js";
import { setFlash } from "../security.js";

const roles = ["admin", "agent", "requester"];

export function usersRouter({ pool }) {
  const router = express.Router();
  router.use(requireRole("admin"));

  router.get("/", async (_req, res) => {
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.last_login_at, u.created_at,
              COUNT(t.id)::int AS assigned_tickets
       FROM users u LEFT JOIN tickets t ON t.assignee_id = u.id AND t.status NOT IN ('resolved', 'closed')
       GROUP BY u.id, u.name, u.email, u.role, u.active, u.last_login_at, u.created_at
       ORDER BY u.active DESC, u.name ASC`
    );
    res.render("users/index", { title: "Benutzerverwaltung", users: result.rows, error: null, values: {} });
  });

  router.post("/", async (req, res) => {
    const name = String(req.body.name ?? "").trim();
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "");
    const role = roles.includes(req.body.role) ? req.body.role : "requester";
    if (name.length < 2 || !email.includes("@") || password.length < 10) {
      const result = await pool.query("SELECT *, 0 AS assigned_tickets FROM users ORDER BY active DESC, name ASC");
      return res.status(422).render("users/index", {
        title: "Benutzerverwaltung",
        users: result.rows,
        error: "Name und E-Mail-Adresse sind erforderlich; das Passwort muss mindestens 10 Zeichen haben.",
        values: req.body
      });
    }
    const duplicate = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (duplicate.rowCount) {
      const result = await pool.query("SELECT *, 0 AS assigned_tickets FROM users ORDER BY active DESC, name ASC");
      return res.status(409).render("users/index", { title: "Benutzerverwaltung", users: result.rows, error: "Diese E-Mail-Adresse wird bereits verwendet.", values: req.body });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query("INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)", [name, email, passwordHash, role]);
    setFlash(req, "success", `${name} wurde angelegt.`);
    res.redirect("/users");
  });

  router.post("/:id/toggle", async (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (id === req.user.id) {
      setFlash(req, "error", "Du kannst dein eigenes Konto nicht deaktivieren.");
      return res.redirect("/users");
    }
    await pool.query("UPDATE users SET active = NOT active, updated_at = NOW() WHERE id = $1", [id]);
    setFlash(req, "success", "Kontostatus wurde geändert.");
    res.redirect("/users");
  });

  return router;
}
