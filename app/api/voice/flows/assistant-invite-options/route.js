import { NextResponse } from "next/server";
import { withPermission } from "@/lib/authz/guard";
import { widgetAiRequest } from "@/lib/widgets/ai-provider";
import { listInviteAssistants, inspectInviteAssistant } from "@/lib/ai/assistant-invite-policy.mjs";

export const GET = withPermission("call_flows:read", async (request) => {
  const params = new URL(request.url).searchParams;
  try {
    if (params.has("assistantId")) return NextResponse.json({ item: await inspectInviteAssistant(params.get("assistantId"), widgetAiRequest) }, { headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ items: await listInviteAssistants(widgetAiRequest) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ error: params.has("assistantId") ? "Could not verify this assistant's Skip Turn tool. Try again." : "Could not load assistants. Try again." }, { status: error.status === 400 ? 400 : 503 }); }
}, { route: "/api/voice/flows/assistant-invite-options" });
