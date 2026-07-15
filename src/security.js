import crypto from "node:crypto";

export function csrfProtection(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();

  const supplied = String(req.body?._csrf ?? req.get("x-csrf-token") ?? "");
  const expected = String(req.session.csrfToken);
  const valid = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) {
    return res.status(403).render("error", {
      title: "Sicherheitsprüfung fehlgeschlagen",
      message: "Bitte lade die Seite neu und versuche es erneut."
    });
  }
  next();
}

export function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

export function exposeFlash(req, res, next) {
  res.locals.flash = req.session.flash ?? null;
  delete req.session.flash;
  next();
}
