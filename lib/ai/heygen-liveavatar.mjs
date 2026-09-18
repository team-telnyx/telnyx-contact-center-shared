const HEYGEN_LIVEAVATAR_API_URL = "https://api.liveavatar.com";
const SUCCESS_CODE = 1000;
const SANDBOX_AVATAR_ID = "dd73ea75-1218-4ef3-92ce-606d5f7fbc0a";

export class HeyGenLiveAvatarError extends Error {
  constructor(message, { status = 502, reason = "provider_error", code = null } = {}) {
    super(message);
    this.name = "HeyGenLiveAvatarError";
    this.status = status;
    this.reason = reason;
    this.code = code;
  }
}

function getFailureReason(status, code, message) {
  const details = `${code || ""} ${message || ""}`.toLowerCase();
  if (/credit|quota|insufficient|balance/.test(details) || status === 402) {
    return "credits_exhausted";
  }
  if (/concurr|capacity|too many|session limit/.test(details) || status === 429) {
    return "capacity_reached";
  }
  if (status === 401 || status === 403 || /api key|unauthor/.test(details)) {
    return "invalid_api_key";
  }
  return "provider_error";
}

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.code !== SUCCESS_CODE) {
    const message = payload?.message || `LiveAvatar request failed (${response.status})`;
    throw new HeyGenLiveAvatarError(message, {
      status: response.status || 502,
      code: payload?.code,
      reason: getFailureReason(response.status, payload?.code, message),
    });
  }
  return payload.data;
}

function normalizePreviewUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizePublicAvatar(avatar) {
  if (!avatar?.id || !avatar?.name || avatar?.is_expired) return null;
  if (avatar?.status && avatar.status !== "ACTIVE") return null;
  const previewUrl = normalizePreviewUrl(avatar.preview_url);
  if (!previewUrl) return null;

  return {
    id: avatar.id,
    name: avatar.name,
    previewUrl,
    type: avatar.type || "VIDEO",
    voiceId: avatar.default_voice?.id || null,
    voiceName: avatar.default_voice?.name || null,
    is1080p: Boolean(avatar.is_1080p),
  };
}

export async function fetchPublicLiveAvatars({ fetchImpl = fetch, limit = 5 } = {}) {
  const response = await fetchImpl(
    `${HEYGEN_LIVEAVATAR_API_URL}/v1/avatars/public?page=1&page_size=100`,
    { cache: "no-store" }
  );
  const data = await parseResponse(response);
  const avatars = (Array.isArray(data?.results) ? data.results : [])
    .map(normalizePublicAvatar)
    .filter(Boolean);

  const identities = new Set();
  const distinct = [];
  for (const avatar of avatars) {
    const identity = avatar.voiceId || avatar.name.split(/\s+/)[0].toLowerCase();
    if (identities.has(identity)) continue;
    identities.add(identity);
    distinct.push(avatar);
    if (distinct.length === limit) break;
  }

  if (distinct.length < limit) {
    for (const avatar of avatars) {
      if (distinct.some((candidate) => candidate.id === avatar.id)) continue;
      distinct.push(avatar);
      if (distinct.length === limit) break;
    }
  }

  return { avatars: distinct, allAvatars: avatars };
}

export async function assertPublicLiveAvatar(avatarId, options = {}) {
  const { allAvatars } = await fetchPublicLiveAvatars({ ...options, limit: 5 });
  const avatar = allAvatars.find((candidate) => candidate.id === avatarId);
  if (!avatar) {
    throw new HeyGenLiveAvatarError("Selected avatar is not public", {
      status: 400,
      reason: "invalid_avatar",
    });
  }
  return avatar;
}

export async function createLiveAvatarSessionToken({
  avatarId,
  apiKey = process.env.LIVEAVATAR_API_KEY,
  fetchImpl = fetch,
  sandbox = process.env.LIVEAVATAR_SANDBOX === "true",
}) {
  if (!apiKey) {
    throw new HeyGenLiveAvatarError("LIVEAVATAR_API_KEY is not configured", {
      status: 503,
      reason: "not_configured",
    });
  }

  const response = await fetchImpl(`${HEYGEN_LIVEAVATAR_API_URL}/v1/sessions/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({
      // LiveAvatar only permits Wayne in sandbox mode. Keep the configured
      // production choice intact while using Wayne for free local testing.
      avatar_id: sandbox ? SANDBOX_AVATAR_ID : avatarId,
      mode: "LITE",
      is_sandbox: sandbox,
      video_settings: { quality: "high", encoding: "H264" },
    }),
    cache: "no-store",
  });
  const data = await parseResponse(response);
  if (!data?.session_token) {
    throw new HeyGenLiveAvatarError("LiveAvatar did not return a session token");
  }

  return {
    sessionId: data.session_id,
    sessionToken: data.session_token,
    sandbox,
  };
}

export function liveAvatarErrorResponse(error) {
  if (error instanceof HeyGenLiveAvatarError) {
    return {
      status: error.status,
      body: { ok: false, reason: error.reason, error: error.message },
    };
  }
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return {
      status,
      body: {
        ok: false,
        reason: status === 401 ? "authentication_required" : "internal_error",
        error: status === 401 ? "Authentication required" : "Unable to start avatar",
      },
    };
  }
  return {
    status: 500,
    body: { ok: false, reason: "internal_error", error: "Unable to start avatar" },
  };
}
