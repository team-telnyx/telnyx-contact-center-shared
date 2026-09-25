// Browser-safe WhatsApp policy helpers: media rules, inbound payload
// normalization, the 24-hour customer service window, outbound payload
// builders and the monotonic delivery reducer. Provider limits follow the
// Telnyx "Send WhatsApp messages" guide and Meta's media specifications.

import { parseLatitude, parseLongitude } from "../contact-center/maps.mjs";

export const whatsappError = (message, status = 400) => Object.assign(new Error(message), { status });

export const WHATSAPP_MAX_TEXT_BYTES = 4096;
export const WHATSAPP_MAX_CAPTION_BYTES = 1024;
export const WHATSAPP_MAX_FILES = 5;
export const WHATSAPP_MAX_CONTACTS = 5;
// Reactions offered on a customer bubble; any emoji from the picker also works.
export const WHATSAPP_QUICK_REACTIONS = Object.freeze(["👍", "❤️", "😂", "😮", "😢", "🙏"]);
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const WHATSAPP_MEDIA_KINDS = Object.freeze(["image", "video", "audio", "document", "sticker"]);

const MB = 1048576;
export const WHATSAPP_MEDIA_RULES = Object.freeze({
  image: Object.freeze({ label: "Image", mimeTypes: Object.freeze(["image/jpeg", "image/png"]), maxBytes: 5 * MB, caption: true, filename: false }),
  video: Object.freeze({ label: "Video", mimeTypes: Object.freeze(["video/mp4", "video/3gpp"]), maxBytes: 16 * MB, caption: true, filename: false }),
  audio: Object.freeze({ label: "Audio", mimeTypes: Object.freeze(["audio/aac", "audio/mp4", "audio/mpeg", "audio/amr", "audio/ogg"]), maxBytes: 16 * MB, caption: false, filename: false }),
  document: Object.freeze({ label: "Document", mimeTypes: Object.freeze(["application/pdf", "text/plain", "application/msword", "application/vnd.ms-excel", "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"]), maxBytes: 100 * MB, caption: true, filename: true }),
  sticker: Object.freeze({ label: "Sticker", mimeTypes: Object.freeze(["image/webp"]), maxBytes: 500 * 1024, staticMaxBytes: 100 * 1024, caption: false, filename: false }),
});
// Everything an agent may attach. Images and GIF/WebP pictures may become
// stickers on request; the server converts them to 512×512 WebP.
export const WHATSAPP_OUTBOUND_MIME_TYPES = Object.freeze([...new Set([
  ...Object.values(WHATSAPP_MEDIA_RULES).flatMap((rule) => rule.mimeTypes), "image/webp", "image/gif", "audio/wav", "text/csv", "text/markdown",
])]);
// Files that must be transcoded before WhatsApp accepts them.
export const WHATSAPP_TRANSCODED_MIME_TYPES = Object.freeze(["image/webp", "image/gif", "audio/wav", "text/csv", "text/markdown"]);

export const utf8Bytes = (text) => new TextEncoder().encode(String(text ?? "")).length;
const normalizeMime = (value) => String(value || "").split(";")[0].trim().toLowerCase();

// Media kind for a file. `preferred` lets the agent choose "sticker" for a
// picture; anything else falls back to the type-based default.
export function whatsappMediaKind(contentType, filename = "", preferred = null) {
  const type = normalizeMime(contentType);
  if (preferred === "sticker" && (type.startsWith("image/"))) return "sticker";
  if (preferred === "document" && type) return "document";
  // WebP and GIF pictures are transcoded to JPEG unless the agent asks for a sticker.
  if (type === "image/webp" || type === "image/gif") return "image";
  for (const kind of ["image", "video", "audio", "document", "sticker"]) if (WHATSAPP_MEDIA_RULES[kind].mimeTypes.includes(type)) return kind;
  if (type === "audio/wav") return "audio";
  if (type === "text/csv" || type === "text/markdown") return "document";
  if (/\.(pdf|docx?|xlsx?|pptx?|txt)$/i.test(filename)) return "document";
  return null;
}

