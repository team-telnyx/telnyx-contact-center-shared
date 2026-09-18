import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { resolveWebhookBaseUrl } from "../webhook-base-url.mjs";
import { whatsappError, WHATSAPP_MEDIA_RULES } from "./policy.mjs";

export const WHATSAPP_PUBLIC_MEDIA_PATH = "/api/public/whatsapp-media";
export const WHATSAPP_MEDIA_URL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_INBOUND_MEDIA_BYTES = 32 * 1048576;

function signingSecret() {
  const secret = process.env.MEDIA_URL_SIGNING_SECRET || process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET || "";
  if (!secret) throw whatsappError("Configure NEXTAUTH_SECRET (or MEDIA_URL_SIGNING_SECRET) so outbound media links can be signed", 503);
  return secret;
}
export function signWhatsAppMedia(attachmentId, expiresAt) {
  return createHmac("sha256", signingSecret()).update(`${attachmentId}.${expiresAt}`).digest("hex");
}
// WhatsApp fetches outbound media from a public URL. The link is unguessable
// (HMAC over the attachment id and expiry) and expires after a week so
// provider retries and Meta's own caching keep working.
export function createWhatsAppMediaUrl(attachmentId, { ttlMs = WHATSAPP_MEDIA_URL_TTL_MS, now = Date.now() } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(String(attachmentId || ""))) throw whatsappError("Invalid attachment");
  const url = new URL(`${resolveWebhookBaseUrl()}${WHATSAPP_PUBLIC_MEDIA_PATH}/${attachmentId}`);
  if (url.protocol !== "https:") throw whatsappError("Configure a public HTTPS application base URL (TELNYX_WEBHOOK_BASE_URL or APP_BASE_URL) before sending media", 503);
  const expiresAt = now + ttlMs;
  url.searchParams.set("exp", String(expiresAt));
  url.searchParams.set("sig", signWhatsAppMedia(attachmentId, expiresAt));
  return url.href;
}
export function verifyWhatsAppMediaToken(attachmentId, exp, sig, now = Date.now()) {
  if (!/^[0-9a-f-]{36}$/i.test(String(attachmentId || "")) || !/^\d{1,16}$/.test(String(exp || "")) || !/^[0-9a-f]{64}$/.test(String(sig || ""))) return false;
  if (Number(exp) <= now) return false;
  let expected;
  try { expected = signWhatsAppMedia(attachmentId, Number(exp)); } catch { return false; }
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(String(sig), "hex"));
}

// Inbound media lives on Telnyx for a limited time; download it once and keep
// the bytes with the conversation. Only Telnyx hosts receive the API key.
export async function downloadWhatsAppMedia(url, { apiKey = "", maxBytes = MAX_INBOUND_MEDIA_BYTES, fetchImpl = fetch } = {}) {
  let source;
  try { source = new URL(url); } catch { throw whatsappError("Inbound media URL is invalid"); }
  if (source.protocol !== "https:") throw whatsappError("Inbound media URL must use HTTPS");
  const host = source.hostname.toLowerCase();
  const headers = { Accept: "*/*" };
  if (apiKey && (host === "telnyx.com" || host.endsWith(".telnyx.com"))) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetchImpl(source, { headers, redirect: "follow", cache: "no-store", signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw whatsappError(`Media download failed (HTTP ${response.status})`, 502);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw whatsappError(`Media exceeds the ${Math.round(maxBytes / 1048576)} MB storage limit`, 413);
  const chunks = []; let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw whatsappError("Media download returned no body", 502);
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw whatsappError(`Media exceeds the ${Math.round(maxBytes / 1048576)} MB storage limit`, 413); }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks);
  if (!bytes.length) throw whatsappError("Media download returned an empty file", 502);
  return { bytes, contentType: String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(), contentHash: createHash("sha256").update(bytes).digest("hex") };
}

const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4", "video/3gpp": "3gp", "audio/aac": "aac", "audio/mp4": "m4a",
  "audio/mpeg": "mp3", "audio/amr": "amr", "audio/ogg": "ogg", "audio/wav": "wav", "application/pdf": "pdf", "text/plain": "txt", "text/csv": "csv", "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx", "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx" };
export function whatsappMediaFilename({ kind, filename, contentType, providerMessageId }) {
  const safe = String(filename || "").replace(/[\x00-\x1f\x7f/\\]/g, "_").trim().slice(0, 240);
  if (safe && /\.[a-z0-9]{1,8}$/i.test(safe)) return safe;
  const extension = EXTENSIONS[String(contentType || "").toLowerCase()] || ({ image: "jpg", video: "mp4", audio: "ogg", sticker: "webp" }[kind] || "bin");
  return `${safe || `${kind || "media"}-${String(providerMessageId || "").replace(/[^a-zA-Z0-9_-]+/g, "").slice(0, 24) || "inbound"}`}.${extension}`;
}

// Sticker conversion: WhatsApp stickers are 512×512 WebP files of at most
// 100 KB (static). Lower the quality until the size limit is met.
export async function toWhatsAppSticker(bytes) {
  const { default: sharp } = await import("sharp");
  const base = sharp(bytes, { animated: false }).resize(512, 512, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } });
  for (const quality of [90, 80, 70, 60, 50, 40, 30, 20]) {
    const output = await base.clone().webp({ quality, alphaQuality: quality, effort: 4 }).toBuffer();
    if (output.length <= WHATSAPP_MEDIA_RULES.sticker.staticMaxBytes) return output;
  }
  throw whatsappError("The picture could not be reduced to a 100 KB sticker. Choose a simpler image.");
}
// Transcoding for pictures WhatsApp does not accept as images (GIF, WebP).
export async function toWhatsAppImage(bytes) {
  const { default: sharp } = await import("sharp");
  return sharp(bytes, { animated: false }).flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: 88 }).toBuffer();
}

// Magic-number checks for the media types an agent may send.
export function validateWhatsAppMediaBytes(bytes, type) {
  const head = bytes.subarray(0, 16), hex = head.toString("hex"), ascii = head.toString("ascii");
  const zip = /^504b(0304|0506|0708)/.test(hex), ole = hex.startsWith("d0cf11e0a1b11ae1"), text = !bytes.includes(0);
  const signatures = {
    "image/png": () => hex.startsWith("89504e470d0a1a0a"), "image/jpeg": () => hex.startsWith("ffd8ff"),
    "image/gif": () => /^GIF8[79]a/.test(ascii), "image/webp": () => ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP",
    "video/mp4": () => ascii.slice(4, 8) === "ftyp", "video/3gpp": () => ascii.slice(4, 8) === "ftyp",
    "audio/aac": () => (head[0] === 255 && (head[1] & 246) === 240) || ascii.startsWith("ADIF"), "audio/mp4": () => ascii.slice(4, 8) === "ftyp",
    "audio/mpeg": () => ascii.startsWith("ID3") || (head[0] === 255 && (head[1] & 224) === 224), "audio/amr": () => ascii.startsWith("#!AMR"),
    "audio/ogg": () => ascii.startsWith("OggS"), "audio/wav": () => ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE",
    "application/pdf": () => ascii.startsWith("%PDF-"), "text/plain": () => text, "text/csv": () => text, "text/markdown": () => text,
    "application/msword": () => ole, "application/vnd.ms-excel": () => ole, "application/vnd.ms-powerpoint": () => ole,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": () => zip,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": () => zip,
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": () => zip,
  };
  if (!bytes.length || !signatures[type]?.()) throw whatsappError("File content does not match a supported WhatsApp media type");
}
