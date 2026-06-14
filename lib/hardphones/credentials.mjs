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
  const raw = String(mac || "").trim();
  const withoutLegacyPrefix = raw.replace(/^(?:hp|phone)(?=[0-9a-f])/i, "");
  const clean = withoutLegacyPrefix.replace(/[^0-9a-f]/gi, "").toUpperCase();
  if (clean.length !== 12) throw new Error("Valid phone MAC is required to derive SIP username");
  return `phone${clean}`;
}

export function phoneConnectionName(mac) {
  const clean = String(mac || "").replace(/[^0-9a-f]/gi, "").toUpperCase();
  return `phone_${clean || "unknown"}`;
}

export function generatePhoneSipPassword() {
  return crypto.randomBytes(24).toString("base64url").slice(0, 32);
}

export async function listTelnyxPhoneNumbers({ limit = 250, pages = Number.POSITIVE_INFINITY } = {}) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) return [];
  const numbers = [];
  const seen = new Set();
  for (let page = 1; page <= pages; page += 1) {
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
      const number = item?.phone_number || null;
      if (!number || seen.has(item.id || number)) continue;
      seen.add(item.id || number);
      numbers.push({
        ...item,
        id: item.id,
        phone_number: number,
        connection_id: item?.connection_id || item?.voice?.connection_id || null,
        status: item.status || null,
      });
    }
    const currentPage = Number(data?.meta?.page_number || data?.meta?.page?.number || page);
    const totalPages = Number(data?.meta?.total_pages || data?.meta?.page?.total_pages || 0);
    if (rows.length < limit || (totalPages && currentPage >= totalPages)) break;
  }
  return numbers;
}

export async function listUnassignedPhoneNumbers({ limit = 250 } = {}) {
  return (await listTelnyxPhoneNumbers({ limit })).filter((item) => !item.connection_id)
    .map((item) => ({ id: item.id, phone_number: item.phone_number, status: item.status || null }));
}

function telnyxTag(prefix, value) {
  const clean = String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128);
  return clean ? `${prefix}_${clean}` : null;
}

function resolveHardphoneWebhookUrl() {
  const explicit = String(process.env.TELNYX_HARDPHONE_WEBHOOK_URL || "").trim();
  if (explicit) return explicit.replace(/\/$/, "");
  const base = [
    process.env.TELNYX_WEBHOOK_BASE_URL,
    process.env.NEXTAUTH_URL,
    process.env.APP_BASE_URL,
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean);
  return base ? `${base.replace(/\/$/, "")}/api/voice/webhook` : undefined;
}