export function validateWhatsAppMedia({ contentType, byteSize, name = "" }, kind) {
  const rule = WHATSAPP_MEDIA_RULES[kind];
  if (!rule) throw whatsappError("Unsupported WhatsApp media type");
  const type = normalizeMime(contentType);
  if (!rule.mimeTypes.includes(type) && !(kind === "sticker" && type.startsWith("image/")) && !(kind === "image" && ["image/webp", "image/gif"].includes(type))
    && !(kind === "audio" && type === "audio/wav") && !(kind === "document" && ["text/csv", "text/markdown"].includes(type))) {
    throw whatsappError(`${name || "This file"} (${type || "unknown type"}) cannot be sent as a WhatsApp ${rule.label.toLowerCase()}`);
  }
  if (!Number.isFinite(byteSize) || byteSize <= 0) throw whatsappError("Attachment is empty");
  if (byteSize > rule.maxBytes) throw whatsappError(`${rule.label}s are limited to ${Math.round(rule.maxBytes / MB * 10) / 10 >= 1 ? `${Math.round(rule.maxBytes / MB)} MB` : `${Math.round(rule.maxBytes / 1024)} KB`} on WhatsApp`);
  return { kind, contentType: type };
}

export function validateOutboundWhatsAppText(text, { allowEmpty = false, caption = false } = {}) {
  const value = typeof text === "string" ? text.trim() : "";
  if (!value) { if (allowEmpty) return ""; throw whatsappError("Enter a message before sending"); }
  const limit = caption ? WHATSAPP_MAX_CAPTION_BYTES : WHATSAPP_MAX_TEXT_BYTES;
  if (utf8Bytes(value) > limit) throw whatsappError(caption ? `Captions are limited to ${WHATSAPP_MAX_CAPTION_BYTES} bytes` : `WhatsApp text is limited to ${WHATSAPP_MAX_TEXT_BYTES} bytes`);
  return value;
}

// The window opens with the customer's latest inbound message and lasts 24
// hours. Free-form text and media need an open window; templates do not.
export function whatsappConversationWindow(lastInboundAt, now = Date.now()) {
  const at = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
  if (!Number.isFinite(at)) return { open: false, expiresAt: null, remainingMs: 0 };
  const expires = at + WHATSAPP_WINDOW_MS;
  return { open: expires > now, expiresAt: new Date(expires).toISOString(), remainingMs: Math.max(0, expires - now) };
}

function address(value) {
  if (Array.isArray(value)) return address(value[0]);
  if (value && typeof value === "object") return String(value.phone_number || value.address || value.wa_id || "").trim();
  return String(value || "").trim();
}
const mediaOf = (body, kind) => (body && typeof body === "object" && body[kind] && typeof body[kind] === "object") ? body[kind] : null;

