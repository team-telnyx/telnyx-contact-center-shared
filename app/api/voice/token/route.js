import { authenticateVoiceEndpoint, renewVoiceEndpoint } from "@/lib/acd/voice-endpoints.mjs";
import { NextResponse } from "next/server";
import { buildTelnyxV2Url } from "@/lib/telnyx";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { credentialsLogger, credentialPayload, securityErrorPayload, securityUserPayload } from "@/lib/security-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { renewUserTelephonyCredential, createTelephonyCredential } from "@/lib/telnyx-credentials";

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
        "The telephony credential has expired."
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

async function POST_handler(_request, _context, authz) {
  try {
    const telnyxApiKey = process.env.TELNYX_API_KEY;
    if (!telnyxApiKey) {
      return NextResponse.json(
        { error: "Server not configured" },
        { status: 500 }
      );
    }

    const user = authz.user;
    const policy = (await getPostgresPool().query(
      "SELECT enabled FROM cc_agent_channel_policies WHERE agent_id=$1 AND channel='voice'",[String(user.id)])).rows[0];
    if (policy?.enabled === false) return NextResponse.json({error:"Voice is disabled for this agent",code:"VOICE_DISABLED"},{status:409});

    const endpointToken = _request.headers.get('x-cc-endpoint-token');
    const managed = (await getPostgresPool().query("SELECT 1 FROM cc_agent_voice_preferences WHERE agent_id=$1",[String(user.id)])).rowCount;
    if (managed || endpointToken) {
      const endpoint = await authenticateVoiceEndpoint(getPostgresPool(), user, endpointToken);
      try { return NextResponse.json({ token: await createAccessToken(telnyxApiKey, endpoint.credential_id) }); }
      catch (error) {
        if (error.code !== 'CREDENTIAL_EXPIRED') throw error;
        const renewed = await renewVoiceEndpoint(getPostgresPool(),user,endpoint,(id)=>createTelephonyCredential(telnyxApiKey,{
          connectionId:process.env.TELNYX_SIP_CONNECTION_ID,name:`CC ${user.id} ${endpoint.kind} ${id}`,
        }));
        return NextResponse.json({token:await createAccessToken(telnyxApiKey,renewed.credential_id),renewed:true});
      }
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
        // A user with no SIP identity at all gets one here rather than a note
        // telling them to find an administrator. Sign-in already provisions
        // one on this same connection; refusing to do it at the moment the
        // agent is actually trying to work only moves the problem.
        const provisioned = await renewUserTelephonyCredential(user);
        if (!provisioned?.id) {
          return NextResponse.json(
            {
              error:
                "No telephony credential could be provisioned for this user. Check TELNYX_SIP_CONNECTION_ID.",
              code: "MISSING_SIP_CONNECTION_ID",
            },
            { status: 404 }
          );
        }
        credentialId = provisioned.id;
      }
    }

    try {
      const token = await createAccessToken(telnyxApiKey, credentialId);
      return NextResponse.json({ token });
    } catch (tokenError) {
      if (tokenError.code !== "CREDENTIAL_EXPIRED" || !credentialId) throw tokenError;

      // An expired credential is repairable, and this is the only place that
      // learns it has expired. Leaving it to an administrator meant the
      // softphone stayed dead for everyone holding an old credential — which
      // on the dev connection was all 250 of them.
      credentialsLogger.warn("telephony_credential_expired", {
        ...credentialPayload({ credentialId }),
      });

      // A renewal that fails is still an expired credential, and that is what
      // the agent needs to be told — reporting the renewal's own failure as an
      // unrelated 500 would hide which of the two broke.
      let renewed = null;
      try {
        renewed = await renewUserTelephonyCredential(user, credentialId);
      } catch (renewError) {
        credentialsLogger.error("telephony_credential_renew_failed", {
          ...credentialPayload({ credentialId }),
          ...securityErrorPayload(renewError),
        });
      }
      if (!renewed?.id) {
        return NextResponse.json(
          {
            error: tokenError.message || "The telephony credential has expired",
            code: "CREDENTIAL_EXPIRED",
          },
          { status: 400 }
        );
      }

      // Exactly one retry: a second expiry on a credential minted seconds ago
      // means something other than age is wrong, and looping would hide it.
      const token = await createAccessToken(telnyxApiKey, renewed.id);
      return NextResponse.json({ token, renewed: true });
    }
  } catch (err) {
    credentialsLogger.error("voice_token_request_failed", { ...securityErrorPayload(err) });
    return NextResponse.json(
      {
        error: err?.message || "Unexpected error",
        code: err?.code || "UNKNOWN_ERROR",
      },
      { status: err?.status || (err?.code === "CREDENTIAL_EXPIRED" ? 400 : 500) }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
// A WebRTC token comes with agent work or with call supervision (listen / whisper / barge).
export const POST = withPermission(["agent:self", "calls:supervise.listen", "calls:supervise.whisper", "calls:supervise.barge"], POST_handler, { route: "/api/voice/token" });
