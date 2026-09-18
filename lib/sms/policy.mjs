// Browser-safe SMS policy helpers: address normalization, inbound payload
// normalization, opt-out keywords and the monotonic delivery reducer.
import { smsSegments } from "./segments.mjs";

export const smsError = (message, status = 400) => Object.assign(new Error(message), { status });

export function normalizeE164(value) {
  const digits = String(value || "").trim().replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(digits)) throw smsError("Enter a phone number in E.164 format, for example +14155550123");
  return digits;
}
export const isE164 = (value) => { try { normalizeE164(value); return true; } catch { return false; } };

// Standard carrier keywords. Telnyx applies its own STOP/START/HELP handling per
// messaging profile; Contact Center mirrors the state so agents never send to an
// opted-out number and the conversation shows why replies are blocked.
export const OPT_OUT_KEYWORDS = Object.freeze(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
export const OPT_IN_KEYWORDS = Object.freeze(["START", "UNSTOP", "YES", "SUBSCRIBE"]);
export const HELP_KEYWORDS = Object.freeze(["HELP", "INFO"]);

export function classifySmsText(text) {
  const word = String(text || "").trim().toUpperCase().replace(/[.!?]+$/, "");
  if (OPT_OUT_KEYWORDS.includes(word)) return "opt_out";
  if (OPT_IN_KEYWORDS.includes(word)) return "opt_in";
  if (HELP_KEYWORDS.includes(word)) return "help";
  return "customer";
}

// Telnyx `message.received` payload → canonical inbound record.
export function normalizeInboundSms(payload) {
  const from = payload?.from?.phone_number || payload?.from || "";
  const to = Array.isArray(payload?.to) ? payload.to[0]?.phone_number || payload.to[0] : payload?.to;
  if (!payload?.id || !from || !to) throw smsError("Inbound SMS payload is missing id, from or to", 400);
  const media = Array.isArray(payload.media) ? payload.media
    .filter((item) => item && typeof item.url === "string" && /^https:\/\//.test(item.url))
    .map((item) => ({ url: item.url, content_type: item.content_type || null, size: item.size ?? null })) : [];
  return {
    providerId: String(payload.id), from: String(from), to: String(to),
    text: typeof payload.text === "string" ? payload.text : "",
    type: payload.type === "MMS" ? "MMS" : "SMS",
    encoding: payload.encoding || null, parts: Number.isInteger(payload.parts) ? payload.parts : null,
    messagingProfileId: payload.messaging_profile_id || null,
    receivedAt: payload.received_at || null, media,
    carrier: payload.from?.carrier || null, lineType: payload.from?.line_type || null,
  };
}

// Provider `to[].status` values for our outbound message, ordered so a late or
// duplicated webhook can never move a message backwards.
const RANK = { queued: 0, accepted: 1, sending: 2, sent: 3, delivery_unconfirmed: 4, delivered: 5,
  sending_failed: 5, delivery_failed: 5, failed: 5, ambiguous: 1 };
export const SMS_TERMINAL_STATUSES = Object.freeze(["delivered", "sending_failed", "delivery_failed", "failed", "delivery_unconfirmed"]);
export function reduceSmsDelivery(previous, incoming) {
  if (!incoming?.status || !(incoming.status in RANK)) return null;
  if (!previous) return incoming;
  if (SMS_TERMINAL_STATUSES.includes(previous.status) && previous.status !== incoming.status) return null;
  if ((RANK[incoming.status] ?? 0) < (RANK[previous.status] ?? 0)) return null;
  if (previous.status === incoming.status && previous.occurred_at && incoming.occurredAt
    && Date.parse(incoming.occurredAt) <= Date.parse(previous.occurred_at)) return null;
  return incoming;
}

// Delivery status from a `message.sent` / `message.finalized` payload.
export function outboundStatusFromPayload(eventType, payload) {
  const recipient = Array.isArray(payload?.to) ? payload.to[0] : null;
  const status = recipient?.status || (eventType === "message.finalized" ? "delivery_unconfirmed" : "sent");
  const error = Array.isArray(payload?.errors) && payload.errors[0] ? payload.errors[0] : null;
  return {
    status: status in RANK ? status : (eventType === "message.finalized" ? "delivery_unconfirmed" : "sent"),
    occurredAt: payload?.completed_at || payload?.sent_at || null,
    errorCode: error?.code ? String(error.code) : null,
    errorDetail: error?.detail || error?.title || null,
  };
}

export const SMS_MAX_BODY_CHARS = 1600;
export function validateOutboundSmsText(text) {
  if (typeof text !== "string" || !text.trim()) throw smsError("Enter a message before sending");
  if (text.length > SMS_MAX_BODY_CHARS) throw smsError(`SMS text is limited to ${SMS_MAX_BODY_CHARS} characters`);
  const stats = smsSegments(text);
  if (stats.tooLong) throw smsError(`The message would need ${stats.parts} parts; shorten it to at most 10`);
  return { text: text.trim(), stats };
}
