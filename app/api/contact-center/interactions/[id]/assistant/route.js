import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { resolveWebhookBaseUrl } from "@/lib/webhook-base-url.mjs";
import { readAssistantInvite, inviteVoiceAssistant, removeVoiceAssistant, reconcileAssistantInvites } from "@/lib/acd/assistant-invites.mjs";

const route = "/api/contact-center/interactions/[id]/assistant";
const failure = error => NextResponse.json({ ok: false, error: error.status ? error.message : "Could not update the assistant invitation." }, { status: error.status || 503 });
export const GET = withPermission("agent:self", async (_request, { params }, authz) => {
  try {
    const state = await readAssistantInvite(getPostgresPool(), { interactionId: (await params).id, agentId: String(authz.user.id) });
    return NextResponse.json({ ok: true, ...state }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}, { route });
export const POST = withPermission("agent:self", async (request, { params }, authz) => {
  try {
    const body = await request.json().catch(() => ({}));
    const args = { interactionId: (await params).id, agentId: String(authz.user.id) };
    let invite;
    if (body.action === "invite") invite = await inviteVoiceAssistant(getPostgresPool(), { ...args, assistantId: body.assistantId, requestId: body.requestId, webhookUrl: `${resolveWebhookBaseUrl()}/api/voice/assistant-invite/events` });
    else if (body.action === "remove") { invite = await removeVoiceAssistant(getPostgresPool(), { ...args, inviteId: body.inviteId }); await reconcileAssistantInvites(getPostgresPool()); }
    else return NextResponse.json({ error: "Unsupported assistant action." }, { status: 400 });
    return NextResponse.json({ ok: true, invite }, { status: 202 });
  } catch (error) { return failure(error); }
}, { route, voiceControl: true });
