import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { credentialsLogger, credentialPayload, securityErrorPayload, securityUserPayload } from "@/lib/security-logging.mjs";

async function fetchCredentialIdByUsername(apiKey, username, expectedConnectionId) {
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
  const expectedUsername = String(username || "").trim();
  const matches = (Array.isArray(data?.data) ? data.data : []).filter(
    (credential) => {
      const credentialUsernames = [
        credential?.user,
        credential?.username,
        credential?.sip_username,
      ]
        .filter(Boolean)
        .map((value) => String(value).trim());
      const usernameMatches = credentialUsernames.includes(expectedUsername);
      const connectionMatches = expectedConnectionId
        ? String(credential?.connection_id || "") === String(expectedConnectionId)
        : true;
      return usernameMatches && connectionMatches;
    },
  );
  if (matches.length !== 1) {
    credentialsLogger.warn("telephony_credential_lookup_ambiguous", {
      ...securityUserPayload(null, expectedUsername),
      ...credentialPayload({ credentialSource: "username" }),
      matchCount: matches.length,
      connectionConfigured: Boolean(expectedConnectionId),
    });
    return null;
  }
  return matches[0].id || null;
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
      user.telephony_user_name || user.telephonyUserName || "";
    let credentialId =
      user.telephony_credentials_id ||
      user.telephonyCredentialsId ||
      "";
    if (!credentialId) {
      // Resolve only by the SIP identity stored on this user. Never substitute
      // an account-wide/default credential, which could cross user boundaries.
      if (usernameCandidate) {
        try {
          credentialId = await fetchCredentialIdByUsername(
            telnyxApiKey,
            usernameCandidate,
            process.env.TELNYX_SIP_CONNECTION_ID,
          );
        } catch (err) {
          return NextResponse.json(
            { error: err?.message || "Failed to resolve the user's credential id" },
            { status: 502 },
          );
        }
      }
      if (!credentialId) {
        return NextResponse.json(
          {
            error:
              "No telephony credential is assigned to this user. Ask an administrator to provision or repair the user's SIP identity.",
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
      if (tokenError.code === "CREDENTIAL_EXPIRED" && credentialId) {
        credentialsLogger.warn("telephony_credential_expired", {
          ...credentialPayload({ credentialId }),
        });
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
