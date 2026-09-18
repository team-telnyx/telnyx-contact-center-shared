/**
 * Agent Assist Workflow - Skip Item API
 * PUT - Skip an item in the workflow
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import { resolveInferredBeds, isRoomSlotName, NO_BED_VALUE, INFERRED_BY } from "@/lib/agent-assist/room-bed-inference.mjs";
import { withPermission } from "@/lib/authz/guard";

// PUT /api/agent-assist/workflow/item/[id]/skip - Skip item
async function PUT_handler(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id: itemId } = await params;
    
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { error: "Database not configured" },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { sessionId, interactionId } = body;

    if (!sessionId && !interactionId) {
      return NextResponse.json(
        { error: "sessionId or interactionId is required" },
        { status: 400 }
      );
    }

    // Find session
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

    // Verify item belongs to this workflow
    const { rows: [item] } = await pool.query(
      `SELECT i.*, s.workflow_id
       FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
       WHERE i.id = $1 AND s.workflow_id = $2`,
      [itemId, workflowSession.workflow_id]
    );

    if (!item) {
      return NextResponse.json(
        { error: "Item not found in this workflow" },
        { status: 404 }
      );
    }

    // Update item status to skipped
    await pool.query(
      `UPDATE aa_workflow_item_status 
       SET status = 'skipped',
           completed_at = NOW(),
           completed_by = 'agent',
           updated_at = NOW()
       WHERE session_id = $1 AND item_id = $2`,
      [workflowSession.id, itemId]
    );

    // Note: Skipped items are NOT counted toward completion percentage
    // Only completed items count

    // an earlier fix: skipping the room item is the agent saying this location has no
    // room (scene pickup, residence). A location with no room has no bed, so
    // resolve the paired bed instead of leaving it open to be prompted for.
    // The skip writes no slot value, so the room is passed by name.
    const inferredUpdates = [];
    if (item.type === "slot" && isRoomSlotName(item.slot_name)) {
      const { rows: openSlotItems } = await pool.query(
        `SELECT i.id, i.type, i.slot_name
           FROM aa_workflow_items i
           JOIN aa_workflow_stages s ON i.stage_id = s.id
           JOIN aa_workflow_item_status ist ON ist.item_id = i.id AND ist.session_id = $1
          WHERE s.workflow_id = $2 AND i.type = 'slot' AND ist.status IN ('pending', 'suggested')`,
        [workflowSession.id, workflowSession.workflow_id]
      );

      const slotsFilled = { ...(workflowSession.slots_filled || {}) };
      const resolved = await resolveInferredBeds({
        client: pool,
        sessionId: workflowSession.id,
        items: openSlotItems,
        slotsFilled,
        noRoomSlotNames: [item.slot_name],
      });

      if (resolved.length > 0) {
        // Merge only the inferred keys. workflowSession.slots_filled is a
        // snapshot read before this request did anything, so writing the whole
        // object back would delete any slot a concurrent analyze call captured
        // in the meantime. Same atomic jsonb merge the analyze route uses.
        const inferredDelta = Object.fromEntries(
          resolved.map(({ item: bedItem }) => [bedItem.slot_name, NO_BED_VALUE])
        );
        await pool.query(
          `UPDATE aa_workflow_sessions
             SET slots_filled = COALESCE(slots_filled, '{}'::jsonb) || $1::jsonb,
                 slots_version = COALESCE(slots_version, 0) + 1,
                 updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(inferredDelta), workflowSession.id]
        );

        for (const { item: bedItem, itemId: bedItemId } of resolved) {
          // Same update shape the analyze route returns, so the live store can
          // apply it directly — otherwise the panel keeps asking for the bed
          // until the next analysis or session refresh.
          inferredUpdates.push({
            item_id: bedItemId,
            slot_name: bedItem.slot_name,
            status: "completed",
            extracted_value: NO_BED_VALUE,
            completed_by: INFERRED_BY,
            confidence_score: 1,
          });
          workflowLogger.info("workflow_bed_inferred_from_no_room", agentAssistRuntimePayload({
            sessionId: workflowSession.id,
            interactionId: workflowSession.work_item_id,
            slotName: bedItem.slot_name,
            reason: `${item.slot_name}=(skipped)`,
          }));
        }
      }
    }

    return NextResponse.json({
      ok: true,
      item_id: itemId,
      status: "skipped",
      inferredUpdates,
    });
  } catch (error) {
    workflowLogger.error("agent_assist_workflow", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return NextResponse.json(
      { error: error.message || "Failed to skip item" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const PUT = withPermission("agent:self", PUT_handler, { route: "/api/agent-assist/workflow/item/[id]/skip" });