// Telnyx `message.received` payload (type WHATSAPP) → canonical inbound record.
// The message body arrives as `whatsapp_message` (or `body`); media may also be
// listed in the generic `media[]` array. Media URLs must be HTTPS.
export function normalizeInboundWhatsApp(payload) {
  const from = address(payload?.from), to = address(payload?.to);
  if (!payload?.id || !from || !to) throw whatsappError("Inbound WhatsApp payload is missing id, from or to", 400);
  const body = (payload.whatsapp_message && typeof payload.whatsapp_message === "object") ? payload.whatsapp_message
    : (payload.body && typeof payload.body === "object") ? payload.body : {};
  let kind = String(body.type || (Array.isArray(payload.media) && payload.media.length ? "image" : "text")).toLowerCase();
  if (kind === "button" || kind === "list_reply" || kind === "button_reply") kind = "interactive";
  const generic = Array.isArray(payload.media) ? payload.media.find((item) => item && typeof item.url === "string") : null;
  const nested = WHATSAPP_MEDIA_KINDS.includes(kind) ? mediaOf(body, kind) : null;
  const mediaUrl = String(nested?.url || nested?.link || generic?.url || "");
  const media = /^https:\/\//.test(mediaUrl) ? {
    kind: WHATSAPP_MEDIA_KINDS.includes(kind) ? kind : "document",
    url: mediaUrl,
    contentType: normalizeMime(nested?.mime_type || nested?.mimeType || nested?.content_type || generic?.content_type || generic?.mime_type || ""),
    filename: String(nested?.filename || generic?.filename || ""),
    caption: typeof nested?.caption === "string" ? nested.caption : "",
    sha256: String(nested?.sha256 || generic?.sha256 || ""),
    size: Number.isFinite(Number(nested?.size ?? generic?.size)) ? Number(nested?.size ?? generic?.size) : null,
  } : null;
  const interactive = body.interactive && typeof body.interactive === "object" ? body.interactive : null;
  const reply = interactive?.list_reply || interactive?.button_reply || (body.button && typeof body.button === "object" ? { id: body.button.payload || body.button.id, title: body.button.text || body.button.title } : null);
  const text = typeof payload.text === "string" && payload.text ? payload.text
    : typeof body.text?.body === "string" ? body.text.body
      : media?.caption || (reply?.title ? String(reply.title) : "") || (body.location?.name ? String(body.location.name) : "")
        || (body.contacts?.[0]?.name?.formatted_name ? String(body.contacts[0].name.formatted_name) : "") || (body.reaction?.emoji ? String(body.reaction.emoji) : "");
  return {
    providerId: String(payload.id), from, to, kind, text: text || "",
    media, receivedAt: payload.received_at || null, messagingProfileId: payload.messaging_profile_id || null,
    profileName: String(payload.from?.display_name || payload.from?.name || payload.profile_name || body.profile?.name || payload.contacts?.[0]?.profile?.name || "").trim().slice(0, 120) || null,
    wamid: String(body.id || payload.whatsapp_message_id || "") || null,
    context: body.context && typeof body.context === "object" ? { message_id: body.context.message_id || body.context.id || null } : null,
    interactiveReply: reply ? { id: String(reply.id ?? ""), title: String(reply.title ?? ""), description: String(reply.description ?? "") } : null,
    location: body.location && typeof body.location === "object" ? { latitude: String(body.location.latitude ?? ""), longitude: String(body.location.longitude ?? ""), name: String(body.location.name || ""), address: String(body.location.address || "") } : null,
    contacts: Array.isArray(body.contacts) ? body.contacts.slice(0, 20).map((contact) => ({
      name: String(contact?.name?.formatted_name || [contact?.name?.first_name, contact?.name?.last_name].filter(Boolean).join(" ") || ""),
      phones: Array.isArray(contact?.phones) ? contact.phones.map((phone) => String(phone?.phone || phone?.wa_id || "")).filter(Boolean) : [],
      emails: Array.isArray(contact?.emails) ? contact.emails.map((email) => String(email?.email || "")).filter(Boolean) : [],
    })) : null,
    reaction: body.reaction && typeof body.reaction === "object" ? { message_id: String(body.reaction.message_id || ""), emoji: String(body.reaction.emoji || "") } : null,
  };
}

// Text shown for a message whose content is not plain text.
export function describeWhatsAppContent(inbound) {
  if (inbound.text) return inbound.text;
  switch (inbound.kind) {
    case "image": return "[Image]";
    case "video": return "[Video]";
    case "audio": return "[Voice message]";
    case "document": return inbound.media?.filename ? `[Document: ${inbound.media.filename}]` : "[Document]";
    case "sticker": return "[Sticker]";
    case "location": return inbound.location ? `[Location: ${[inbound.location.name, inbound.location.address].filter(Boolean).join(", ") || `${inbound.location.latitude}, ${inbound.location.longitude}`}]` : "[Location]";
    case "contacts": return inbound.contacts?.length ? `[Contact: ${inbound.contacts.map((c) => c.name || c.phones[0]).filter(Boolean).join(", ")}]` : "[Contact card]";
    case "reaction": return inbound.reaction?.emoji ? `Reacted ${inbound.reaction.emoji}` : "[Reaction]";
    case "interactive": return inbound.interactiveReply?.title || "[Interactive reply]";
    case "unsupported": return "[Unsupported message type]";
    default: return `[${inbound.kind || "message"}]`;
  }
}

