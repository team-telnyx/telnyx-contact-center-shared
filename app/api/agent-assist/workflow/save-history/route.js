/**
 * Agent Assist Workflow - Save History API
 * POST - Save transcriptions and suggestions to workflow session for history viewing
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import {
  mergeAgentAssistSuggestions,
  mergeAgentAssistTranscriptions,
} from "@/lib/agent-assist/history-merge.mjs";
import { withPermission } from "@/lib/authz/guard";

// POST /api/agent-assist/workflow/save-history - Save workflow history data
async function POST_handler(request) {
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
        `SELECT * FROM aa_workflow_sessions WHERE work_item_id::text = $1`,
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

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows: [lockedSession] } = await client.query(
        `SELECT transcriptions, suggestions
           FROM aa_workflow_sessions
          WHERE id = $1
          FOR UPDATE`,
        [workflowSession.id]
      );

      if (!lockedSession) {
        await client.query("ROLLBACK");
        return NextResponse.json(
          { error: "Workflow session not found" },
          { status: 404 }
        );
      }
      await client.query(
        `UPDATE aa_workflow_sessions
            SET transcriptions = $2::jsonb,
                suggestions = $3::jsonb,
                updated_at = NOW()
          WHERE id = $1`,
        [
          workflowSession.id,
          JSON.stringify(
            mergeAgentAssistTranscriptions(
              lockedSession.transcriptions,
              transcriptions,
            ),
          ),
          JSON.stringify(
            mergeAgentAssistSuggestions(
              lockedSession.suggestions,
              suggestions,
            ),
          ),
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("agent:self", POST_handler, { route: "/api/agent-assist/workflow/save-history" });
