const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;
const cache = new Map();

function cleanPart(value) {
  return String(value ?? "").trim();
}

function uniqueParts(parts) {
  return parts.filter(Boolean).filter((value, index, values) => values.indexOf(value) === index);
}

function normalizeFeature(feature) {
  const properties = feature?.properties ?? {};
  const [longitude, latitude] = feature?.geometry?.coordinates ?? [];
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return null;

  const street = cleanPart(properties.street || properties.name);
  const houseNumber = cleanPart(properties.housenumber);
  const city = cleanPart(properties.city || properties.locality || properties.county);
  const postcode = cleanPart(properties.postcode);
  const country = cleanPart(properties.country);
  const streetLine = [street, houseNumber].filter(Boolean).join(" ");
  const cityLine = [postcode, city].filter(Boolean).join(" ");
  const label = uniqueParts([streetLine, cityLine, country]).join(", ");
  if (!label) return null;

  return {
    label,
    address: streetLine || label,
    city,
    postcode,
    country,
    latitude: Number(latitude),
    longitude: Number(longitude)
  };
}

export async function searchAddresses(query, {
  baseUrl = "https://photon.komoot.io/api/",
  fetchImpl = globalThis.fetch
} = {}) {
  const normalizedQuery = cleanPart(query).replace(/\s+/g, " ").slice(0, 180);
  if (normalizedQuery.length < 3 || typeof fetchImpl !== "function") return [];

  const cacheKey = `${baseUrl}|${normalizedQuery.toLocaleLowerCase("de-DE")}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const url = new URL(baseUrl);
  url.searchParams.set("q", normalizedQuery);
  url.searchParams.set("lang", "de");
  url.searchParams.set("limit", "6");
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "Tixaro-Service-Desk/1.0" },
    signal: AbortSignal.timeout(4500)
  });
  if (!response.ok) throw new Error(`Adressdienst antwortet mit ${response.status}.`);

  const payload = await response.json();
  const suggestions = (payload.features ?? []).map(normalizeFeature).filter(Boolean).slice(0, 6);
  if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { value: suggestions, expiresAt: Date.now() + CACHE_TTL_MS });
  return suggestions;
}
