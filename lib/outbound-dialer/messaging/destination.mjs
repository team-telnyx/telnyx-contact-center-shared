// Browser-safe destination resolution for messaging campaigns. Destination
// fields are contact-method slots ("number:mobile") or contact-list columns,
// tried in the supervisor's order; the first valid address wins.
import { DESTINATION_GROUPS } from "./campaign-config.mjs";

export function normalizePhoneAddress(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.startsWith("+") ? `+${raw.slice(1).replace(/\D/g, "")}` : raw.replace(/\D/g, "");
  if (!/^\+?[1-9]\d{6,14}$/.test(normalized)) return null;
  return normalized.startsWith("+") ? normalized : `+${normalized}`;
}

export function normalizeEmailAddress(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function normalizeMessagingAddress(channel, value) {
  return channel === "email" ? normalizeEmailAddress(value) : normalizePhoneAddress(value);
}

const parse = (value, fallback = {}) => {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

const FALLBACK_COLUMNS = {
  sms: ["phone_number", "phone", "mobile", "msisdn", "tel", "cell"],
  whatsapp: ["whatsapp", "phone_number", "phone", "mobile", "msisdn", "tel"],
  email: ["email", "email_address", "e-mail", "mail"],
};

export function resolveMessagingDestination({ channel = "sms", destinationFields = [], rowData, contactMethods } = {}) {
  const row = parse(rowData, {});
  const methods = parse(contactMethods, {});
  const candidates = [];
  for (const field of Array.isArray(destinationFields) ? destinationFields : []) {
    const key = String(field || "").trim();
    if (!key) continue;
    if (key.includes(":")) {
      const [group, slot] = key.split(":");
      candidates.push({ field: key, value: methods?.[group]?.[slot] });
    } else candidates.push({ field: key, value: row?.[key] });
  }
  if (!candidates.length) {
    for (const group of DESTINATION_GROUPS[channel] || []) for (const [slot, value] of Object.entries(methods?.[group] || {})) candidates.push({ field: `${group}:${slot}`, value });
    for (const column of FALLBACK_COLUMNS[channel] || []) if (row?.[column]) candidates.push({ field: column, value: row[column] });
  }
  for (const candidate of candidates) {
    const address = normalizeMessagingAddress(channel, candidate.value);
    if (address) return { address, field: candidate.field };
  }
  return { address: null, field: null };
}
