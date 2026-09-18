// Address search for the "send location" dialog. Nominatim (OpenStreetMap) by
// default; GEOCODER_URL may point at any Nominatim-compatible search endpoint.
// Nominatim's usage policy asks for an identifying User-Agent, at most one
// request per second and no bulk use, so requests are throttled and cached.
const DEFAULT_GEOCODER = "https://nominatim.openstreetmap.org/search";
const CACHE_TTL_MS = 10 * 60 * 1000, CACHE_LIMIT = 200, MIN_INTERVAL_MS = 1000;
export const GEOCODE_MIN_QUERY = 3, GEOCODE_MAX_QUERY = 200, GEOCODE_LIMIT = 6;
export const geocodeError = (message, status = 400) => Object.assign(new Error(message), { status });

const cache = new Map();
let queue = Promise.resolve(), lastRequestAt = 0;

export function geocoderUrl(env = process.env) {
  const value = String(env.GEOCODER_URL || "").trim();
  return /^https:\/\//.test(value) ? value : DEFAULT_GEOCODER;
}
export function geocoderUserAgent(env = process.env) {
  const site = String(env.TELNYX_WEBHOOK_BASE_URL || env.APP_BASE_URL || env.NEXTAUTH_URL || "").trim();
  return `TelnyxContactCenter/1.0${site ? ` (+${site})` : ""}`;
}

function formattedAddress(result) {
  const address = result.address || {};
  const street = [address.road || address.pedestrian || address.footway || address.path || "", address.house_number || ""].filter(Boolean).join(" ");
  const city = address.city || address.town || address.village || address.municipality || address.hamlet || address.suburb || "";
  const parts = [street, [address.postcode || "", city].filter(Boolean).join(" "), address.state || "", address.country || ""].filter(Boolean);
  return parts.join(", ") || String(result.display_name || "");
}
export function normalizeGeocodeResult(result) {
  const latitude = Number(result?.lat), longitude = Number(result?.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const label = String(result.display_name || "").trim();
  const name = String(result.name || result.namedetails?.name || label.split(",")[0] || "").trim().slice(0, 120);
  return { id: String(result.place_id ?? `${latitude},${longitude}`), name, address: formattedAddress(result).slice(0, 240), label: label.slice(0, 400),
    latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6, category: String(result.type || result.class || "").slice(0, 40) };
}

function remember(key, results) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
  return results;
}
export function clearGeocodeCache() { cache.clear(); lastRequestAt = 0; }

// One upstream request at a time, at least MIN_INTERVAL_MS apart.
function throttled(task) {
  const run = queue.then(async () => {
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    return task();
  });
  queue = run.catch(() => {});
  return run;
}

export async function geocodeSearch(query, { fetchImpl = fetch, language = "", env = process.env } = {}) {
  const text = String(query || "").replace(/\s+/g, " ").trim();
  if (text.length < GEOCODE_MIN_QUERY) throw geocodeError(`Enter at least ${GEOCODE_MIN_QUERY} characters to search for an address`);
  if (text.length > GEOCODE_MAX_QUERY) throw geocodeError("Address query is too long");
  const lang = String(language || "").split(",")[0].trim().slice(0, 12);
  const key = `${lang}|${text.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.results;
  const params = new URLSearchParams({ q: text, format: "jsonv2", limit: String(GEOCODE_LIMIT), addressdetails: "1", namedetails: "1" });
  if (lang) params.set("accept-language", lang);
  const url = `${geocoderUrl(env)}?${params}`;
  const response = await throttled(() => fetchImpl(url, { headers: { "User-Agent": geocoderUserAgent(env), Accept: "application/json", ...(lang ? { "Accept-Language": lang } : {}) },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000) }));
  if (response.status === 429) throw geocodeError("The address service is busy. Please try again in a moment.", 429);
  if (!response.ok) throw geocodeError("Address search failed", 502);
  const data = await response.json().catch(() => []);
  return remember(key, (Array.isArray(data) ? data : []).map(normalizeGeocodeResult).filter(Boolean));
}
