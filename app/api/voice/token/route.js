import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { credentialsLogger, credentialPayload, securityErrorPayload, securityUserPayload } from "@/lib/security-logging.mjs";

async function fetchCredentialIdByUsername(apiKey, username) {
  const url = `${buildTelnyxV2Url(
    "/telephony_credentials"
  )}?filter[username]=${encodeURIComponent(String(username || ""))}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });
  credentialsLogger.info("telephony_credential_lookup_completed", {
    ...securityUserPayload(null, username),
    ...credentialPayload({ status: resp.status, credentialSource: "username" }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.errors?.[0]?.detail || "Failed to list credentials";
    throw new Error(msg);
  }
  const first =
    Array.isArray(data?.data) && data.data.length > 0 ? data.data[0] : null;
  return first?.id || null;
}

async function createAccessToken(apiKey, credentialId) {
  const url = buildTelnyxV2Url(
    `/telephony_credentials/${encodeURIComponent(credentialId)}/token`
  );

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
  });

  const raw = await resp.text();
  if (!resp.ok) {
    let detail = "Failed to create access token";
    let errorCode = null;
    try {
      const parsed = JSON.parse(raw);
      detail = parsed?.errors?.[0]?.detail || detail;
      errorCode = parsed?.errors?.[0]?.code || null;
      credentialsLogger.warn("telephony_access_credential_token_create_failed", {
        ...credentialPayload({ credentialId }),
        errorCode,
        errorMessage: detail,
      });
    } catch (_) {}

    // If credential expired, throw a specific error that can be handled
    if (detail?.includes("expired") || errorCode === "credential_expired") {
      const error = new Error(
        "The telephony credential has expired. Please contact your administrator to renew it."
      );
      error.code = "CREDENTIAL_EXPIRED";
      error.credentialId = credentialId;
      throw error;
    }

    throw new Error(detail);
  }

  let token = null;
  try {
    const parsed = JSON.parse(raw);
    token = parsed?.data?.token || parsed?.token || parsed?.jwt || null;
  } catch (_) {
    token = raw;
  }
  if (!token || typeof token !== "string") {
    throw new Error("Invalid token response from Telnyx");
  }
  return token;
}

async function fetchFirstCredentialId(apiKey) {
  const url = `${buildTelnyxV2Url("/telephony_credentials")}?page[size]=1`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = data?.errors?.[0]?.detail || "Failed to list credentials";
    throw new Error(msg);
  }
  const first =
    Array.isArray(data?.data) && data.data.length > 0 ? data.data[0] : null;
  return first?.id || null;
}

export async function POST() {
  try {
    const telnyxApiKey = process.env.TELNYX_API_KEY;
    if (!telnyxApiKey) {
      return NextResponse.json(
        { error: "Server not configured" },
        { status: 500 }
      );
    }

    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Support both snake_case (DB rows) and camelCase (mapped objects)
    const usernameCandidate =
      user.telephony_user_name ||
      user.telephonyUserName ||
      user.username ||
      user.email ||
      "";
    let credentialId =
      process.env.TELNYX_TELEPHONY_CREDENTIAL_ID ||
      user.telephony_credentials_id ||
      user.telephonyCredentialsId ||
      "";
    if (!credentialId) {
      // Try resolving by candidate username (email is acceptable if used as username in Telnyx)
      if (usernameCandidate) {
        try {
          credentialId = await fetchCredentialIdByUsername(
            telnyxApiKey,
            usernameCandidate
          );
        } catch (err) {
          // continue to next fallback
        }
      }
      // Final fallback: pick the first available credential on the account (useful for demos)
      if (!credentialId) {
        try {
          credentialId = await fetchFirstCredentialId(telnyxApiKey);
        } catch (err) {
          return NextResponse.json(
            { error: err?.message || "Failed to resolve credential id" },
            { status: 400 }
          );
        }
      }
      if (!credentialId) {
        return NextResponse.json(
          {
            error:
              "No telephony credentials found. Set TELNYX_TELEPHONY_CREDENTIAL_ID or user.telephonyUserName/telephonyCredentialsId.",
            code: "MISSING_SIP_CONNECTION_ID",
          },
          { status: 404 }
        );
      }
    }

    try {
      const token = await createAccessToken(telnyxApiKey, credentialId);
      return NextResponse.json({ token });
    } catch (tokenError) {
      // If credential expired, try to find an alternative credential
      if (tokenError.code === "CREDENTIAL_EXPIRED" && credentialId) {
        credentialsLogger.warn("telephony_credential_expired_fallback_started", { ...credentialPayload({ credentialId }) });

        // Try to find another credential
        try {
          const alternativeCredentialId = await fetchFirstCredentialId(
            telnyxApiKey
          );
          if (
            alternativeCredentialId &&
            alternativeCredentialId !== credentialId
          ) {
            credentialsLogger.info("telephony_alternative_credential_found", { ...credentialPayload({ credentialId: alternativeCredentialId }) });
            const token = await createAccessToken(
              telnyxApiKey,
              alternativeCredentialId
            );
            return NextResponse.json({ token });
          }
        } catch (altErr) {
          credentialsLogger.error("telephony_alternative_credential_lookup_failed", { ...securityErrorPayload(altErr) });
        }

        // If no alternative found, return the expired credential error
        return NextResponse.json(
          {
            error: tokenError.message || "The telephony credential has expired",
            code: "CREDENTIAL_EXPIRED",
          },
          { status: 400 }
        );
      }
      throw tokenError;
    }
  } catch (err) {
    credentialsLogger.error("voice_token_request_failed", { ...securityErrorPayload(err) });
    return NextResponse.json(
      {
        error: err?.message || "Unexpected error",
        code: err?.code || "UNKNOWN_ERROR",
      },
      { status: err?.code === "CREDENTIAL_EXPIRED" ? 400 : 500 }
    );
  }
}
