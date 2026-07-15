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
  const mailSecretKey = overrides.mailSecretKey ?? process.env.MAIL_SECRET_KEY ?? sessionSecret;

  requireProductionValue("SESSION_SECRET", sessionSecret);
  requireProductionValue("ADMIN_PASSWORD", adminPassword);

  if (isProduction && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET muss mindestens 32 Zeichen lang sein.");
  }
  if (isProduction && adminPassword.length < 12) {
    throw new Error("ADMIN_PASSWORD muss mindestens 12 Zeichen lang sein.");
  }
  if (isProduction && mailSecretKey.length < 32) {
    throw new Error("MAIL_SECRET_KEY muss mindestens 32 Zeichen lang sein.");
  }

  return {
    nodeEnv,
    isProduction,
    port: Number(overrides.port ?? process.env.PORT ?? 3000),
    companyName: overrides.companyName ?? process.env.COMPANY_NAME ?? "Tixaro",
    addressSearchUrl: overrides.addressSearchUrl ?? process.env.ADDRESS_SEARCH_URL ?? "https://photon.komoot.io/api/",
    mapTileUrl: overrides.mapTileUrl ?? process.env.MAP_TILE_URL ?? "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    appBaseUrl: overrides.appBaseUrl ?? process.env.APP_BASE_URL ?? `http://localhost:${Number(overrides.port ?? process.env.PORT ?? 3000)}`,
    mailSecretKey,
    databaseUrl: overrides.databaseUrl ?? process.env.DATABASE_URL ?? "memory://tixaro",
    databaseSsl: overrides.databaseSsl ?? process.env.DATABASE_SSL === "true",
    sessionSecret,
    adminName: overrides.adminName ?? process.env.ADMIN_NAME ?? "Administrator",
    adminEmail: (overrides.adminEmail ?? process.env.ADMIN_EMAIL ?? "admin@tixaro.local").toLowerCase(),
    adminPassword,
    updateRemote: overrides.updateRemote ?? process.env.TIXARO_UPDATE_REMOTE ?? "origin",
    githubToken: overrides.githubToken ?? process.env.TIXARO_GITHUB_TOKEN ?? "",
    updateAutoRestart: overrides.updateAutoRestart ?? process.env.TIXARO_UPDATE_AUTO_RESTART !== "false",
    trustProxy: Number(overrides.trustProxy ?? process.env.TRUST_PROXY ?? (isProduction ? 1 : 0))
  };
}
