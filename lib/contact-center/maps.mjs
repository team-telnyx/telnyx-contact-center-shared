// Static map previews for shared locations. Tiles come from an XYZ tile server
// (OpenStreetMap by default; set NEXT_PUBLIC_MAP_TILE_URL to a self-hosted or
// commercial server with the same {z}/{x}/{y} template). The maths runs in the
// browser and in Node so it can be unit-tested.
export const MAP_TILE_SIZE = 256;
export const MAP_ATTRIBUTION = "© OpenStreetMap contributors";
export const MAP_ATTRIBUTION_URL = "https://www.openstreetmap.org/copyright";
const DEFAULT_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const MAX_ZOOM = 19;

export function mapTileTemplate(env = typeof process !== "undefined" ? process.env : {}) {
  const value = String(env?.NEXT_PUBLIC_MAP_TILE_URL || "").trim();
  return /^https:\/\/.+\{z\}.+\{x\}.+\{y\}/.test(value) ? value : DEFAULT_TILE_URL;
}

const mapError = (message) => Object.assign(new Error(message), { status: 400 });
export function parseLatitude(value) {
  const number = Number(String(value ?? "").trim());
  if (!Number.isFinite(number) || number < -90 || number > 90) throw mapError("Latitude must be a number between -90 and 90");
  return Math.round(number * 1e6) / 1e6;
}
export function parseLongitude(value) {
  const number = Number(String(value ?? "").trim());
  if (!Number.isFinite(number) || number < -180 || number > 180) throw mapError("Longitude must be a number between -180 and 180");
  return Math.round(number * 1e6) / 1e6;
}
export function clampZoom(value, fallback = 15) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(MAX_ZOOM, Math.max(1, Math.round(number))) : fallback;
}

// Web Mercator projection into fractional tile units at `zoom`.
export function lngLatToTile(longitude, latitude, zoom) {
  const scale = 2 ** zoom;
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude)) * Math.PI / 180;
  return { x: ((longitude + 180) / 360) * scale, y: ((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * scale };
}

// Tiles needed to paint a `width`×`height` viewport centred on the point, with
// their pixel offsets inside the viewport, plus the pin position.
export function staticMapLayout({ latitude, longitude, zoom = 15, width = 280, height = 150, template = mapTileTemplate() }) {
  const lat = parseLatitude(latitude), lng = parseLongitude(longitude), z = clampZoom(zoom);
  const centre = lngLatToTile(lng, lat, z);
  const scale = 2 ** z;
  const originX = centre.x * MAP_TILE_SIZE - width / 2, originY = centre.y * MAP_TILE_SIZE - height / 2;
  const first = { x: Math.floor(originX / MAP_TILE_SIZE), y: Math.floor(originY / MAP_TILE_SIZE) };
  const last = { x: Math.floor((originX + width - 1) / MAP_TILE_SIZE), y: Math.floor((originY + height - 1) / MAP_TILE_SIZE) };
  const tiles = [];
  for (let y = first.y; y <= last.y; y++) for (let x = first.x; x <= last.x; x++) {
    if (y < 0 || y >= scale) continue; // nothing beyond the poles
    const wrappedX = ((x % scale) + scale) % scale; // the antimeridian wraps
    tiles.push({ key: `${z}/${wrappedX}/${y}`, url: template.replace("{z}", String(z)).replace("{x}", String(wrappedX)).replace("{y}", String(y)),
      left: Math.round(x * MAP_TILE_SIZE - originX), top: Math.round(y * MAP_TILE_SIZE - originY) });
  }
  return { latitude: lat, longitude: lng, zoom: z, width, height, tiles, pin: { left: Math.round(width / 2), top: Math.round(height / 2) } };
}

export function mapLink({ latitude, longitude, zoom = 16 }) {
  const lat = parseLatitude(latitude), lng = parseLongitude(longitude);
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=${clampZoom(zoom, 16)}/${lat}/${lng}`;
}
export function googleMapsLink({ latitude, longitude }) {
  return `https://www.google.com/maps?q=${encodeURIComponent(`${parseLatitude(latitude)},${parseLongitude(longitude)}`)}`;
}

// The Maps Embed API key as the browser sees it. `GOOGLE_MAPS_KEY` is the name
// used on the server; next.config.mjs republishes it under the NEXT_PUBLIC_ name
// so the client bundle can read it. Both names are accepted here.
export function googleMapsApiKey(env = typeof process !== "undefined" ? process.env : {}) {
  return String(env?.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || env?.GOOGLE_MAPS_KEY || "").trim();
}

// Interactive Google map for the preview modal. With a Maps Embed API key the
// official embed is used; without one the classic keyless embed works.
export function googleMapsEmbedUrl({ latitude, longitude, zoom = 15, apiKey = "" }) {
  const lat = parseLatitude(latitude), lng = parseLongitude(longitude), z = clampZoom(zoom, 15);
  const key = String(apiKey || "").trim();
  if (key) return `https://www.google.com/maps/embed/v1/place?key=${encodeURIComponent(key)}&q=${lat}%2C${lng}&zoom=${z}`;
  return `https://maps.google.com/maps?q=${lat}%2C${lng}&z=${z}&output=embed`;
}