// Outbound delivery states, ordered so a late or duplicated webhook can never
// move a message backwards. `read` follows `delivered`; failures are terminal.
const RANK = { queued: 0, accepted: 1, ambiguous: 1, sending: 2, sent: 3, delivery_unconfirmed: 4, delivered: 4, read: 5,
  sending_failed: 6, delivery_failed: 6, failed: 6, undeliverable: 6 };
export const WHATSAPP_FAILED_STATUSES = Object.freeze(["sending_failed", "delivery_failed", "failed", "undeliverable"]);
export const WHATSAPP_TERMINAL_STATUSES = Object.freeze(["read", ...WHATSAPP_FAILED_STATUSES]);
// Once one of these is known the reconciliation poll stops; `read` only ever
// arrives through webhooks.
export const WHATSAPP_SYNC_DONE_STATUSES = Object.freeze(["delivered", "delivery_unconfirmed", ...WHATSAPP_TERMINAL_STATUSES]);
export function normalizeWhatsAppStatus(status) {
  const value = String(status || "").trim().toLowerCase();
  if (value === "rejected") return "failed";
  if (value === "finalized") return "sent";
  return value in RANK ? value : null;
}
export function reduceWhatsAppDelivery(previous, incoming) {
  const status = normalizeWhatsAppStatus(incoming?.status);
  if (!status) return null;
  const next = { ...incoming, status };
  if (!previous) return next;
  if (WHATSAPP_TERMINAL_STATUSES.includes(previous.status) && previous.status !== status) return null;
  if ((RANK[status] ?? 0) < (RANK[previous.status] ?? 0)) return null;
  if (previous.status === status && previous.occurred_at && incoming.occurredAt && Date.parse(incoming.occurredAt) <= Date.parse(previous.occurred_at)) return null;
  return next;
}

// Delivery status from a message.sent / message.delivered / message.read /
// message.failed / message.finalized payload.
export function outboundStatusFromWhatsAppPayload(eventType, payload) {
  const recipient = Array.isArray(payload?.to) ? payload.to[0] : (payload?.to && typeof payload.to === "object" ? payload.to : null);
  const byEvent = { "message.delivered": "delivered", "message.read": "read", "message.failed": "delivery_failed", "message.undeliverable": "undeliverable", "message.sent": "sent", "message.finalized": "delivery_unconfirmed" }[eventType];
  const raw = normalizeWhatsAppStatus(recipient?.status || payload?.delivery_status || payload?.status);
  const status = (raw && !(eventType === "message.finalized" && raw === "queued")) ? raw : (byEvent || "sent");
  const error = Array.isArray(payload?.errors) && payload.errors[0] ? payload.errors[0] : null;
  return { status, occurredAt: payload?.completed_at || payload?.read_at || payload?.delivered_at || payload?.sent_at || null,
    errorCode: error?.code ? String(error.code) : null, errorDetail: error?.detail || error?.title || null };
}

