import { NextResponse } from "next/server";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { findInteractionViewByCallControlId, findInteractionViewByCallSessionId } from "@/lib/acd/work-item-repository.mjs";
import { workItemInScope } from "@/lib/authz/scope.mjs";

function getTelnyxBaseUrl() {
  return process.env.TELNYX_BASE_PATH || "https://api.telnyx.com";
}

async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;


    const token = process.env.TELNYX_API_KEY;
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Missing Telnyx API key" },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const params = new URLSearchParams(searchParams);

    if (authz.scope?.restricted) {
      // Provider events are tenant-wide: a scoped caller may only read the
      // events of a call that belongs to an interaction inside their scope.
      const sessionId = searchParams.get("filter[application_session_id]") || searchParams.get("filter[call_session_id]") || searchParams.get("call_session_id");
      const callControlId = searchParams.get("filter[call_control_id]") || searchParams.get("call_control_id");
      if (!sessionId && !callControlId) {
        return NextResponse.json({ ok: false, error: "A call session inside your data scope is required" }, { status: 403 });
      }
      const pool = getPostgresPool();
      const interaction = pool
        ? (sessionId ? await findInteractionViewByCallSessionId(pool, sessionId) : null) || (callControlId ? await findInteractionViewByCallControlId(pool, callControlId) : null)
        : null;
      const inScope = interaction && (await workItemInScope(pool, authz.scope, interaction.work_item_id || interaction.id, { queueId: interaction.queue_id, agentId: interaction.agent_id, channel: interaction.interaction_type }));
      if (!inScope) return NextResponse.json({ ok: false, error: "Call is outside your data scope" }, { status: 403 });
    }

    const baseUrl = getTelnyxBaseUrl();
    // Use /v2/application_events instead of /v2/call_events for significantly better performance
    const telnyxUrl = `${baseUrl}/v2/application_events?${params.toString()}`;

    const res = await fetch(telnyxUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
      return NextResponse.json(
        { ok: false, error: "Failed to fetch application events from Telnyx" },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json({
      ok: true,
      data: data.data || [],
      meta: data.meta || {},
    });
  } catch (error) {
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: "Failed to fetch call events" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("interactions_history:read", GET_handler, { route: "/api/voice/call-history/events" });
