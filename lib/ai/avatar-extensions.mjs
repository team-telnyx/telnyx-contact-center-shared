// Server-side avatar helpers for the web widget: catalog validation at
// publish time and provider session brokering for the voice call. The
// settings themselves live in the widget configuration (channels.voice.avatar).
import {
  ANAM_AVATAR_PROVIDER,
  HEYGEN_AVATAR_PROVIDER,
  isHeyGenPublicAvatarId,
  normalizeAIMediaSettings,
  normalizeAvatarProvider,
} from "./avatar-config.mjs";
import {
  anamAvatarErrorResponse,
  assertAnamAvatar,
  createAnamSessionToken,
} from "./anam-avatar.mjs";
import {
  assertPublicLiveAvatar,
  createLiveAvatarSessionToken,
  liveAvatarErrorResponse,
} from "./heygen-liveavatar.mjs";

export class AvatarSessionError extends Error {
  constructor(message, { status = 400, reason = "invalid_request" } = {}) {
    super(message);
    this.name = "AvatarSessionError";
    this.status = status;
    this.reason = reason;
  }
}

export function isAvatarProviderConfigured(provider) {
  return normalizeAvatarProvider(provider) === ANAM_AVATAR_PROVIDER
    ? Boolean(process.env.ANAM_API_KEY)
    : Boolean(process.env.LIVEAVATAR_API_KEY);
}

// Publish-time check of a widget's avatar block: the provider key must be
// configured and the selected avatar must still exist in the catalog. Provider
// lookups are injectable for tests.
export async function verifyWidgetAvatar(
  avatar,
  { verifyHeyGenAvatar = assertPublicLiveAvatar, verifyAnamAvatar = assertAnamAvatar } = {}
) {
  const settings = normalizeAIMediaSettings(avatar);
  if (!settings.avatarEnabled) return settings;
  const provider = settings.avatarConfig.provider;
  const providerLabel = provider === ANAM_AVATAR_PROVIDER ? "Anam" : "HeyGen LiveAvatar";
  if (!settings.avatarId) {
    throw Object.assign(new Error(`Select a ${providerLabel} avatar or disable the avatar before publishing`), { status: 400 });
  }
  if (!isAvatarProviderConfigured(provider)) {
    throw Object.assign(
      new Error(`${provider === ANAM_AVATAR_PROVIDER ? "ANAM_API_KEY" : "LIVEAVATAR_API_KEY"} is not configured; disable the avatar or configure the ${providerLabel} key before publishing`),
      { status: 400 }
    );
  }
  try {
    if (provider === ANAM_AVATAR_PROVIDER) await verifyAnamAvatar(settings.avatarId);
    else await verifyHeyGenAvatar(settings.avatarId);
  } catch (error) {
    throw Object.assign(new Error(`The selected ${providerLabel} avatar is not available: ${error?.message || "provider error"}`), { status: 400 });
  }
  return settings;
}

// Rejects a session request that does not match the published, enabled
// configuration. The browser only ever gets a token for the avatar the
// administrator selected.
export function assertAvatarSessionAllowed(settings, { avatarId, provider }) {
  const normalized = normalizeAIMediaSettings(settings);
  const requestedProvider = normalizeAvatarProvider(provider);
  if (!isHeyGenPublicAvatarId(avatarId)) {
    throw new AvatarSessionError("Invalid avatar session request", {
      status: 400,
      reason: "invalid_request",
    });
  }
  if (
    !normalized.avatarEnabled ||
    normalized.avatarId !== avatarId ||
    normalized.avatarConfig.provider !== requestedProvider
  ) {
    throw new AvatarSessionError("Avatar is not enabled for this widget", {
      status: 403,
      reason: "avatar_disabled",
    });
  }
  return normalized;
}

export async function createAvatarSessionForSettings(
  settings,
  { avatarId, provider },
  { createHeyGenSession = createLiveAvatarSessionToken, createAnamSession = createAnamSessionToken } = {}
) {
  const normalized = assertAvatarSessionAllowed(settings, { avatarId, provider });
  if (normalized.avatarConfig.provider === ANAM_AVATAR_PROVIDER) {
    return {
      provider: ANAM_AVATAR_PROVIDER,
      ...(await createAnamSession({
        avatarId,
        avatarModel: normalized.avatarConfig.avatarModel,
      })),
    };
  }
  return {
    provider: HEYGEN_AVATAR_PROVIDER,
    ...(await createHeyGenSession({ avatarId })),
  };
}

export function avatarErrorResponse(error) {
  if (error instanceof AvatarSessionError) {
    return {
      status: error.status,
      body: { ok: false, reason: error.reason, error: error.message },
    };
  }
  if (error?.name === "AnamAvatarError") return anamAvatarErrorResponse(error);
  return liveAvatarErrorResponse(error);
}

// A widget visitor may only start an avatar session through an active voice
// session of that widget, for the assistant and avatar of the revision the
// session was created from.
export async function authorizeWidgetAvatarSession(
  db,
  { publicId, token, assistantId },
  { getWidgetSession }
) {
  let session;
  try {
    session = await getWidgetSession(db, token);
  } catch {
    throw new AvatarSessionError("Widget session expired or disabled", {
      status: 401,
      reason: "authentication_required",
    });
  }
  if (session.public_id !== publicId || session.runtime_kind !== "ai_voice") {
    throw new AvatarSessionError("Voice session required", {
      status: 403,
      reason: "invalid_request",
    });
  }
  if (["completed", "failed"].includes(session.runtime_state)) {
    throw new AvatarSessionError("Voice session has ended", {
      status: 409,
      reason: "session_ended",
    });
  }
  const voice = session.config?.channels?.voice || {};
  const sessionAssistantId = session.assistant_id || voice.assistantId;
  if (!assistantId || String(sessionAssistantId) !== String(assistantId)) {
    throw new AvatarSessionError("Avatar is not available for this assistant", {
      status: 403,
      reason: "avatar_disabled",
    });
  }
  return { session, settings: normalizeAIMediaSettings(voice.avatar || {}) };
}
