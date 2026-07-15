const defaultTimeZone = "Europe/Berlin";

export const setupTimeZones = Object.freeze([
  ["Europe/Berlin", "Deutschland – Berlin"],
  ["Europe/Vienna", "Österreich – Wien"],
  ["Europe/Zurich", "Schweiz – Zürich"],
  ["Europe/Amsterdam", "Niederlande – Amsterdam"],
  ["Europe/Brussels", "Belgien – Brüssel"],
  ["Europe/Luxembourg", "Luxemburg"],
  ["Europe/London", "Vereinigtes Königreich – London"],
  ["UTC", "UTC"]
]);

export function normalizeAppBaseUrl(value, fallback = "http://localhost:3000") {
  try {
    const parsed = new URL(String(value ?? "").trim() || fallback);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("invalid");
    return parsed.origin;
  } catch {
    return normalizeAppBaseUrl(fallback, "http://localhost:3000");
  }
}

export function validAppBaseUrl(value) {
  try {
    const parsed = new URL(String(value ?? "").trim());
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

export function validTimeZone(value) {
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: String(value) }).format();
    return true;
  } catch {
    return false;
  }
}

export async function loadSystemConfiguration(client, config = {}) {
  const result = await client.query("SELECT value_json FROM system_preferences WHERE key = 'system_configuration'");
  const stored = result.rows[0]?.value_json ?? {};
  return {
    appBaseUrl: normalizeAppBaseUrl(stored.appBaseUrl, config.appBaseUrl),
    timeZone: validTimeZone(stored.timeZone) ? stored.timeZone : (validTimeZone(config.timeZone) ? config.timeZone : defaultTimeZone)
  };
}

export async function saveSystemConfiguration(client, values) {
  const configuration = {
    appBaseUrl: normalizeAppBaseUrl(values.appBaseUrl),
    timeZone: validTimeZone(values.timeZone) ? values.timeZone : defaultTimeZone
  };
  await client.query(
    `INSERT INTO system_preferences (key, value_json, updated_at) VALUES ('system_configuration', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [JSON.stringify(configuration)]
  );
  return configuration;
}
