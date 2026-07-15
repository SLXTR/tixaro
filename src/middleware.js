export function loadUser(pool) {
  return async (req, res, next) => {
    res.locals.currentUser = null;
    if (!req.session.userId) return next();

    const result = await pool.query(
      "SELECT id, name, email, role, active, created_at FROM users WHERE id = $1 AND active = TRUE",
      [req.session.userId]
    );
    if (result.rowCount === 0) {
      req.session.userId = null;
      return next();
    }
    req.user = result.rows[0];
    res.locals.currentUser = req.user;
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.redirect("/login");
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect("/login");
    if (!roles.includes(req.user.role)) {
      return res.status(403).render("error", { title: "Kein Zugriff", message: "Du hast für diese Aktion keine Berechtigung." });
    }
    next();
  };
}
