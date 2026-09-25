import { buildTelnyxV2Url } from "./telnyx.js";
import { getAppEnv } from "./environment.js";
import { credentialsLogger, credentialPayload, securityErrorPayload, securityUserPayload } from "./security-logging.mjs";
import { PgDb } from "./pgdb.js";

/**
 * Creates a new Telnyx telephony credential for a user
 * @param {string} apiKey - Telnyx API key
 * @param {Object} options - Options for credential creation
 * @param {string} options.name - Name for the credential (e.g., user's email or full name)
 * @param {string} options.connectionId - Telnyx connection ID (required)
 * @param {string} [options.tag] - Optional tag for grouping credentials
 * @param {string} [options.expiresAt] - Optional ISO-8601 expiration date
 * @returns {Promise<Object>} - Credential object with id and username
 */
export async function createTelephonyCredential(apiKey, options) {
  const { name, connectionId, tag, expiresAt } = options;

  if (!apiKey) {
    throw new Error("Telnyx API key is required");
  }

  if (!connectionId) {
    throw new Error(
      "Connection ID is required to create telephony credentials"
    );
  }

  const payload = {
    name: name || "Demo Portal User",
    connection_id: connectionId,
  };

  if (tag) {
    payload.tag = tag;
  }

  if (expiresAt) {
    payload.expires_at = expiresAt;
  }

  const url = buildTelnyxV2Url("/telephony_credentials");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();
    let data;
    credentialsLogger.info("telephony_credential_create_response_received", { status: response.status });
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      throw new Error(
        `Failed to parse Telnyx response: ${responseText.substring(0, 200)}`
      );
    }

    if (!response.ok) {
      const errorMsg =
        data?.errors?.[0]?.detail ||
        data?.errors?.[0]?.message ||
        data?.message ||
        `HTTP ${response.status}: Failed to create telephony credential`;
      throw new Error(errorMsg);
    }

    const credential = data?.data;

    if (!credential || !credential.id) {
      throw new Error("Invalid response from Telnyx: missing credential data");
    }

    return {
      id: credential.id,
      username:
        credential.user ||
        credential.username ||
        credential.sip_username ||
        null,
      sip_username: credential.sip_username || null,
      name: credential.name,
      connectionId: credential.connection_id,
      createdAt: credential.created_at,
      expiresAt: credential.expires_at,
    };
  } catch (error) {
    credentialsLogger.error("telephony_credential_create_failed", { connectionConfigured: Boolean(connectionId), ...securityErrorPayload(error) });
    throw error;
  }
}

/**
 * Creates telephony credentials for a new user during signup
 * REQUIRES TELNYX_SIP_CONNECTION_ID environment variable - no fallback allowed
 * @param {Object} userInfo - User information
 * @param {string} userInfo.email - User email
 * @param {string} [userInfo.firstName] - User first name
 * @param {string} [userInfo.lastName] - User last name
 * @returns {Promise<Object|null>} - Credential info or null if disabled/failed
 */
export async function createUserTelephonyCredentials(userInfo) {
  const apiKey = process.env.TELNYX_API_KEY;

  // If no API key, skip credential creation (not all environments require it)
  if (!apiKey) {
    credentialsLogger.warn("telephony_credential_auto_create_skipped", { reason: "api_key_missing" });
    return null;
  }

  // Check if credential creation is explicitly disabled
  if (process.env.TELNYX_AUTO_CREATE_CREDENTIALS === "false") {
    credentialsLogger.info("telephony_credential_auto_create_skipped", { reason: "disabled" });
    return null;
  }

  // REQUIRED: TELNYX_SIP_CONNECTION_ID must be configured
  const connectionId = process.env.TELNYX_SIP_CONNECTION_ID;
  if (!connectionId) {
    const error = new Error(
      "TELNYX_SIP_CONNECTION_ID environment variable is required but not configured. " +
        "Please set this environment variable to a valid Telnyx SIP connection ID."
    );
    error.code = "MISSING_SIP_CONNECTION_ID";
    throw error;
  }

  try {
    const { email, firstName, lastName } = userInfo;
    const displayName =
      [firstName, lastName].filter(Boolean).join(" ") || email;

    // Use environment-aware tag
    const appEnv = getAppEnv();
    const tag =
      appEnv === "production" ? "demo-portal" : `demo-portal-${appEnv}`;

    const credential = await createTelephonyCredential(apiKey, {
      name: displayName,
      connectionId,
      tag,
    });

    credentialsLogger.info("telephony_credential_created", { ...securityUserPayload(null, email), ...credentialPayload({ credentialId: credential.id, connectionConfigured: Boolean(connectionId) }) });

    return credential;
  } catch (error) {
    credentialsLogger.error("user_telephony_credential_create_failed", { ...securityErrorPayload(error) });
    // Don't fail user signup if credential creation fails
    // This allows the system to work even if Telnyx API is down
    return null;
  }
}

