import express from "express";
import bcrypt from "bcryptjs";
import { requireAuth } from "../middleware.js";
import { setFlash } from "../security.js";

export function accountRouter({ pool }) {
  const router = express.Router();
  router.use(requireAuth);

  router.get("/", (req, res) => res.render("account", { title: "Mein Konto", error: null }));

  router.post("/profile", async (req, res) => {
    const name = String(req.body.name ?? "").trim();
    if (name.length < 2) return res.status(422).render("account", { title: "Mein Konto", error: "Bitte gib einen gültigen Namen ein." });
    await pool.query("UPDATE users SET name = $1, updated_at = NOW() WHERE id = $2", [name, req.user.id]);
    setFlash(req, "success", "Profil wurde aktualisiert.");
    res.redirect("/account");
  });

  router.post("/password", async (req, res) => {
    const currentPassword = String(req.body.current_password ?? "");
    const newPassword = String(req.body.new_password ?? "");
    const result = await pool.query("SELECT password_hash FROM users WHERE id = $1", [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
    if (!valid || newPassword.length < 10) {
      return res.status(422).render("account", { title: "Mein Konto", error: "Das aktuelle Passwort ist falsch oder das neue Passwort hat weniger als 10 Zeichen." });
    }
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [passwordHash, req.user.id]);
    setFlash(req, "success", "Passwort wurde geändert.");
    res.redirect("/account");
  });

  return router;
}
