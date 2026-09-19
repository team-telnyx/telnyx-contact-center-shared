// Server-side Pexels client shared by the Forms media library and the agent
// composer. The API key never leaves the server; only public photo data flows.
const PEXELS_API = "https://api.pexels.com/v1";
const ALLOWED = new Map([["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"], ["image/gif", "gif"]]);
export const PEXELS_MAX_BYTES = 5 * 1048576;
export const pexelsError = (message, status = 400) => Object.assign(new Error(message), { status });

export function pexelsConfigured() { return Boolean(process.env.PEXELS_API_KEY); }

export function normalizePexelsPhoto(photo) {
  return { id: photo.id, title: photo.alt || `Pexels photo ${photo.id}`, alt: photo.alt || "", photographer: photo.photographer || "Pexels photographer",
    photographer_url: photo.photographer_url || "", pexels_url: photo.url || "", width: photo.width, height: photo.height, avg_color: photo.avg_color || null,
    src: { tiny: photo.src?.tiny, small: photo.src?.small, medium: photo.src?.medium, large: photo.src?.large, original: photo.src?.original } };
}

async function pexelsFetch(pathname, fetchImpl = fetch) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) throw pexelsError("PEXELS_API_KEY is not configured on the server", 503);
  const response = await fetchImpl(`${PEXELS_API}${pathname}`, { headers: { Authorization: key }, cache: "no-store", signal: AbortSignal.timeout(15000) });
  if (response.status === 429) throw pexelsError("Pexels rate limit reached. Please try again later.", 429);
  if (!response.ok) throw pexelsError("Pexels request failed", 502);
  return response.json();
}

export async function pexelsSearch({ query, page = 1, perPage = 30, orientation = "" } = {}, fetchImpl = fetch) {
  const text = String(query || "").trim();
  if (text.length < 2) throw pexelsError("Search query must be at least 2 characters");
  const params = new URLSearchParams({ query: text, page: String(Math.max(1, Number(page) || 1)), per_page: String(Math.max(1, Math.min(80, Number(perPage) || 30))) });
  if (["landscape", "portrait", "square"].includes(orientation)) params.set("orientation", orientation);
  const data = await pexelsFetch(`/search?${params}`, fetchImpl);
  return { photos: (data.photos || []).map(normalizePexelsPhoto), page: data.page, perPage: data.per_page, totalResults: data.total_results, nextPage: data.next_page || null };
}

// Downloads the large rendition (JPEG) for sending. Pexels serves images from
// images.pexels.com only; anything else is refused.
export async function pexelsDownload(photoId, fetchImpl = fetch) {
  const id = Number(photoId);
  if (!Number.isInteger(id) || id <= 0) throw pexelsError("A valid Pexels photo id is required");
  const photo = normalizePexelsPhoto(await pexelsFetch(`/photos/${id}`, fetchImpl));
  const imageUrl = photo.src.large || photo.src.medium || photo.src.small;
  if (!imageUrl || !/^https:\/\/images\.pexels\.com\//.test(imageUrl)) throw pexelsError("Pexels photo does not include a downloadable image URL", 502);
  const response = await fetchImpl(imageUrl, { cache: "no-store", signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw pexelsError("Pexels image download failed", 502);
  const contentType = String(response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!ALLOWED.has(contentType)) throw pexelsError("Pexels returned an unsupported image type", 502);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > PEXELS_MAX_BYTES) throw pexelsError("Pexels image is larger than the 5 MB limit", 413);
  const base = String(photo.title || "pexels-photo").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "pexels-photo";
  return { photo, bytes, contentType, filename: `${base}-${photo.id}.${ALLOWED.get(contentType)}` };
}
