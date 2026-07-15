import express from "express";
import { completeInitialSetup, setupDefaults, validateSetupInput } from "../initial-setup.js";
import { setFlash } from "../security.js";
import { setupTimeZones } from "../system-configuration.js";

function requestBaseUrl(req, config) {
  const host = req.get("host");
  return host ? `${req.protocol}://${host}` : config.appBaseUrl;
}

function formValues(values) {
  if (!values.companyName) return values;
  return {
    company_name: values.companyName,
    app_base_url: values.appBaseUrl,
    time_zone: values.timeZone,
    queue_name: values.queueName,
    response_hours: String(values.responseHours || ""),
    resolution_hours: String(values.resolutionHours || ""),
    first_name: values.firstName,
    last_name: values.lastName,
    email: values.email
  };
}

export function setupRouter({ pool, config, setupState }) {
  const router = express.Router();

  router.get("/", async (req, res) => {
    if (await setupState.isComplete()) return res.redirect(req.user ? "/" : "/login");
    res.render("setup", {
      title: "Ersteinrichtung",
      values: setupDefaults(config, requestBaseUrl(req, config)),
      errors: [],
      timeZones: setupTimeZones
    });
  });

  router.post("/", async (req, res, next) => {
    if (await setupState.isComplete(true)) return res.redirect(req.user ? "/" : "/login");
    const validation = validateSetupInput(req.body);
    if (validation.errors.length) {
      return res.status(422).render("setup", {
        title: "Ersteinrichtung", values: formValues(validation.values), errors: validation.errors, timeZones: setupTimeZones
      });
    }
    try {
      const adminId = await completeInitialSetup(pool, validation.values);
      setupState.markComplete();
      req.session.regenerate((error) => {
        if (error) return next(error);
        req.session.userId = adminId;
        setFlash(req, "success", "Die Ersteinrichtung ist abgeschlossen. Willkommen bei Tixaro.");
        res.redirect("/");
      });
    } catch (error) {
      const safeMessages = new Set([
        "Die Ersteinrichtung wurde bereits abgeschlossen.",
        "Der gewählte Queue-Name wird bereits verwendet."
      ]);
      res.status(409).render("setup", {
        title: "Ersteinrichtung",
        values: formValues(validation.values),
        errors: [safeMessages.has(error.message) ? error.message : "Die Einrichtung konnte nicht abgeschlossen werden. Bitte versuche es erneut."],
        timeZones: setupTimeZones
      });
    }
  });

  return router;
}
