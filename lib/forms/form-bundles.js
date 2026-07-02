import { createDefaultForm, normalizeFormDefinition, slugifyFormName, validateFormDefinition } from "./form-schema.js";

export const FORM_BUNDLE_TYPE = "telnyx-contact-center-form";
export const FORM_BUNDLE_VERSION = 1;

const MEDIA_URL_KEYS = new Set([
  "src", "imageUrl", "imageURL", "image_url", "imageSrc", "image_src", "avatarUrl", "avatar_url", "heroImage", "hero_image",
  "backgroundImage", "background_image", "thumbnailUrl", "thumbnail_url", "posterUrl", "poster_url", "url", "publicUrl", "public_url", "path",
]);
const MEDIA_TITLE_KEYS = new Set(["imageTitle", "image_title", "title", "alt", "display_name", "displayName"]);
const IMAGE_FIELD_TYPES = new Set(["image", "avatar", "hero", "card"]);
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i;

function cleanUrl(value) {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url) return "";
  if (url.startsWith("data:")) return ""; // Export metadata/URLs only; no base64 blobs in JSON bundles.
  if (url.startsWith("/") || /^https?:\/\//i.test(url)) return url;
  return IMAGE_EXT_RE.test(url) ? url : "";
}

function looksLikeMediaKey(key = "") {
  return MEDIA_URL_KEYS.has(key) || /(^|_)(image|avatar|hero|thumbnail|poster)(Url|URL|Src|Path|_url|_src|_path)?$/i.test(key);
}

function titleNear(source = {}) {
  if (!source || typeof source !== "object") return "";
  for (const key of MEDIA_TITLE_KEYS) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export function collectFormMediaReferences(form = {}) {
  const normalized = normalizeFormDefinition(form);
  const references = new Map();
  function add(url, context = {}) {
    const clean = cleanUrl(url);
    if (!clean) return;
    const existing = references.get(clean) || { url: clean, contexts: [], title: "" };
    if (context.title && !existing.title) existing.title = context.title;
    existing.contexts.push(context);
    references.set(clean, existing);
  }

  for (const field of normalized.schema?.fields || []) {
    const props = field.props || {};
    const title = titleNear(props) || field.label || "";
    if (IMAGE_FIELD_TYPES.has(field.type)) {
      [props.src, props.imageUrl, props.image_url, props.avatarUrl, props.heroImage, props.backgroundImage].forEach((value) => add(value, { fieldId: field.id, fieldType: field.type, prop: "known-image-prop", title }));
    }
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === "string" && looksLikeMediaKey(key)) add(value, { fieldId: field.id, fieldType: field.type, prop: key, title });
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (!item || typeof item !== "object") return;
          for (const [childKey, childValue] of Object.entries(item)) {
            if (typeof childValue === "string" && looksLikeMediaKey(childKey)) add(childValue, { fieldId: field.id, fieldType: field.type, prop: `${key}.${index}.${childKey}`, title: titleNear(item) || title });
          }
        });
      }
    }
  }
  return [...references.values()].map((item) => ({ ...item, contexts: item.contexts.slice(0, 10) }));
}

function publicAssetCandidate(asset = {}) {
  return String(asset.url || asset.publicUrl || asset.public_url || asset.src || asset.path || "").trim();
}

function filenameFromUrl(url = "") {
  try {
    const pathname = /^https?:\/\//i.test(url) ? new URL(url).pathname : String(url).split("?")[0];
    return pathname.split("/").pop() || "image";
  } catch {
    return String(url).split("?")[0].split("/").pop() || "image";
  }
}

export function normalizeMediaAssetForBundle(asset = {}, reference = {}) {
  const url = publicAssetCandidate(asset) || reference.url || "";
  if (!url) return null;
  const filename = asset.filename || asset.name || filenameFromUrl(url);
  const title = asset.title || asset.display_name || asset.displayName || reference.title || filename.replace(/\.[^.]+$/, "");
  return {
    filename,
    url,
    publicUrl: asset.publicUrl || asset.public_url || url,
    title,
    displayName: asset.displayName || asset.display_name || title,
    contentType: asset.contentType || asset.content_type || null,
    sizeBytes: asset.sizeBytes ?? asset.size_bytes ?? asset.size ?? null,
    metadata: asset.metadata && typeof asset.metadata === "object" ? asset.metadata : {},
    referencedBy: reference.contexts || [],
  };
}

export function buildFormExportBundle(form = {}, mediaAssets = [], options = {}) {
  const normalized = normalizeFormDefinition(form);
  const references = collectFormMediaReferences(normalized);
  const byUrl = new Map((mediaAssets || []).map((asset) => [publicAssetCandidate(asset), asset]).filter(([url]) => url));
  return {
    version: FORM_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    type: FORM_BUNDLE_TYPE,
    metadata: {
      source: "telnyx-contact-center",
      exportFormat: "json-url-media-references",
      note: "Media is exported as metadata plus stable URL/public path references only; binary/base64 file data is intentionally not embedded.",
      ...(options.metadata || {}),
    },
    form: normalized,
    mediaReferences: references,
    mediaAssets: references.map((reference) => normalizeMediaAssetForBundle(byUrl.get(reference.url) || { url: reference.url }, reference)).filter(Boolean),
  };
}

export function formExportFilename(form = {}) {
  const slug = slugifyFormName(form.slug || form.name || "form").slice(0, 80) || "form";
  const stamp = new Date().toISOString().slice(0, 10);
  return `${slug}-${stamp}.json`;
}

function extractFormFromBundle(input = {}) {
  if (input?.type === FORM_BUNDLE_TYPE && input.form) return input.form;
  if (input?.form && (input.form.schema || input.form.name)) return input.form;
  return input;
}

export function normalizeImportedForm(input = {}, options = {}) {
  const raw = extractFormFromBundle(input);
  const suffix = options.nameSuffix || "(imported)";
  const baseName = String(raw.name || "Imported agent form").trim() || "Imported agent form";
  const form = normalizeFormDefinition(createDefaultForm({ ...raw, name: `${baseName} ${suffix}`, slug: options.slug || `${slugifyFormName(baseName)}-${Date.now().toString(36)}`, status: "draft", version: 1 }));
  delete form.id;
  delete form.created_at;
  delete form.updated_at;
  delete form.published_at;
  form.status = "draft";
  form.version = 1;
  const validation = validateFormDefinition(form);
  return { form, validation };
}

export function extractBundleMediaAssets(input = {}) {
  const assets = Array.isArray(input?.mediaAssets) ? input.mediaAssets : [];
  const references = Array.isArray(input?.mediaReferences) ? input.mediaReferences : [];
  const byUrl = new Map();
  for (const item of [...assets, ...references]) {
    const url = publicAssetCandidate(item);
    if (!url || url.startsWith("data:")) continue;
    const existing = byUrl.get(url) || {};
    byUrl.set(url, { ...existing, ...item, url });
  }
  return [...byUrl.values()].map((asset) => normalizeMediaAssetForBundle(asset)).filter(Boolean);
}
