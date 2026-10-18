import { NextResponse } from "next/server";
import { contactCenterRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { bearerToken } from "@/lib/widgets/session-tokens";
import { getWidgetSession } from "@/lib/widgets/sessions";
import {
  authorizeWidgetAvatarSession,
  assertAvatarSessionAllowed,
  avatarErrorResponse,
  createAvatarSessionForSettings,
} from "@/lib/ai/avatar-extensions.mjs";
import { assertTelnyxAvatarAssistant } from "@/lib/ai/telnyx-avatar.mjs";
import { widgetAiRequest } from "@/lib/widgets/ai-provider";
import { telnyxAvatarSocketUrl } from "@/lib/ai/telnyx-avatar-socket-url.mjs";

const NO_STORE = { "Cache-Control": "no-store" };

// Short-lived provider session token for the widget voice call. Authorised by
// the widget's own voice session token (Bearer wss_…); the avatar comes from
// the published widget revision the session was created from, so a visitor
// can only start the avatar the administrator configured.
export async function POST(request, context) {
  const pool = getPostgresPool();
  if (!pool) {
    return NextResponse.json(
      { ok: false, reason: "not_configured", error: "Service unavailable" },
      { status: 503, headers: NO_STORE }
    );
  }
  try {
    const { publicId } = await context.params;
    const body = await request.json().catch(() => ({}));
    const { settings, session: widgetSession } = await authorizeWidgetAvatarSession(
      pool,
      { publicId, token: bearerToken(request), assistantId: body.assistantId },
      { getWidgetSession }
    );
    if (settings.avatarConfig.provider === "telnyx") {
      assertAvatarSessionAllowed(settings, body);
      const response = await widgetAiRequest(`/ai/assistants/${encodeURIComponent(widgetSession.assistant_id)}`);
      assertTelnyxAvatarAssistant(response.data || response, widgetSession.config.channels.voice, { requireMatch: true });
      return NextResponse.json({ ok: true, provider: "telnyx", url: telnyxAvatarSocketUrl(request.url) }, { headers: NO_STORE });
    }
    const session = await createAvatarSessionForSettings(settings, {
      avatarId: body.avatarId,
      provider: body.provider,
    });
    return NextResponse.json({ ok: true, ...session }, { headers: NO_STORE });
  } catch (error) {
    contactCenterRuntimeLogger.error("widget_avatar_session_failed", { ...runtimePayload({ error }) });
    const response = error.status && error.name !== "AvatarSessionError"
      ? { status: error.status, body: { ok: false, error: error.message } }
      : avatarErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status, headers: NO_STORE });
  }
}