// Payload builders for POST /v2/messages/whatsapp.
export function buildWhatsAppTextMessage(text) {
  return { type: "text", text: { body: text, preview_url: false } };
}
export function buildWhatsAppMediaMessage({ kind, link, caption = "", filename = "" }) {
  const rule = WHATSAPP_MEDIA_RULES[kind];
  if (!rule) throw whatsappError("Unsupported WhatsApp media type");
  const media = { link };
  if (rule.caption && caption) media.caption = caption;
  if (rule.filename && filename) media.filename = filename;
  return { type: kind, [kind]: media };
}
export function buildWhatsAppTemplateMessage({ templateId = null, name = null, language = null, components = [] }) {
  if (!templateId && !(name && language)) throw whatsappError("Select an approved template");
  const template = templateId ? { template_id: String(templateId) } : { name: String(name), language: { policy: "deterministic", code: String(language) } };
  if (Array.isArray(components) && components.length) template.components = components;
  return { type: "template", template };
}
// `messaging_profile_id` names the sending profile. Telnyx requires it when the
// `from` number is not SMS-enabled, which is the case for WhatsApp-only numbers:
// without it the send is rejected with 40305 ("'from' address ... not
// associated with the sending messaging profile").
// Shared location: coordinates are validated here and stored as strings, the
// shape inbound locations already use, so bubbles render both directions alike.
export function normalizeWhatsAppLocation(input) {
  if (!input || typeof input !== "object") throw whatsappError("Location is required");
  const latitude = parseLatitude(input.latitude), longitude = parseLongitude(input.longitude);
  return { latitude: String(latitude), longitude: String(longitude), name: String(input.name || "").trim().slice(0, 120), address: String(input.address || "").trim().slice(0, 240) };
}
export function buildWhatsAppLocationMessage(input) {
  const location = normalizeWhatsAppLocation(input);
  const payload = { latitude: location.latitude, longitude: location.longitude };
  if (location.name) payload.name = location.name;
  if (location.address) payload.address = location.address;
  return { type: "location", location: payload };
}

// Contact card built from a Contacts directory row (`contacts` table).
const CONTACT_PHONE_FIELDS = [["mobile", "CELL"], ["phone", "MAIN"], ["business_phone_1", "WORK"], ["business_phone_2", "WORK"], ["home_phone_1", "HOME"], ["home_phone_2", "HOME"]];
const clean = (value, limit = 120) => String(value ?? "").trim().slice(0, limit);
export function whatsappContactCard(row) {
  if (!row || typeof row !== "object") throw whatsappError("Contact not found", 404);
  const first = clean(row.first_name), last = clean(row.last_name);
  const formatted = clean(row.display_name) || [first, last].filter(Boolean).join(" ") || clean(row.company_name);
  if (!formatted) throw whatsappError("This contact has no name to share");
  const seen = new Set(), phones = [];
  for (const [field, type] of CONTACT_PHONE_FIELDS) {
    const raw = clean(row[field], 40);
    if (!raw) continue;
    const digits = raw.replace(/[^\d+]/g, ""), key = digits.replace(/\D/g, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const phone = { phone: /^\+?\d+$/.test(digits) ? (digits.startsWith("+") ? digits : `+${digits}`) : raw, type };
    if (/^\+[1-9]\d{7,14}$/.test(phone.phone)) phone.wa_id = phone.phone.slice(1);
    phones.push(phone);
  }
  const emails = [row.email_address_1, row.email_address_2].map((value) => clean(value, 254)).filter((value, index, all) => value && all.indexOf(value) === index)
    .map((email, index) => ({ email, type: index === 0 ? "WORK" : "HOME" }));
  const card = { name: { formatted_name: formatted, ...(first ? { first_name: first } : {}), ...(last ? { last_name: last } : {}) } };
  if (phones.length) card.phones = phones;
  if (emails.length) card.emails = emails;
  const org = { ...(clean(row.company_name) ? { company: clean(row.company_name) } : {}), ...(clean(row.job_title) ? { title: clean(row.job_title) } : {}), ...(clean(row.department) ? { department: clean(row.department) } : {}) };
  if (Object.keys(org).length) card.org = org;
  const address = Object.fromEntries([["street", row.address_street], ["city", row.address_city], ["state", row.address_state], ["zip", row.address_zip], ["country", row.address_country]]
    .map(([key, value]) => [key, clean(value)]).filter(([, value]) => value));
  if (Object.keys(address).length) card.addresses = [{ ...address, type: "WORK" }];
  return card;
}
// Device-selected contacts are never imported into the CRM. Accept only the
// explicit card fields; strip identifiers, notes, photos and arbitrary objects.
export function normalizeWhatsAppDeviceContacts(input) {
  if (!Array.isArray(input) || !input.length || input.length > WHATSAPP_MAX_CONTACTS) {
    throw whatsappError(`Select between 1 and ${WHATSAPP_MAX_CONTACTS} contacts`);
  }
  const fields = {
    display_name: 120, first_name: 120, last_name: 120, company_name: 120,
    mobile: 40, phone: 40, business_phone_1: 40, business_phone_2: 40, home_phone_1: 40, home_phone_2: 40,
    email_address_1: 254, email_address_2: 254,
  };
  return input.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw whatsappError("Invalid contact card");
    const row = {};
    for (const [key, limit] of Object.entries(fields)) {
      if (value[key] == null) continue;
      if (typeof value[key] !== "string" || value[key].length > limit) throw whatsappError(`Invalid contact ${key}`);
      row[key] = value[key].trim();
    }
    const card = whatsappContactCard(row);
    // Local iPhone numbers have no implied country code.
    for (const phone of card.phones || []) {
      const source = CONTACT_PHONE_FIELDS.map(([key]) => row[key]).find(value =>
        value && value.replace(/\D/g, "") === phone.phone.replace(/\D/g, ""));
      if (source && !source.startsWith("+")) { phone.phone = source; delete phone.wa_id; }
    }
    return card;
  });
}

