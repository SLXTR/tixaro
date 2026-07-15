export const defaultAppearance = Object.freeze({
  accent: "#0f766e",
  accentDark: "#115e59",
  canvas: "#f6f6f3",
  surface: "#ffffff",
  sage: "#475569",
  sidebar: "#f6f6f3",
  sidebarText: "#1f2937"
});

const versionOneAppearance = Object.freeze({
  accent: "#16b8a6",
  accentDark: "#0b8f84",
  canvas: "#f5f7fa",
  surface: "#ffffff",
  sage: "#ff6b5e",
  sidebar: "#101828",
  sidebarText: "#f7f3ec"
});

const previousDefaultAppearance = Object.freeze({
  accent: "#005ee9",
  accentDark: "#004bbd",
  canvas: "#f4f8ff",
  surface: "#ffffff",
  sage: "#364151",
  sidebar: "#ffffff",
  sidebarText: "#111827"
});

const legacyAppearance = Object.freeze({
  accent: "#985d42",
  accentDark: "#78452f",
  canvas: "#efeee8",
  surface: "#fbfbf7",
  sage: "#626b5b",
  sidebar: "#252721",
  sidebarText: "#e9e9e2"
});

const colorPattern = /^#[0-9a-f]{6}$/i;

export function normalizeBrandName(value, fallback = "Tixaro") {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  return name.length >= 2 && name.length <= 80 ? name : fallback;
}

export async function loadBrandName(client, fallback = "Tixaro") {
  const result = await client.query("SELECT value_json FROM system_preferences WHERE key = 'brand_name'");
  return normalizeBrandName(result.rows[0]?.value_json?.name, fallback);
}

export async function saveBrandName(client, value) {
  const raw = String(value ?? "").replace(/\s+/g, " ").trim();
  if (raw.length < 2 || raw.length > 80) throw new Error("Der Firmenname muss zwischen 2 und 80 Zeichen lang sein.");
  await client.query(
    `INSERT INTO system_preferences (key, value_json, updated_at) VALUES ('brand_name', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [JSON.stringify({ name: raw })]
  );
  return raw;
}

export async function resetBrandName(client) {
  await client.query("DELETE FROM system_preferences WHERE key = 'brand_name'");
}

export function normalizeAppearance(value = {}) {
  return Object.fromEntries(Object.entries(defaultAppearance).map(([key, fallback]) => [
    key,
    colorPattern.test(String(value?.[key] ?? "")) ? String(value[key]).toLowerCase() : fallback
  ]));
}

export async function loadAppearance(client) {
  const result = await client.query("SELECT value_json FROM system_preferences WHERE key = 'appearance'");
  const saved = result.rows[0]?.value_json;
  const usesOldDefaults = saved && [versionOneAppearance, legacyAppearance, previousDefaultAppearance].some((preset) =>
    Object.entries(preset).every(([key, value]) => String(saved[key] ?? "").toLowerCase() === value)
  );
  return usesOldDefaults ? { ...defaultAppearance } : normalizeAppearance(saved ?? {});
}

export async function saveAppearance(client, value) {
  const appearance = normalizeAppearance(value);
  await client.query(
    `INSERT INTO system_preferences (key, value_json, updated_at) VALUES ('appearance', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [JSON.stringify(appearance)]
  );
  return appearance;
}

export async function resetAppearance(client) {
  await client.query("DELETE FROM system_preferences WHERE key = 'appearance'");
}

export async function loadBrandLogo(client) {
  const result = await client.query("SELECT value_json, updated_at FROM system_preferences WHERE key = 'brand_logo'");
  const stored = result.rows[0]?.value_json;
  if (!stored?.mime || !stored?.data) return null;
  return { mime: stored.mime, data: stored.data, updatedAt: result.rows[0].updated_at };
}

export async function saveBrandLogo(client, { mime, data }) {
  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(mime) || !Buffer.isBuffer(data) || data.length < 32 || data.length > 1_500_000) {
    throw new Error("Das Logo muss eine PNG-, JPG- oder WebP-Datei mit maximal 1,5 MB sein.");
  }
  const validSignature = mime === "image/png"
    ? data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : mime === "image/jpeg"
      ? data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
      : data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
  if (!validSignature) throw new Error("Die ausgewählte Datei ist kein gültiges Bild.");
  await client.query(
    `INSERT INTO system_preferences (key, value_json, updated_at) VALUES ('brand_logo', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()`,
    [JSON.stringify({ mime, data: data.toString("base64") })]
  );
}

export async function resetBrandLogo(client) {
  await client.query("DELETE FROM system_preferences WHERE key = 'brand_logo'");
}

export function appearanceCss(value) {
  const color = normalizeAppearance(value);
  return `:root{--accent:${color.accent};--accent-dark:${color.accentDark};--canvas:${color.canvas};--surface:${color.surface};--sage:${color.sage};--brand-coral:${color.sage};--sidebar:${color.sidebar};--sidebar-text:${color.sidebarText}}`;
}
