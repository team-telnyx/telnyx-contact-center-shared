/**
 * Agent Assist Workflow - AI Context API
 * GET /api/agent-assist/workflow/ai-context?interactionId=xxx
 * 
 * Fetches AI context data for an interaction.
 * Used as a polling fallback when webhook data hasn't arrived yet.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getAiContextForInteraction } from "@/lib/agent-assist/ai-handoff-processor";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";

export const dynamic = "force-dynamic";

/**
 * GET /api/agent-assist/workflow/ai-context
 * 
 * Query params:
 * - interactionId: Required. The interaction ID to get AI context for.
 * 
 * Returns:
 * - status: "available" | "pending" | "not_applicable" | "error"
 * - data: AI context data (when available)
 * - message: Status message
 */
export async function GET(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const interactionId = searchParams.get("interactionId");

    if (!interactionId) {
      return NextResponse.json(
        { error: "interactionId query parameter is required" },
        { status: 400 }
      );
    }

    const result = await getAiContextForInteraction(interactionId);

    return NextResponse.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    workflowLogger.error("ai_context", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to get AI context" },
      { status: 500 }
    );
  }
}
