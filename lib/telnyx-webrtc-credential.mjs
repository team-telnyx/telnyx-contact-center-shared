// Resolve the Telnyx telephony credential the browser WebRTC client logs in as,
// and its SIP username. This mirrors the credential resolution used by
// app/api/voice/token/route.js so that a supervisor/listener call dialed to
// `sip:<sip_username>@sip.telnyx.com` lands on THIS user's WebRTC session.
//
// Order (same as the token route):
//   1. TELNYX_TELEPHONY_CREDENTIAL_ID env override
//   2. user.telephony_credentials_id / telephonyCredentialsId
//   3. lookup by username (telephony_user_name → username → email)
//   4. first credential on the account (demo fallback)

import { buildTelnyxV2Url } from "./telnyx.js";

async function telnyxGet(apiKey, path) {
  const resp = await fetch(buildTelnyxV2Url(path), {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    cache: "no-store",
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.errors?.[0]?.detail || `Telnyx GET ${path} failed (${resp.status})`;
    throw new Error(msg);
  }
  return data;
}

async function findCredentialIdByUsername(apiKey, username) {
  if (!username) return null;
  const data = await telnyxGet(
    apiKey,
    `/telephony_credentials?filter[username]=${encodeURIComponent(String(username))}`,
  );
  const first = Array.isArray(data?.data) && data.data.length > 0 ? data.data[0] : null;
  return first?.id || null;
}

async function findFirstCredentialId(apiKey) {
  const data = await telnyxGet(apiKey, `/telephony_credentials?page[size]=1`);
  const first = Array.isArray(data?.data) && data.data.length > 0 ? data.data[0] : null;
  return first?.id || null;
}

// Returns { credentialId, sipUsername } or null if unresolved.
export async function resolveWebrtcCredential(user, apiKey = process.env.TELNYX_API_KEY) {
  if (!apiKey) throw new Error("TELNYX_API_KEY environment variable is required");

  const usernameCandidate =
    user?.telephony_user_name || user?.telephonyUserName || user?.username || user?.email || "";

  let credentialId =
    process.env.TELNYX_TELEPHONY_CREDENTIAL_ID ||
    user?.telephony_credentials_id ||
    user?.telephonyCredentialsId ||
    "";

  if (!credentialId && usernameCandidate) {
    try {
      credentialId = await findCredentialIdByUsername(apiKey, usernameCandidate);
    } catch {
      credentialId = "";
    }
  }
  if (!credentialId) {
    try {
      credentialId = await findFirstCredentialId(apiKey);
    } catch {
      credentialId = "";
    }
  }
  if (!credentialId) return null;

  // Read the credential to get its SIP username (the WebRTC login identity).
  try {
    const data = await telnyxGet(apiKey, `/telephony_credentials/${encodeURIComponent(credentialId)}`);
    const sipUsername = data?.data?.sip_username || null;
    if (!sipUsername) return null;
    return { credentialId, sipUsername };
  } catch {
    return null;
  }
}
