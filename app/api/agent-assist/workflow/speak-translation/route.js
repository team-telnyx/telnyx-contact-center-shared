import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { startChunkedSpeak } from "@/lib/contact-center/speak-queue";

const DEFAULT_VOICE = "Minimax.speech-2.8-turbo.English_magnetic_voiced_man";

function hasPrivilegedRole(roles = []) {
  return roles.includes("admin") || roles.includes("owner") || roles.includes("supervisor");
}

export async function POST(request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { interactionId, sourceCallControlId, text, targetLanguage } = body;

    if (!interactionId || !sourceCallControlId || !text) {
      return NextResponse.json(
        { error: "interactionId, sourceCallControlId, and text are required" },
        { status: 400 }
      );
    }

    const { rows: [interaction] } = await pool.query(
      `SELECT id, agent_username, metadata FROM cc_interactions WHERE id = $1`,
      [interactionId]
    );

    if (!interaction) {
      return NextResponse.json({ error: "Interaction not found" }, { status: 404 });
    }

    const roles = session.user.roles || [];
    if (interaction.agent_username !== session.user.username && !hasPrivilegedRole(roles)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const metadata = interaction.metadata || {};
    const originalCallControlId = metadata.original_call_control_id;
    const agentCallControlId = metadata.agent_call_control_id;

    let targetCallControlId = null;
    if (sourceCallControlId === originalCallControlId) {
      targetCallControlId = agentCallControlId;
    } else if (sourceCallControlId === agentCallControlId) {
      targetCallControlId = originalCallControlId;
    }

    if (!targetCallControlId) {
      return NextResponse.json(
        { error: "Target call leg not available" },
        { status: 400 }
      );
    }

    const result = await startChunkedSpeak(
      targetCallControlId,
      text,
      DEFAULT_VOICE,
      targetLanguage || undefined
    );

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error || "Failed to speak translation" },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, chunked: result.chunked });
  } catch (error) {
    console.error("[Agent Assist] Speak translation error:", error);
    return NextResponse.json(
      { error: error.message || "Failed to speak translation" },
      { status: 500 }
    );
  }
}