/**
 * Deletes a telephony credential. Best effort: a credential that cannot be
 * removed is litter, not a failure — the caller has already replaced it.
 */
export async function deleteTelephonyCredential(apiKey, credentialId) {
  if (!apiKey || !credentialId) return false;
  try {
    const response = await fetch(
      buildTelnyxV2Url(`/telephony_credentials/${encodeURIComponent(credentialId)}`),
      { method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } },
    );
    credentialsLogger.info("telephony_credential_deleted", {
      ...credentialPayload({ credentialId, status: response.status }),
    });
    return response.ok;
  } catch (error) {
    credentialsLogger.warn("telephony_credential_delete_failed", {
      ...credentialPayload({ credentialId }),
      ...securityErrorPayload(error),
    });
    return false;
  }
}

// One renewal per user at a time. Two requests arriving together — which is
// the normal case, because a page and its softphone both ask — would otherwise
// each mint a credential, and the loser's would leak onto the connection
// forever. The dev connection accumulated 250 of them.
const renewalsInFlight = new Map();

/**
 * Issues a fresh telephony credential for a user and records it on their row.
 *
 * Telnyx credentials created without `expires_at` do not expire, but older
 * ones on this account were created with a four-hour life and every single one
 * of them is now dead. Nothing renewed them: credentials were minted at
 * sign-in only when a user had none at all, so an expired one stayed expired
 * and the agent's softphone simply stopped working, on web as well as mobile.
 *
 * @param {object} user - the user row (snake_case or camelCase both accepted)
 * @param {string} [previousCredentialId] - removed once the new one is stored
 * @returns {Promise<{id: string, username: string}|null>}
 */
export async function renewUserTelephonyCredential(user, previousCredentialId = null) {
  const userId = String(user?.id || user?._id || "");
  if (!userId) return null;

  const existing = renewalsInFlight.get(userId);
  if (existing) return existing;

  const work = (async () => {
    const apiKey = process.env.TELNYX_API_KEY;
    const connectionId = process.env.TELNYX_SIP_CONNECTION_ID;
    if (!apiKey || !connectionId) return null;

    const email = user.username || user.email || "";
    const displayName =
      [user.first_name || user.firstName, user.last_name || user.lastName]
        .filter(Boolean)
        .join(" ") || email;

    const appEnv = getAppEnv();
    const credential = await createTelephonyCredential(apiKey, {
      name: displayName,
      connectionId,
      tag: appEnv === "production" ? "demo-portal" : `demo-portal-${appEnv}`,
    });
    if (!credential?.id) return null;

    const username = credential.username || credential.sip_username || null;
    await PgDb.updateUserById(userId, {
      telephonyCredentialsId: credential.id,
      telephonyUserName: username,
    });

    credentialsLogger.info("telephony_credential_renewed", {
      ...securityUserPayload(null, email),
      ...credentialPayload({ credentialId: credential.id }),
      replaced: Boolean(previousCredentialId),
    });

    // Only after the new one is safely on the row: if the delete ran first and
    // the update then failed, the user would be left pointing at nothing.
    if (previousCredentialId && previousCredentialId !== credential.id) {
      await deleteTelephonyCredential(apiKey, previousCredentialId);
    }

    return { id: credential.id, username };
  })();

  renewalsInFlight.set(userId, work);
  try {
    return await work;
  } finally {
    renewalsInFlight.delete(userId);
  }
}
