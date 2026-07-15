import crypto from "node:crypto";
import express from "express";
import bcrypt from "bcryptjs";
import { rateLimit } from "express-rate-limit";

export function authRouter({ pool, config }) {
  const router = express.Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skip: () => config.nodeEnv === "test",
    message: "Zu viele Anmeldeversuche. Bitte warte 15 Minuten."
  });

  router.get("/login", (req, res) => {
    if (req.user) return res.redirect(req.user.role === "requester" ? "/portal" : "/");
    res.render("login", { title: "Anmelden", error: null, email: "" });
  });

  router.post("/login", loginLimiter, async (req, res, next) => {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    const password = String(req.body.password ?? "");
    const result = await pool.query("SELECT * FROM users WHERE email = $1 AND active = TRUE", [email]);
    const user = result.rows[0];
    const valid = user && await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).render("login", { title: "Anmelden", error: "E-Mail-Adresse oder Passwort ist falsch.", email });
    }

    req.session.regenerate((error) => {
      if (error) return next(error);
      req.session.userId = user.id;
      req.session.sessionVersion = user.session_version;
      req.session.csrfToken = crypto.randomBytes(32).toString("hex");
      pool.query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]).catch(console.error);
      res.redirect(user.role === "requester" ? "/portal" : "/");
    });
  });

  router.post("/logout", (req, res, next) => {
    req.session.destroy((error) => {
      if (error) return next(error);
      res.clearCookie("tixaro.sid");
      res.redirect("/login");
    });
  });

  return router;
}