async function updatePhoneSipConnectionUserName({ apiKey, connectionId, userName }) {
  const response = await fetch(buildTelnyxV2Url(`/credential_connections/${encodeURIComponent(connectionId)}`), {
    method: "PATCH",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify({ user_name: userName }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Telnyx SIP connection username update failed: ${errorDetail(data, `HTTP ${response.status}`)}`);
  return data?.data || null;
}

function normalizeAssignedPhoneNumber(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return null;
  return `+${digits}`;
}

function outboundCallerIdPatch(phoneNumber, { clearEmpty = false } = {}) {
  const ani = normalizeAssignedPhoneNumber(phoneNumber);
  if (ani) return { ani_override: ani, ani_override_type: "always" };
  if (clearEmpty) {
    // Telnyx models a blank string as the supported way to clear an outbound
    // caller-ID override. Sending null is rejected, but doing nothing leaves
    // stale caller ID on existing credential connections.
    return { ani_override: "", ani_override_type: "always" };
  }
  return {};
}

export async function createPhoneSipConnection({ label, mac, vendor, model, password, assignedPhoneNumber, assigned_phone_number }) {
  const apiKey = process.env.TELNYX_API_KEY;
  const outboundVoiceProfileId = process.env.TELNYX_OUTBOUND_VOICE_PROFILE;
  if (!apiKey || !outboundVoiceProfileId) {
    throw new Error("TELNYX_API_KEY and TELNYX_OUTBOUND_VOICE_PROFILE are required for hard phone SIP connections");
  }
  const userName = phoneConnectionUserName(mac);
  const sipPassword = password || generatePhoneSipPassword();
  const tags = [
    "hardphone",
    telnyxTag("vendor", vendor),
    telnyxTag("model", model),
    mac ? `mac_${String(mac).replace(/[^0-9a-f]/gi, "").toUpperCase()}` : null,
  ].filter(Boolean);
  const body = {
    active: true,
    connection_name: phoneConnectionName(mac),
    user_name: userName,
    password: sipPassword,
    anchorsite_override: "Latency",
    sip_uri_calling_preference: "unrestricted",
    encode_contact_header_enabled: true,
    webhook_event_url: resolveHardphoneWebhookUrl(),
    webhook_api_version: "2",
    tags,
    inbound: {
      ani_number_format: "+E.164",
      dnis_number_format: "+e164",
      codecs: ["G722", "G711U", "G711A", "G729"],
    },
    outbound: {
      outbound_voice_profile_id: outboundVoiceProfileId,
      ...outboundCallerIdPatch(assignedPhoneNumber || assigned_phone_number),
      // Required for hardphone CTI/call-control: direct SIP outbound calls are
      // parked first, then /api/voice/webhook dials and bridges the PSTN leg.
      // Do not disable this for bot/code-review suggestions; fix webhook
      // handling instead.
      call_parking_enabled: true,
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
  let connection = data?.data;
  if (!connection?.id) throw new Error("Telnyx SIP connection create returned no id");
  if (connection.user_name !== userName) {
    try {
      const updatedConnection = await updatePhoneSipConnectionUserName({
        apiKey,
        connectionId: connection.id,
        userName,
      });
      connection = updatedConnection || connection;
    } catch (err) {
      await deletePhoneSipConnection(connection.id);
      throw err;
    }
  }
  if (connection.user_name !== userName) {
    await deletePhoneSipConnection(connection.id);
    throw new Error("Telnyx SIP connection username update did not persist the requested username");
  }
  return {
    id: connection.id,
    connection_id: connection.id,
    connection_name: connection.connection_name || body.connection_name,
    sip_username: userName,
    sip_password: sipPassword,
    tags,
  };
}

export async function updatePhoneSipConnectionCallerId({ connectionId, phoneNumber }) {
  const apiKey = process.env.TELNYX_API_KEY;
  const outboundPatch = outboundCallerIdPatch(phoneNumber, { clearEmpty: true });
  if (!apiKey || !connectionId || !Object.keys(outboundPatch).length) return null;
  const response = await fetch(buildTelnyxV2Url(`/credential_connections/${encodeURIComponent(connectionId)}`), {
    method: "PATCH",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify({ outbound: outboundPatch }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Telnyx SIP connection caller ID update failed: ${errorDetail(data, `HTTP ${response.status}`)}`);
  return data?.data || null;
}

export async function getPhoneSipConnection(connectionId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey || !connectionId) return null;
  const response = await fetch(buildTelnyxV2Url(`/credential_connections/${encodeURIComponent(connectionId)}`), {
    headers: telnyxHeaders(apiKey),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Telnyx SIP connection lookup failed: ${errorDetail(data, `HTTP ${response.status}`)}`);
  return data?.data || null;
}

export async function getPhoneNumber(phoneNumberId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey || !phoneNumberId) return null;
  const response = await fetch(buildTelnyxV2Url(`/phone_numbers/${encodeURIComponent(phoneNumberId)}`), {
    headers: telnyxHeaders(apiKey),
    cache: "no-store",
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Telnyx phone number lookup failed: ${errorDetail(data, `HTTP ${response.status}`)}`);
  const number = data?.data || null;
  return number ? { ...number, connection_id: number.connection_id || number.voice?.connection_id || null } : null;
}

export function hardphoneMacFromSipConnection(connection = {}) {
  const tags = Array.isArray(connection.tags) ? connection.tags : [];
  const tagMac = tags.find((tag) => /^mac_[0-9A-Fa-f]{12}$/.test(String(tag || "")));
  if (tagMac) return tagMac.replace(/^mac_/i, "").toUpperCase();
  const nameMac = String(connection.connection_name || "").match(/^phone_([0-9A-Fa-f]{12})$/)?.[1];
  if (nameMac) return nameMac.toUpperCase();
  const userMac = String(connection.user_name || "").match(/^phone([0-9A-Fa-f]{12})$/)?.[1];
  if (userMac) return userMac.toUpperCase();
  return null;
}

export function isHardphoneSipConnection(connection = {}) {
  const tags = Array.isArray(connection.tags) ? connection.tags : [];
  return tags.includes("hardphone") || Boolean(hardphoneMacFromSipConnection(connection));
}

export async function assignPhoneNumberToConnection(phoneNumberId, connectionId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey || !phoneNumberId || !connectionId) return null;
  const currentNumber = await getPhoneNumber(phoneNumberId);
  const currentConnectionId = currentNumber?.connection_id || null;
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

export async function unassignPhoneNumberFromConnection(phoneNumberId) {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey || !phoneNumberId) return null;
  const response = await fetch(buildTelnyxV2Url(`/phone_numbers/${encodeURIComponent(phoneNumberId)}`), {
    method: "PATCH",
    headers: telnyxHeaders(apiKey),
    body: JSON.stringify({ connection_id: null }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Telnyx phone number unassignment failed: ${errorDetail(data, `HTTP ${response.status}`)}`);
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
