// Launch catalog published in the Telnyx AI Assistant avatars guide.
export const TELNYX_AVATAR_PROVIDER = "telnyx";
export const TELNYX_AVATAR_MODEL = "foxtrot-1";
export const TELNYX_AVATAR_IDS = Object.freeze(["elena", "ben", "jordan", "lin", "avery", "raphael"]);
export const TELNYX_AVATAR_BACKGROUNDS = Object.freeze(["studio", "office", "reception"]);
// Syntax only. Availability and organization ownership are checked against
// the provider catalog on the server, never inferred from a fixed stock list.
export const isTelnyxAvatarId = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value);
// Official Portal preview assets, bundled locally to avoid versioned Portal
// URLs expiring. See public/images/avatars/telnyx/SOURCES.md for provenance.
export const telnyxAvatarPreviewUrl = (id) => TELNYX_AVATAR_IDS.includes(id) ? `/images/avatars/telnyx/${id}.png` : "";
export const TELNYX_AVATARS = Object.freeze(TELNYX_AVATAR_IDS.map((id) => ({
  id, name: id[0].toUpperCase() + id.slice(1), avatarModel: TELNYX_AVATAR_MODEL,
  previewUrl: telnyxAvatarPreviewUrl(id),
  portraitPreviewUrl: telnyxAvatarPreviewUrl(id),
  landscapePreviewUrl: telnyxAvatarPreviewUrl(id),
})));