// The shape stored on the message and rendered by bubbles (same as inbound cards).
export function summarizeWhatsAppContacts(cards) {
  return cards.map((card) => ({ name: card.name?.formatted_name || "", phones: (card.phones || []).map((phone) => phone.phone), emails: (card.emails || []).map((email) => email.email), company: card.org?.company || "" }));
}
export function buildWhatsAppContactsMessage(cards) {
  if (!Array.isArray(cards) || !cards.length) throw whatsappError("Select at least one contact");
  if (cards.length > WHATSAPP_MAX_CONTACTS) throw whatsappError(`Send at most ${WHATSAPP_MAX_CONTACTS} contacts per message`);
  return { type: "contacts", contacts: cards };
}

// Reaction to a customer message. `messageId` is the provider (Telnyx) id of
// the customer's message; an empty emoji removes the agent's reaction.
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2})(?:\uFE0F|\p{Emoji_Modifier}|\u200D\p{Extended_Pictographic}\uFE0F?)*$/u;
export function buildWhatsAppReactionMessage({ messageId, emoji }) {
  const id = String(messageId || "").trim(), symbol = String(emoji || "").trim();
  if (!id) throw whatsappError("Choose the message to react to");
  if (symbol && !EMOJI.test(symbol)) throw whatsappError("Choose a single emoji for the reaction");
  return { type: "reaction", reaction: { message_id: id, emoji: symbol } };
}

export function buildWhatsAppOutbound({ from, to, message, webhookUrl = null, messagingProfileId = null }) {
  const payload = { from, to, type: "WHATSAPP", whatsapp_message: message };
  if (messagingProfileId) payload.messaging_profile_id = String(messagingProfileId);
  if (webhookUrl) payload.webhook_url = webhookUrl;
  return payload;
}

// Renders a template into the text stored on the agent's message bubble.
export function describeTemplateSend({ name, language, components = [] }) {
  const values = [];
  for (const component of components || []) for (const parameter of component?.parameters || []) if (parameter?.type === "text" && parameter.text) values.push(String(parameter.text));
  return `Template “${name || "template"}”${language ? ` (${language})` : ""}${values.length ? `: ${values.join(" · ")}` : ""}`;
}
