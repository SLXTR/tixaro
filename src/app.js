import path from "node:path";
import { fileURLToPath } from "node:url";
import compression from "compression";
import connectPgSimple from "connect-pg-simple";
import ejsMate from "ejs-mate";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import session from "express-session";
import { loadUser } from "./middleware.js";
import { csrfProtection, exposeFlash } from "./security.js";
import { helpers } from "./view-helpers.js";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { ticketsRouter } from "./routes/tickets.js";
import { usersRouter } from "./routes/users.js";
import { accountRouter } from "./routes/account.js";
import { customersRouter } from "./routes/customers.js";
import { assetsRouter } from "./routes/assets.js";
import { settingsRouter } from "./routes/settings.js";
import { statisticsRouter } from "./routes/statistics.js";
import { portalRouter } from "./routes/portal.js";
import { appearanceCss, loadAppearance, loadBrandLogo, loadBrandName } from "./appearance.js";
import { setupRouter } from "./routes/setup.js";
import { createSetupState } from "./initial-setup.js";
import { loadSystemConfiguration } from "./system-configuration.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function mapTileCspSource(template) {
  try {
    const usesSubdomain = template.includes("{s}");
    const normalized = template
      .replace("{s}", "tiles")
      .replace(/\{(?:z|x|y)\}/g, "0");
    const url = new URL(normalized);
    if (!usesSubdomain) return url.origin;
    const rootHost = url.hostname.replace(/^tiles\./, "");
    return `${url.protocol}//*.${rootHost}`;
  } catch {
    return "https://tile.openstreetmap.org";
  }
}

export function createApp({ pool, config }) {
  const app = express();
  const PgSession = connectPgSimple(session);
  const mapTileSource = mapTileCspSource(config.mapTileUrl);
  const setupState = createSetupState(pool);

  app.set("trust proxy", config.trustProxy);
  app.engine("ejs", ejsMate);
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));

  app.use(helmet({
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        frameSrc: ["'self'", "https://www.openstreetmap.org"],
        imgSrc: ["'self'", "data:", mapTileSource],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"]
      }
    }
  }));
  app.use(compression());
  if (config.nodeEnv === "development") app.use(morgan("dev"));
  app.use(express.urlencoded({ extended: false, limit: "3mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: config.isProduction ? "7d" : 0 }));
  app.use("/vendor/leaflet", express.static(path.join(__dirname, "..", "node_modules", "leaflet", "dist"), { maxAge: config.isProduction ? "30d" : 0 }));

  const sessionOptions = {
    name: "tixaro.sid",
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    proxy: config.isProduction,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: config.isProduction,
      maxAge: 1000 * 60 * 60 * 12
    }
  };
  if (!config.databaseUrl.startsWith("memory://")) {
    sessionOptions.store = new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true });
  }
  app.use(session(sessionOptions));

  app.use(async (req, res, next) => {
    res.locals.companyName = config.companyName;
    res.locals.currentPath = req.path;
    Object.assign(res.locals, helpers);
    try {
      const [companyName, systemConfiguration] = await Promise.all([
        loadBrandName(pool, config.companyName),
        loadSystemConfiguration(pool, config)
      ]);
      res.locals.companyName = companyName;
      res.locals.appBaseUrl = systemConfiguration.appBaseUrl;
      res.locals.timeZone = systemConfiguration.timeZone;
      res.locals.formatDate = (value) => helpers.formatDate(value, systemConfiguration.timeZone);
      res.locals.formatDateTime = (value) => helpers.formatDateTime(value, systemConfiguration.timeZone);
      res.locals.formatDateTimeInput = (value) => helpers.formatDateTimeInput(value, systemConfiguration.timeZone);
      res.locals.deadlineText = (value, state) => helpers.deadlineText(value, state, systemConfiguration.timeZone);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.use(loadUser(pool));
  app.use(exposeFlash);
  app.use(csrfProtection);

  app.get("/theme.css", async (_req, res) => {
    res.type("text/css").set("Cache-Control", "no-store").send(appearanceCss(await loadAppearance(pool)));
  });

  app.get("/brand-logo", async (_req, res, next) => {
    try {
      const logo = await loadBrandLogo(pool);
      res.set("Cache-Control", "no-store");
      if (!logo) return res.sendFile(path.join(__dirname, "..", "public", "tixaro-logo.webp"));
      return res.type(logo.mime).send(Buffer.from(logo.data, "base64"));
    } catch (error) {
      next(error);
    }
  });

  app.get("/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });
  app.use(setupState.guard);
  app.use("/setup", setupRouter({ pool, config, setupState }));
  app.use(authRouter({ pool, config }));
  app.use(dashboardRouter({ pool }));
  app.use("/portal", portalRouter({ pool }));
  app.use("/tickets", ticketsRouter({ pool, config }));
  app.use("/users", usersRouter({ pool }));
  app.use("/account", accountRouter({ pool }));
  app.use("/customers", customersRouter({ pool, addressSearchUrl: config.addressSearchUrl }));
  app.use("/assets", assetsRouter({ pool }));
  app.use("/statistics", statisticsRouter({ pool, mapTileUrl: config.mapTileUrl }));
  app.use("/settings", settingsRouter({ pool, config }));

  app.use((_req, res) => res.status(404).render("error", { title: "Seite nicht gefunden", message: "Die gewünschte Seite existiert nicht." }));
  app.use((error, req, res, _next) => {
    console.error(error);
    if (res.headersSent) return;
    res.status(500).render("error", {
      title: "Etwas ist schiefgelaufen",
      message: "Die Anfrage konnte nicht verarbeitet werden.",
      companyName: res.locals.companyName ?? config.companyName,
      currentPath: req.path,
      currentUser: res.locals.currentUser ?? null,
      csrfToken: res.locals.csrfToken ?? "",
      flash: null
    });
  });

  return app;
}
