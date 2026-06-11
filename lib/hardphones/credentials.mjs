// Telnyx telephony credential helper for hard phones.
import { buildTelnyxV2Url } from "../telnyx.js";

// Create a Telnyx telephony credential for a phone. The SIP password is only
// retrievable at creation time, so it is persisted on the hp_phones row.
export async function createPhoneCredential({ label, mac }) {
  const apiKey = process.env.TELNYX_API_KEY;
  const connectionId = process.env.TELNYX_SIP_CONNECTION_ID;
  if (!apiKey || !connectionId) {
    throw new Error("TELNYX_API_KEY and TELNYX_SIP_CONNECTION_ID are required for phone credentials");
  }
  const response = await fetch(buildTelnyxV2Url("/telephony_credentials"), {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `hardphone-${mac}${label ? ` (${label.slice(0, 40)})` : ""}`,
      connection_id: connectionId,
      tag: "hardphone",
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || `HTTP ${response.status}`;
    throw new Error(`Telnyx credential create failed: ${detail}`);
  }
  const credential = data?.data;
  if (!credential?.id) throw new Error("Telnyx credential create returned no id");
  return {
    id: credential.id,
    sip_username: credential.sip_username || credential.user || null,
    sip_password: credential.sip_password || null,
  };
}

// Delete a phone's telephony credential on Telnyx (best effort).
export async function deletePhoneCredential(credentialId) {
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
