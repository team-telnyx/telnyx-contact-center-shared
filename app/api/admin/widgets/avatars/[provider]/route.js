import { NextResponse } from "next/server";
import { contactCenterRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import { withWidgetAdmin } from "@/lib/widgets/admin-api";
import { ANAM_AVATAR_PROVIDER, AVATAR_PROVIDERS } from "@/lib/ai/avatar-config.mjs";
import { fetchPublicLiveAvatars } from "@/lib/ai/heygen-liveavatar.mjs";
import { fetchAnamAvatars } from "@/lib/ai/anam-avatar.mjs";
import { avatarErrorResponse, isAvatarProviderConfigured } from "@/lib/ai/avatar-extensions.mjs";

// Avatar catalog for Widget Studio → Avatars. HeyGen exposes its public
// avatars without a key; Anam needs the account key, so an unconfigured Anam
// returns an empty catalog instead of an error.
export const GET = (request, context) => withWidgetAdmin(request, async () => {
  const { provider } = await context.params;
  if (!AVATAR_PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: "Unknown avatar provider" }, { status: 404 });
  }
  const configured = isAvatarProviderConfigured(provider);
  const headers = { "Cache-Control": "no-store" };
  try {
    if (provider === ANAM_AVATAR_PROVIDER && !configured) {
      return NextResponse.json({ configured: false, avatars: [], allAvatars: [] }, { headers });
    }
    const { avatars, allAvatars } = provider === ANAM_AVATAR_PROVIDER
      ? await fetchAnamAvatars({ featuredLimit: 5 })
      : await fetchPublicLiveAvatars({ limit: 5 });
    return NextResponse.json({ configured, avatars, allAvatars }, { headers });
  } catch (error) {
    contactCenterRuntimeLogger.error("widget_avatar_catalog_failed", { ...runtimePayload({ error }), provider });
    const response = avatarErrorResponse(error);
    return NextResponse.json({ error: response.body.error, reason: response.body.reason }, { status: response.status, headers });
  }
});
