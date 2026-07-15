import { hasPermission, loadAccessContext } from "./access-control.js";

export function loadUser(pool) {
  return async (req, res, next) => {
    res.locals.currentUser = null;
    res.locals.portalPreview = null;
    if (!req.session.userId) return next();

    let result = await pool.query(
      "SELECT id, first_name, last_name, name, email, role, active, created_at FROM users WHERE id = $1 AND active = TRUE",
      [req.session.userId]
    );
    if (result.rowCount === 0) {
      if (!req.session.originalUserId) {
        req.session.userId = null;
        return next();
      }
      result = await pool.query(
        "SELECT id, first_name, last_name, name, email, role, active, created_at FROM users WHERE id = $1 AND active = TRUE AND role = 'admin'",
        [req.session.originalUserId]
      );
      if (!result.rowCount) {
        req.session.userId = null;
        delete req.session.originalUserId;
        return next();
      }
      req.session.userId = result.rows[0].id;
      delete req.session.originalUserId;
    }
    req.user = { ...result.rows[0], ...await loadAccessContext(pool, result.rows[0].id) };
    if (req.session.originalUserId && req.user.role === "requester") {
      const original = await pool.query(
        "SELECT id, first_name, last_name, name, email, role FROM users WHERE id = $1 AND active = TRUE AND role = 'admin'",
        [req.session.originalUserId]
      );
      if (original.rowCount && original.rows[0].id !== req.user.id) {
        req.portalPreview = { admin: original.rows[0], user: req.user };
        res.locals.portalPreview = req.portalPreview;
      } else {
        delete req.session.originalUserId;
      }
    }
    res.locals.currentUser = req.user;
    res.locals.can = (permission) => hasPermission(req.user, permission);
    res.locals.hasQueueAccess = Object.keys(req.user.queuePermissions).length > 0;
    next();
  };
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.redirect("/login");
  next();
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.redirect("/login");
    if (!hasPermission(req.user, permission)) {
      return res.status(403).render("error", { title: "Kein Zugriff", message: "Du hast für diese Aktion keine Berechtigung." });
    }
    next();
  };
}
