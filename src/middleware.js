import { hasPermission, loadAccessContext } from "./access-control.js";

export function loadUser(pool) {
  return async (req, res, next) => {
    res.locals.currentUser = null;
    res.locals.portalPreview = null;
    if (!req.session.userId) return next();

    const clearAuthentication = () => {
      req.session.userId = null;
      delete req.session.sessionVersion;
      delete req.session.originalUserId;
      delete req.session.originalSessionVersion;
    };
    const loadActiveUser = (id, adminOnly = false) => pool.query(
      `SELECT id, first_name, last_name, name, email, role, active, session_version, created_at
       FROM users WHERE id = $1 AND active = TRUE ${adminOnly ? "AND role = 'admin'" : ""}`,
      [id]
    );
    const versionMatches = (stored, sessionVersion) => sessionVersion == null || Number(stored) === Number(sessionVersion);

    let result = await loadActiveUser(req.session.userId);
    if (!result.rowCount || !versionMatches(result.rows[0].session_version, req.session.sessionVersion)) {
      if (!req.session.originalUserId) {
        clearAuthentication();
        return next();
      }
      result = await loadActiveUser(req.session.originalUserId, true);
      if (!result.rowCount || !versionMatches(result.rows[0].session_version, req.session.originalSessionVersion)) {
        clearAuthentication();
        return next();
      }
      req.session.userId = result.rows[0].id;
      req.session.sessionVersion = result.rows[0].session_version;
      delete req.session.originalUserId;
      delete req.session.originalSessionVersion;
    } else if (req.session.sessionVersion == null) {
      req.session.sessionVersion = result.rows[0].session_version;
    }
    req.user = { ...result.rows[0], ...await loadAccessContext(pool, result.rows[0].id) };
    if (req.session.originalUserId && req.user.role === "requester") {
      const original = await pool.query(
        "SELECT id, first_name, last_name, name, email, role, session_version FROM users WHERE id = $1 AND active = TRUE AND role = 'admin'",
        [req.session.originalUserId]
      );
      const originalIsValid = original.rowCount
        && Number(original.rows[0].session_version) === Number(req.session.originalSessionVersion);
      if (originalIsValid && original.rows[0].id !== req.user.id) {
        req.portalPreview = { admin: original.rows[0], user: req.user };
        res.locals.portalPreview = req.portalPreview;
      } else {
        clearAuthentication();
        req.user = null;
        res.locals.currentUser = null;
        return next();
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
