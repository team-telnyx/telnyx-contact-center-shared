// Telnyx credential connection helper for hard phones.
import crypto from "crypto";
import { buildTelnyxV2Url } from "../telnyx.js";

function telnyxHeaders(apiKey) {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
}

function errorDetail(data, fallback) {
  return data?.errors?.[0]?.detail || data?.errors?.[0]?.title || data?.errors?.[0]?.message || data?.message || fallback;
}

export function phoneConnectionUserName(mac) {
  const clean = String(mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (clean.length !== 12) throw new Error("Valid phone MAC is required to derive SIP username");
  return `hp${clean}`.slice(0, 32);
}

export function phoneConnectionName(mac) {
  const clean = String(mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  return `phone_${clean || "unknown"}`;
}

export function generatePhoneSipPassword() {
  return crypto.randomBytes(24).toString("base64url").slice(0, 32);
}

export async function listUnassignedPhoneNumbers({ limit = 250 } = {}) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return [];
  const numbers = [];
  const seen = new Set();
  for (let page = 1; page <= 5; page += 1) {
    const params = new URLSearchParams();
    params.set("page[size]", String(limit));
    params.set("page[number]", String(page));
    params.set("filter[status]", "active");
    const response = await fetch(`${buildTelnyxV2Url("/phone_numbers")}?${params.toString()}`, {
      headers: telnyxHeaders(apiKey),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Telnyx phone number list failed: ${errorDetail(data, `HTTP ${response.status}`)}`);
    const rows = Array.isArray(data?.data) ? data.data : [];
    for (const item of rows) {
      const connectionId = item?.connection_id || item?.voice?.connection_id || null;
      const number = item?.phone_number || null;
      if (!number || connectionId || seen.has(number)) continue;
      seen.add(number);
      numbers.push({ id: item.id, phone_number: number, status: item.status || null });
    }
    const currentPage = Number(data?.meta?.page_number || data?.meta?.page?.number || page);
    const totalPages = Number(data?.meta?.total_pages || data?.meta?.page?.total_pages || 0);
    if (rows.length < limit || (totalPages && currentPage >= totalPages)) break;
  }
  return numbers;
}

export async function createPhoneSipConnection({ label, mac, vendor, model, password }) {
  const apiKey = process.env.TELNYX_API_KEY;
  const outboundVoiceProfileId = process.env.TELNYX_OUTBOUND_VOICE_PROFILE;
  if (!apiKey || !outboundVoiceProfileId) {
    throw new Error("TELNYX_API_KEY and TELNYX_OUTBOUND_VOICE_PROFILE are required for hard phone SIP connections");
  }
  const userName = phoneConnectionUserName(mac);
  const sipPassword = password || generatePhoneSipPassword();
  const tags = [
    "hardphone",
    vendor ? `vendor:${String(vendor)}` : null,
    model ? `model:${String(model)}` : null,
    mac ? `mac:${String(mac).replace(/[^0-9a-f]/gi, "").toUpperCase()}` : null,
  ].filter(Boolean);
  const body = {
    active: true,
    connection_name: phoneConnectionName(mac),
    user_name: userName,
    password: sipPassword,
    anchorsite_override: "Latency",
    sip_uri_calling_preference: "unrestricted",
    encode_contact_header_enabled: true,
    webhook_event_url: process.env.TELNYX_HARDPHONE_WEBHOOK_URL || process.env.TELNYX_WEBHOOK_BASE_URL ? `${String(process.env.TELNYX_HARDPHONE_WEBHOOK_URL || process.env.TELNYX_WEBHOOK_BASE_URL).replace(/\/$/, "")}${process.env.TELNYX_HARDPHONE_WEBHOOK_URL ? "" : "/api/voice/webhook"}` : undefined,
    webhook_api_version: "2",
    tags,
    inbound: {
      dnis_number_format: "e164",
      ani_number_format: "E.164-national",
      codecs: ["G722", "G711U", "G711A", "G729"],
    },
    outbound: {
      outbound_voice_profile_id: outboundVoiceProfileId,
      instant_ringback_enabled: true,
      generate_ringback_tone: false,
    },
  };
  Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);
  const response = await fetch(buildTelnyxV2Url("/credential_connections"), {
    method: "POST",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Telnyx SIP connection create failed: ${errorDetail(data, `HTTP ${response.status}`)}`);
  const connection = data?.data;
  if (!connection?.id) throw new Error("Telnyx SIP connection create returned no id");
  return {
    id: connection.id,
    connection_id: connection.id,
    connection_name: connection.connection_name || body.connection_name,
    sip_username: connection.user_name || userName,
    sip_password: sipPassword,
    tags,
  };
}

export async function assignPhoneNumberToConnection(phoneNumberId, connectionId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey || !phoneNumberId || !connectionId) return null;
  const currentResponse = await fetch(buildTelnyxV2Url(`/phone_numbers/${encodeURIComponent(phoneNumberId)}`), {
    headers: telnyxHeaders(apiKey),
    cache: "no-store",
  });
  const currentData = await currentResponse.json().catch(() => ({}));
  if (!currentResponse.ok) throw new Error(`Telnyx phone number lookup failed: ${errorDetail(currentData, `HTTP ${currentResponse.status}`)}`);
  const currentNumber = currentData?.data || null;
  const currentConnectionId = currentNumber?.connection_id || currentNumber?.voice?.connection_id || null;
  if (currentConnectionId && currentConnectionId !== connectionId) {
    throw new Error("Selected phone number is already assigned to another Telnyx connection");
  }
  const response = await fetch(buildTelnyxV2Url(`/phone_numbers/${encodeURIComponent(phoneNumberId)}`), {
    method: "PATCH",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify({ connection_id: connectionId }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Telnyx phone number assignment failed: ${errorDetail(data, `HTTP ${response.status}`)}`);
  return data?.data || null;
}

export async function deletePhoneSipConnection(connectionId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey || !connectionId) return false;
  try {
    const response = await fetch(buildTelnyxV2Url(`/credential_connections/${encodeURIComponent(connectionId)}`), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function deleteLegacyPhoneCredential(credentialId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey || !credentialId) return false;
  try {
    const response = await fetch(buildTelnyxV2Url(`/telephony_credentials/${encodeURIComponent(credentialId)}`), {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Legacy compatibility for old hardphone rows that were provisioned as telephony_credentials.
export async function createPhoneCredential(args) {
  return createPhoneSipConnection(args);
}

export async function deletePhoneCredential(credentialId) {
  return deleteLegacyPhoneCredential(credentialId);
}
