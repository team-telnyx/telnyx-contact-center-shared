import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { widgetAiRequest } from "@/lib/widgets/ai-provider";
import { assistantCallSettings, assistantCallSocketUrl, issueAssistantCallSession } from "@/lib/ai/assistant-call-session.mjs";
import { assertTelnyxAvatarAssistant } from "@/lib/ai/telnyx-avatar.mjs";

const headers = { "Cache-Control": "no-store" };
async function settings(context) {
  const { id } = await context.params;
  const response = await widgetAiRequest(`/ai/assistants/${encodeURIComponent(id)}`);
  return response.data || response;
}
export const GET = withPermission("ai_assistants:test", async (_request, context) => {
  try { return NextResponse.json(assistantCallSettings(await settings(context)), { headers }); }
  catch { return NextResponse.json({ error: "Could not load this assistant. Try again." }, { status: 502, headers }); }
});

export const POST = withPermission("ai_assistants:test", async (request, context, authz) => {
  const origin = request.headers.get("origin") || new URL(request.url).origin;
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  const allowedOrigins = [requestUrl.origin, ...(host ? [`${requestUrl.protocol}//${host}`] : []), ...(process.env.NEXTAUTH_URL ? [new URL(process.env.NEXTAUTH_URL).origin] : [])];
  if (!allowedOrigins.includes(origin)) return NextResponse.json({ error: "Open Call from Contact Center." }, { status: 403, headers });
  try {
    const assistant = await settings(context), config = assistantCallSettings(assistant);
    if (config.avatar) assertTelnyxAvatarAssistant(assistant, { avatar: config.avatar });
    const body = await request.json().catch(() => ({}));
    if (JSON.stringify(body.avatar ?? null) !== JSON.stringify(config.avatar)) return NextResponse.json({ error: "This assistant's avatar changed. Close and reopen Call to load the saved settings." }, { status: 409, headers });
    const token = issueAssistantCallSession({ userId: String(authz.user.id), sessionId: authz.user.authSessionId || null, sessionKind: request.headers.has("authorization") ? "bearer" : "web", assistantId: assistant.id, avatar: config.avatar, origin });
    return NextResponse.json({ url: assistantCallSocketUrl(request.url, process.env, { pageOrigin: origin }), token, authentication: "assistant.call.authenticate", avatarEnabled: Boolean(config.avatar) }, { headers });
  } catch (error) {
    return NextResponse.json({ error: error.status === 400 ? error.message : "Could not authorize the call. Check the Contact Center Telnyx connection and try again." }, { status: error.status === 400 ? 400 : 502, headers });
  }
});
