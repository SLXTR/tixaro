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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ pool, config }) {
  const app = express();
  const PgSession = connectPgSimple(session);

  app.set("trust proxy", config.trustProxy);
  app.engine("ejs", ejsMate);
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"]
      }
    }
  }));
  app.use(compression());
  if (config.nodeEnv === "development") app.use(morgan("dev"));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: config.isProduction ? "7d" : 0 }));

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

  app.use((req, res, next) => {
    res.locals.companyName = config.companyName;
    res.locals.currentPath = req.path;
    Object.assign(res.locals, helpers);
    next();
  });
  app.use(loadUser(pool));
  app.use(exposeFlash);
  app.use(csrfProtection);

  app.get("/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  });
  app.use(authRouter({ pool, config }));
  app.use(dashboardRouter({ pool }));
  app.use("/tickets", ticketsRouter({ pool }));
  app.use("/users", usersRouter({ pool }));
  app.use("/account", accountRouter({ pool }));

  app.use((_req, res) => res.status(404).render("error", { title: "Seite nicht gefunden", message: "Die gewünschte Seite existiert nicht." }));
  app.use((error, req, res, _next) => {
    console.error(error);
    if (res.headersSent) return;
    res.status(500).render("error", {
      title: "Etwas ist schiefgelaufen",
      message: "Die Anfrage konnte nicht verarbeitet werden.",
      companyName: config.companyName,
      currentPath: req.path,
      currentUser: res.locals.currentUser ?? null,
      csrfToken: res.locals.csrfToken ?? "",
      flash: null
    });
  });

  return app;
}
