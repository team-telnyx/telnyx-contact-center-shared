import { imageSize } from "image-size";
import { widgetAiRequest } from "../widgets/ai-provider.js";
import { buildTelnyxV2Url } from "../telnyx.js";
import { TELNYX_AVATAR_MODEL, isTelnyxAvatarId } from "./telnyx-avatar-catalog.mjs";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
export const AVATAR_UPLOAD_LIMIT = 10 * 1024 * 1024;
export function validateAvatarImage(bytes, name) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 255) throw fail("Avatar name must contain 1–255 characters");
  if (!bytes?.byteLength || bytes.byteLength > AVATAR_UPLOAD_LIMIT) throw fail("Choose an image up to 10 MiB", 413);
  let size;
  try { size = imageSize(bytes); } catch { throw fail("Choose a valid JPEG, PNG or WebP image"); }
  const mime = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" }[size.type];
  if (!mime || size.images?.length > 1) throw fail("Choose a single JPEG, PNG or WebP image");
  if (Math.min(size.width, size.height) < 256 || Math.max(size.width, size.height) > 8192 || size.width * size.height > 40_000_000) throw fail("Image sides must be 256–8192 pixels, with at most 40 megapixels");
  return { name: name.trim(), mime, width: size.width, height: size.height };
}
export function avatarCatalogEntry(a) {
  if (!isTelnyxAvatarId(a?.id)) throw fail("Telnyx returned an invalid avatar", 502);
  const url = typeof a.image_url === "string" && a.image_url.startsWith("https://") ? a.image_url : "";
  return { id: a.id, name: a.name || a.id, type: a.avatar_type, avatarModel: TELNYX_AVATAR_MODEL,
    previewUrl: url, portraitPreviewUrl: url, landscapePreviewUrl: url, suggestedVoiceId: a.suggested_voice_id || "" };
}
export async function listTelnyxAvatars({ request = widgetAiRequest } = {}) {
  const found = new Map();
  for (let page = 1; page <= 100; page++) {
    const payload = await request(`/ai/avatars?page[number]=${page}&page[size]=100`);
    if (!Array.isArray(payload.data)) throw fail("Telnyx avatar catalog is unavailable", 502);
    for (const entry of payload.data) found.set(entry.id, avatarCatalogEntry(entry));
    if (page >= Number(payload.meta?.total_pages || 1)) return [...found.values()];
  }
  throw fail("Telnyx avatar catalog pagination did not finish", 502);
}
export async function getTelnyxAvatar(id, { request = widgetAiRequest } = {}) {
  if (!isTelnyxAvatarId(id)) throw fail("Invalid avatar ID");
  const result = await request(`/ai/avatars/${encodeURIComponent(id)}`);
  const entry = avatarCatalogEntry(result.data || result);
  if (entry.id !== id) throw fail("Selected avatar is unavailable", 409);
  return entry;
}
export async function createTelnyxAvatar(bytes, name, { fetchImpl = fetch } = {}) {
  const validated = validateAvatarImage(bytes, name);
  if (!process.env.TELNYX_API_KEY) throw fail("Telnyx is not configured", 503);
  const form = new FormData();
  form.set("name", validated.name);
  form.set("image_file", new Blob([bytes], { type: validated.mime }), "avatar." + validated.mime.split("/")[1]);
  // Do not retry creation: the API has no delete operation and a retry after
  // an uncertain response could consume a second permanent custom-avatar slot.
  let response;
  try { response = await fetchImpl(buildTelnyxV2Url("/ai/avatars"), { method: "POST", headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` }, body: form, signal: AbortSignal.timeout(60000) }); }
  catch { throw fail("Upload could not be confirmed. Refresh the custom avatar library before retrying.", 504); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw fail(response.status === 422 ? "Telnyx rejected this image or the custom avatar limit has been reached" : "Telnyx avatar upload failed. Refresh the library before retrying.", response.status === 422 ? 422 : 502);
  return avatarCatalogEntry(payload.data || payload);
}
export async function renameTelnyxAvatar(id, name, { request = widgetAiRequest } = {}) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 255) throw fail("Avatar name must contain 1–255 characters");
  const entry = await getTelnyxAvatar(id, { request });
  if (entry.type !== "custom") throw fail("Stock avatars cannot be renamed");
  await request(`/ai/avatars/${encodeURIComponent(id)}`, { method: "PATCH", body: { name: name.trim() } });
  return getTelnyxAvatar(id, { request });
}

const previews = new Map();
export async function refreshAvatarPreview(avatar) {
  if (!avatar?.enabled || !avatar.avatarId || avatar.provider && avatar.provider !== "telnyx") return avatar;
  let cached = previews.get(avatar.avatarId);
  if (!cached || cached.expires < Date.now()) {
    try {
      cached = { entry: await getTelnyxAvatar(avatar.avatarId), expires: Date.now() + 120000 };
      if (previews.size > 256) previews.clear();
      previews.set(avatar.avatarId, cached);
    } catch { return avatar; }
  }
  return { ...avatar, name: cached.entry.name, previewUrl: cached.entry.previewUrl, portraitPreviewUrl: cached.entry.previewUrl, landscapePreviewUrl: cached.entry.previewUrl };
}
