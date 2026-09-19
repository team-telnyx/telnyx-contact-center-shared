import { NextResponse } from "next/server";
import { contactCenterRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { bearerToken } from "@/lib/widgets/session-tokens";
import { getWidgetSession } from "@/lib/widgets/sessions";
import {
  authorizeWidgetAvatarSession,
  avatarErrorResponse,
  createAvatarSessionForSettings,
} from "@/lib/ai/avatar-extensions.mjs";

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
    const { settings } = await authorizeWidgetAvatarSession(
      pool,
      { publicId, token: bearerToken(request), assistantId: body.assistantId },
      { getWidgetSession }
    );
    const session = await createAvatarSessionForSettings(settings, {
      avatarId: body.avatarId,
      provider: body.provider,
    });
    return NextResponse.json({ ok: true, ...session }, { headers: NO_STORE });
  } catch (error) {
    contactCenterRuntimeLogger.error("widget_avatar_session_failed", { ...runtimePayload({ error }) });
    const response = avatarErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status, headers: NO_STORE });
  }
}
