const ANAM_API_URL = "https://api.anam.ai";
const AVATAR_PAGE_LIMIT = 50;

export class AnamAvatarError extends Error {
  constructor(message, { status = 502, reason = "provider_error" } = {}) {
    super(message);
    this.name = "AnamAvatarError";
    this.status = status;
    this.reason = reason;
  }
}

function getFailureReason(status, message) {
  const details = String(message || "").toLowerCase();
  if (/credit|quota|insufficient|balance/.test(details) || status === 402) {
    return "credits_exhausted";
  }
  if (/concurr|capacity|too many|session limit/.test(details) || status === 429) {
    return "capacity_reached";
  }
  if (status === 401 || status === 403 || /api key|unauthor/.test(details)) {
    return "invalid_api_key";
  }
  if (status === 400 || status === 404) return "invalid_avatar";
  return "provider_error";
}

async function parseResponse(response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      payload?.message ||
      payload?.error ||
      payload?.detail ||
      `Anam request failed (${response.status})`;
    throw new AnamAvatarError(message, {
      status: response.status || 502,
      reason: getFailureReason(response.status, message),
    });
  }
  return payload;
}

function normalizeMediaUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function normalizeModel(value) {
  if (typeof value !== "string") return null;
  const model = value.trim();
  return /^cara-[a-z0-9-]+$/i.test(model) ? model : null;
}

export function normalizeAnamAvatar(avatar) {
  if (!avatar?.id || !avatar?.displayName) return null;
  const previewUrl = normalizeMediaUrl(avatar.imageUrl);
  if (!previewUrl) return null;

  const identityName = String(avatar.displayName).trim();
  const variantName = String(avatar.variantName || "").trim();
  const availableModels = Array.isArray(avatar.availableVersions)
    ? avatar.availableVersions.map(normalizeModel).filter(Boolean)
    : [];
  const avatarModel =
    normalizeModel(avatar.activeVersion) || availableModels[0] || null;

  return {
    id: avatar.id,
    name: variantName ? `${identityName} — ${variantName}` : identityName,
    identityName,
    variantName: variantName || null,
    previewUrl,
    portraitPreviewUrl: normalizeMediaUrl(avatar.portraitImageUrl),
    landscapePreviewUrl: normalizeMediaUrl(avatar.landscapeImageUrl),
    videoPreviewUrl: normalizeMediaUrl(
      avatar.idleVideoUrl || avatar.videoUrl
    ),
    avatarModel,
    availableModels,
    isCustom: Boolean(avatar.createdByOrganizationId),
    isFavourite: Boolean(avatar.isFavourite),
    description:
      typeof avatar.description === "string" ? avatar.description : null,
    tags: Array.isArray(avatar.displayTags)
      ? avatar.displayTags.filter((tag) => typeof tag === "string")
      : [],
  };
}

async function fetchAvatarPage(page, { fetchImpl, apiKey }) {
  const response = await fetchImpl(`${ANAM_API_URL}/v1/avatars?page=${page}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: "no-store",
  });
  return parseResponse(response);
}

export async function fetchAnamAvatars({
  fetchImpl = fetch,
  apiKey = process.env.ANAM_API_KEY,
  featuredLimit = 5,
} = {}) {
  if (!apiKey) {
    throw new AnamAvatarError("ANAM_API_KEY is not configured", {
      status: 503,
      reason: "not_configured",
    });
  }

  const firstPage = await fetchAvatarPage(1, { fetchImpl, apiKey });
  const lastPage = Math.min(
    AVATAR_PAGE_LIMIT,
    Math.max(1, Number(firstPage?.meta?.lastPage) || 1)
  );
  const remainingPages = await Promise.all(
    Array.from({ length: lastPage - 1 }, (_, index) =>
      fetchAvatarPage(index + 2, { fetchImpl, apiKey })
    )
  );
  const avatars = [firstPage, ...remainingPages]
    .flatMap((page) => (Array.isArray(page?.data) ? page.data : []))
    .map(normalizeAnamAvatar)
    .filter(Boolean);

  const featured = [
    ...avatars.filter((avatar) => avatar.isFavourite),
    ...avatars.filter((avatar) => !avatar.isFavourite),
  ].filter(
    (avatar, index, list) =>
      list.findIndex((candidate) => candidate.id === avatar.id) === index
  );

  return {
    avatars: featured.slice(0, featuredLimit),
    allAvatars: avatars,
  };
}

export async function assertAnamAvatar(avatarId, options = {}) {
  const apiKey = options.apiKey || process.env.ANAM_API_KEY;
  if (!apiKey) {
    throw new AnamAvatarError("ANAM_API_KEY is not configured", {
      status: 503,
      reason: "not_configured",
    });
  }
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(
    `${ANAM_API_URL}/v1/avatars/${encodeURIComponent(avatarId)}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
    }
  );
  const avatar = normalizeAnamAvatar(await parseResponse(response));
  if (!avatar) {
    throw new AnamAvatarError("Selected Anam avatar is not available", {
      status: 400,
      reason: "invalid_avatar",
    });
  }
  return avatar;
}

export async function createAnamSessionToken({
  avatarId,
  avatarModel,
  apiKey = process.env.ANAM_API_KEY,
  fetchImpl = fetch,
}) {
  if (!apiKey) {
    throw new AnamAvatarError("ANAM_API_KEY is not configured", {
      status: 503,
      reason: "not_configured",
    });
  }

  const personaConfig = {
    avatarId,
    enableAudioPassthrough: true,
  };
  const normalizedModel = normalizeModel(avatarModel);
  if (normalizedModel) personaConfig.avatarModel = normalizedModel;

  const response = await fetchImpl(`${ANAM_API_URL}/v1/auth/session-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ personaConfig }),
    cache: "no-store",
  });
  const data = await parseResponse(response);
  if (!data?.sessionToken) {
    throw new AnamAvatarError("Anam did not return a session token");
  }
  return { sessionToken: data.sessionToken };
}

export function anamAvatarErrorResponse(error) {
  if (error instanceof AnamAvatarError) {
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
        error:
          status === 401 ? "Authentication required" : "Unable to start avatar",
      },
    };
  }
  return {
    status: 500,
    body: {
      ok: false,
      reason: "internal_error",
      error: "Unable to start avatar",
    },
  };
}
