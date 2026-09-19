import { NextResponse } from "next/server";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

export const dynamic = "force-dynamic";

function exportFilename(name = "call_flow") {
  const safeName = String(name || "call_flow")
    .replace(/[^a-z0-9]/gi, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  return `${safeName || "call_flow"}_flow.json`;
}

/**
 * GET /api/voice/flows/[id]/export
 * Export a call flow as a portable JSON bundle.
 */
async function GET_handler(request, { params }, authz) {
  try {
    // Holders of the call-flow permission export any flow; others only their own.
    const username = authz.permitted ? null : (authz.user.username || authz.user.email || undefined);
    const { id } = await params;
    const flow = await VoiceFlowDb.getFlowById(id, username);

    if (!flow) {
      return NextResponse.json(
        { ok: false, error: "Flow not found" },
        { status: 404 },
      );
    }

    const exportData = {
      version: "1.0",
      type: "telnyx-contact-center-call-flow",
      name: flow.name,
      description: flow.description || "",
      nodes: flow.nodes || [],
      edges: flow.edges || [],
      globalVariables: flow.variables || {},
      variables: flow.variables || {},
      metadata: flow.metadata || {},
      exported_at: new Date().toISOString(),
    };

    return new NextResponse(JSON.stringify(exportData, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${exportFilename(flow.name)}"`,
      },
    });
  } catch (error) {
    voiceRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: error.message || "Failed to export flow" },
      { status: 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("call_flows:export", GET_handler, { route: "/api/voice/flows/[id]/export" });
