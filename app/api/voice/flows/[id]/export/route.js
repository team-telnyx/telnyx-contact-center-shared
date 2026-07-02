import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { VoiceFlowDb } from "@/lib/pgdb-voice-flows";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

export const dynamic = "force-dynamic";

async function getFlowAccessUsername(session) {
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!email) return undefined;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  return user && isAdmin(user) ? null : email;
}

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
export async function GET(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const username = await getFlowAccessUsername(session);
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
