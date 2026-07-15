import "dotenv/config";

function requireProductionValue(name, value) {
  if (process.env.NODE_ENV === "production" && !value) {
    throw new Error(`${name} muss in der Produktionsumgebung gesetzt sein.`);
  }
  return value;
}

export function loadConfig(overrides = {}) {
  const nodeEnv = overrides.nodeEnv ?? process.env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";
  const sessionSecret = overrides.sessionSecret ?? process.env.SESSION_SECRET ?? (isProduction ? "" : "development-only-secret-change-me");
  const adminPassword = overrides.adminPassword ?? process.env.ADMIN_PASSWORD ?? (isProduction ? "" : "ChangeMe123!");

  requireProductionValue("SESSION_SECRET", sessionSecret);
  requireProductionValue("ADMIN_PASSWORD", adminPassword);

  if (isProduction && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET muss mindestens 32 Zeichen lang sein.");
  }
  if (isProduction && adminPassword.length < 12) {
    throw new Error("ADMIN_PASSWORD muss mindestens 12 Zeichen lang sein.");
  }

  return {
    nodeEnv,
    isProduction,
    port: Number(overrides.port ?? process.env.PORT ?? 3000),
    companyName: overrides.companyName ?? process.env.COMPANY_NAME ?? "Tixaro",
    databaseUrl: overrides.databaseUrl ?? process.env.DATABASE_URL ?? "memory://tixaro",
    databaseSsl: overrides.databaseSsl ?? process.env.DATABASE_SSL === "true",
    sessionSecret,
    adminName: overrides.adminName ?? process.env.ADMIN_NAME ?? "Administrator",
    adminEmail: (overrides.adminEmail ?? process.env.ADMIN_EMAIL ?? "admin@tixaro.local").toLowerCase(),
    adminPassword,
    trustProxy: Number(overrides.trustProxy ?? process.env.TRUST_PROXY ?? (isProduction ? 1 : 0))
  };
}
