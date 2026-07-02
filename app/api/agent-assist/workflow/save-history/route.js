/**
 * Agent Assist Workflow - Save History API
 * POST - Save transcriptions and suggestions to workflow session for history viewing
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";

// POST /api/agent-assist/workflow/save-history - Save workflow history data
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
    const { sessionId, interactionId, transcriptions, suggestions } = body;

    if (!sessionId && !interactionId) {
      return NextResponse.json(
        { error: "sessionId or interactionId is required" },
        { status: 400 }
      );
    }

    // Find workflow session
    let workflowSession;
    if (sessionId) {
      const { rows: [s] } = await pool.query(
        `SELECT * FROM aa_workflow_sessions WHERE id = $1`,
        [sessionId]
      );
      workflowSession = s;
    } else {
      const { rows: [s] } = await pool.query(
        `SELECT * FROM aa_workflow_sessions WHERE interaction_id = $1`,
        [interactionId]
      );
      workflowSession = s;
    }

    if (!workflowSession) {
      return NextResponse.json(
        { error: "Workflow session not found" },
        { status: 404 }
      );
    }

    // Update interaction metadata with agent_assist data (transcriptions + suggestions)
    const effectiveInteractionId = workflowSession.interaction_id;

    // Get current metadata
    const { rows: [interaction] } = await pool.query(
      `SELECT metadata FROM cc_interactions WHERE id = $1`,
      [effectiveInteractionId]
    );

    if (!interaction) {
      return NextResponse.json(
        { error: "Interaction not found" },
        { status: 404 }
      );
    }

    // Parse existing metadata
    let metadata = interaction.metadata;
    if (typeof metadata === "string") {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = {};
      }
    }
    if (!metadata || typeof metadata !== "object") metadata = {};

    // Merge with existing agent_assist data (don't overwrite if empty)
    const existingAgentAssist = metadata.agent_assist || {};
    metadata.agent_assist = {
      ...existingAgentAssist,
      // Only update transcriptions if provided and non-empty
      ...(transcriptions && transcriptions.length > 0 ? { transcriptions } : {}),
      // Only update suggestions if provided and non-empty
      ...(suggestions && suggestions.length > 0 ? { suggestions } : {}),
      workflow_session_id: workflowSession.id,
      updated_at: new Date().toISOString(),
    };

    // Save updated metadata
    await pool.query(
      `UPDATE cc_interactions SET metadata = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(metadata), effectiveInteractionId]
    );

    return NextResponse.json({
      ok: true,
      message: "Workflow history saved successfully",
    });
  } catch (error) {
    workflowLogger.error("agent_assist_workflow", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return NextResponse.json(
      { error: error.message || "Failed to save workflow history" },
      { status: 500 }
    );
  }
}
