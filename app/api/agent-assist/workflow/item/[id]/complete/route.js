/**
 * Agent Assist Workflow - Manual Item Complete API
 * PUT - Manually mark an item as completed
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import { readSlotsFilled, resolveMcpCandidateSelection, runAndPersistSlotMcpBindings } from "@/lib/agent-assist/slot-mcp-execute";
import { reconcileDerivedSlots } from "@/lib/agent-assist/derived-slot-reconciliation.mjs";
import { resolveInferredBeds, NO_BED_VALUE, INFERRED_BY } from "@/lib/agent-assist/room-bed-inference.mjs";
import { interactionAgentMatches } from "@/lib/contact-center/interaction-agent-access.mjs";
import { withPermission } from "@/lib/authz/guard";

function hasPrivilegedRole(roles = []) {
  return roles.includes("admin") || roles.includes("owner") || roles.includes("supervisor");
}

// session.user.username is derived from the JWT's token.email, captured at
// login — a username rename or email-fallback login after that can leave it
// stale relative to Core assignment. A fresh by-id lookup is
// the second candidate identity, same pattern as the wrapup/metrics routes.
async function getUsernameForUserId(pool, userId) {
  if (!pool || !userId) return null;
  const { rows: [row] } = await pool.query(
    `SELECT username FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  return row?.username || null;
}

// Slot items still awaiting a value, for the room -> bed inference (an earlier fix).
const OPEN_SLOT_ITEMS_SQL = `
  SELECT i.id, i.type, i.slot_name
    FROM aa_workflow_items i
    JOIN aa_workflow_stages s ON i.stage_id = s.id
    JOIN aa_workflow_item_status ist ON ist.item_id = i.id AND ist.session_id = $1
   WHERE s.workflow_id = $2 AND i.type = 'slot' AND ist.status IN ('pending', 'suggested')`;

// Presence check that preserves boolean false / 0 — a captured "No" is a real
// value. Truthiness (value || null / && value) would drop it.
function hasMeaningfulValue(value) {
  return value !== null && value !== undefined && value !== "";
}

// PUT /api/agent-assist/workflow/item/[id]/complete - Complete item manually
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
    const { sessionId, interactionId, value } = body;

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

    // A plain login must not be able to read or mutate another agent's
    // session, and this route now also triggers MCP tool calls (network
    // egress using that session's data) as a side effect of the write —
    // same check as the manual MCP submit endpoint.
    const { rows: [interaction] } = await pool.query(
      `SELECT agent_username FROM acd_history_interactions WHERE id = $1`,
      [workflowSession.work_item_id]
    );
    const roles = session.user.roles || [];
    const currentUsername = await getUsernameForUserId(pool, session.user.id);
    // interactionAgentMatches treats an empty candidate list as a match (the
    // wrapup routes it was built for use that to skip the check when identity
    // couldn't be derived at all). This caller must NOT inherit that: an
    // authenticated session with no users-table identity (e.g. an OAuth login
    // never provisioned in `users`) must be denied, not treated as a pass
    // (Codex review on #1372/#1373 — fail closed, not open, on unresolved identity).
    const candidateUsernames = [session.user.username, currentUsername].filter(Boolean);
    if (
      (candidateUsernames.length === 0 || !interactionAgentMatches(interaction, candidateUsernames)) &&
      !hasPrivilegedRole(roles)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

    // Beds resolved by the room -> bed inference (an earlier fix), returned to the
    // client so the live store can apply them without a refresh.
    const inferredUpdates = [];

    // Only an opaque MCP candidate token enters the selection path. A normal
    // agent-entered value is a manual override even while choices are parked.
    // This prevents the candidate list from trapping the agent in a 409 when
    // the right facility was not one of the MCP matches.
    const selection = await resolveMcpCandidateSelection({
      sessionId: workflowSession.id,
      workflowId: workflowSession.workflow_id,
      itemId,
      value,
    });

    if (selection.pending && !selection.resolved) {
      return NextResponse.json(
        { error: "That option is no longer available; please choose from the current matches." },
        { status: 409 },
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Update item status. is_manual_edit=TRUE is the unambiguous marker the
      // analyze route's correction guards key on (an earlier fix follow-up) — unlike
      // completed_by='agent'+confidence=1, which can ALSO occur when the
      // agent SPOKE the value and the LLM was maximally confident, this
      // column is set ONLY by an actual manual edit.
      // Skipped when a candidate selection resolved: that path already completed
      // this item with 'mcp_selected' provenance and wrote the chosen
      // candidate's full output mapping. Re-writing it here would downgrade it
      // to a hand-typed override and freeze it against later corrections.
      //
      // derived_from_slot = NULL (Codex review, PR #1387, P1): an agent
      // manually overriding a copied value (e.g. typing over the
      // pickup_facility that the analyze route's Sixth guard copied from
      // caller_facility) makes it this item's own independent answer. Left
      // set, reconcileDerivedSlots below would keep re-syncing the agent's
      // deliberate edit back to caller_facility on the next reconciliation pass.
      if (!selection.resolved) {
        await client.query(
          `UPDATE aa_workflow_item_status
           SET status = 'completed',
               completed_at = NOW(),
               completed_by = 'agent',
               extracted_value = $1,
               confidence_score = 1.0,
               is_manual_edit = TRUE,
               alternatives = NULL,
               derived_from_slot = NULL,
               updated_at = NOW()
           WHERE session_id = $2 AND item_id = $3`,
          [hasMeaningfulValue(value) ? value : null, workflowSession.id, itemId]
        );

        // A typed/manual value supersedes any MCP suggestion for this item.
        // Clear all parked candidate generations in the SAME transaction as the
        // authoritative agent completion so a stale chip cannot be replayed.
        await client.query(
          `UPDATE aa_workflow_sessions
              SET mcp_candidates = COALESCE(mcp_candidates, '{}'::jsonb) - ARRAY(
                    SELECT key
                      FROM jsonb_each(COALESCE(mcp_candidates, '{}'::jsonb))
                     WHERE value ->> 'item_id' = $2
                  ),
                  updated_at = NOW()
            WHERE id = $1`,
          [workflowSession.id, itemId],
        );
      }

      // If this is a slot item with a value, update slots_filled
      if (item.slot_name && hasMeaningfulValue(value)) {
        const slotsFilled = { ...(workflowSession.slots_filled || {}) };
        // Candidate tokens are transport identities and must never enter slots.
        if (!selection.resolved) slotsFilled[item.slot_name] = value;

        // an earlier fix: the agent may resolve the room by hand ("N/A", "none" —
        // a scene pickup or residence). A room with no number has no bed, so
        // resolve the paired bed too instead of leaving it open for a prompt.
        // Selection values are generated machine data, not room/bed manual edits.
        const inferredBeds = [];
        if (!selection.resolved) {
          const { rows: openSlotItems } = await client.query(OPEN_SLOT_ITEMS_SQL, [
            workflowSession.id,
            workflowSession.workflow_id,
          ]);
          inferredBeds.push(...await resolveInferredBeds({
            client,
            sessionId: workflowSession.id,
            items: openSlotItems,
            slotsFilled,
          }));
        }

        // Merge only what this request changed. workflowSession.slots_filled is
        // a snapshot read before any of this ran, so writing the whole object
        // back would delete a slot a concurrent analyze call captured meanwhile.
        const slotsDelta = selection.resolved ? {} : { [item.slot_name]: value };
        for (const { item: bedItem } of inferredBeds) {
          slotsDelta[bedItem.slot_name] = NO_BED_VALUE;
        }

        // Selection already wrote the chosen candidate's full mapping; this
        // would overwrite it with the opaque token the chip carried.
        if (!selection.resolved) await client.query(
          `UPDATE aa_workflow_sessions
           SET slots_filled = COALESCE(slots_filled, '{}'::jsonb) || $1::jsonb,
               slots_version = COALESCE(slots_version, 0) + 1,
               updated_at = NOW()
           WHERE id = $2`,
          [JSON.stringify(slotsDelta), workflowSession.id]
        );

        for (const { item: bedItem, itemId: bedItemId, roomSlotName } of inferredBeds) {
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
            reason: `${roomSlotName}=${slotsFilled[roomSlotName]}`,
          }));
        }
      }

      // Codex review (PR #1387, P1): this route can manually edit either
      // premise a derived slot depends on directly (caller_facility itself,
      // or pickup_same_as_requesting_facility) — reconcile atomically with
      // that same write, in the same transaction, rather than leaving a
      // stale copied value to wait for the next transcript analyze pass
      // (which may never come before dispatch). See
      // derived-slot-reconciliation.mjs for the full relationship.
      const { updates: derivedUpdates } = await reconcileDerivedSlots({ client, sessionId: workflowSession.id });

      // Recalculate completion percentage
      const { rows: [stats] } = await client.query(
        `SELECT 
          COUNT(*) as total,
          COUNT(*) FILTER (WHERE status = 'completed') as completed
         FROM aa_workflow_item_status
         WHERE session_id = $1`,
        [workflowSession.id]
      );

      const completionPercentage = stats.total > 0 
        ? Math.round((stats.completed / stats.total) * 100)
        : 0;

      await client.query(
        `UPDATE aa_workflow_sessions 
         SET completion_percentage = $1, updated_at = NOW()
         WHERE id = $2`,
        [completionPercentage, workflowSession.id]
      );

      // Check if workflow is complete
      if (completionPercentage === 100) {
        await client.query(
          `UPDATE aa_workflow_sessions
           SET status = 'completed', completed_at = NOW()
           WHERE id = $1`,
          [workflowSession.id]
        );
      } else {
        // Codex review (PR #1387, P1): reconciliation above can reopen a
        // previously-completed pickup_facility (the premise changed),
        // dropping completionPercentage below 100 on a session that had
        // already been marked 'completed'. POST /analyze only operates on
        // status = 'in_progress' sessions, so leaving status = 'completed'
        // here would strand the reopened slot - no further speech could
        // ever refill it. No-ops on a session that was already in_progress.
        await client.query(
          `UPDATE aa_workflow_sessions
             SET status = 'in_progress', completed_at = NULL
           WHERE id = $1 AND status = 'completed'`,
          [workflowSession.id]
        );
      }

      await client.query("COMMIT");

      // Completing the final slot by hand must still fire on_fill and
      // on_complete bindings. Runs after COMMIT and off the transaction client,
      // so a slow tool call holds no row locks.
      let mcpInvocations = [];
      let mcpItemUpdates = [];
      let mcpCompletionPercentage = null;
      // null, never {}: the store treats a returned map as authoritative and
      // replaces its state with it, so an empty object would clear every
      // captured slot on a workflow that ran no bindings.
      let mcpSlotsFilled = null;
      let slotStateTouched = selection.resolved || derivedUpdates.length > 0;
      if (selection.resolved) mcpItemUpdates.push(...selection.itemUpdates);
      if (derivedUpdates.length > 0) mcpItemUpdates.push(...derivedUpdates);

      try {
        const bindingRun = await runAndPersistSlotMcpBindings({
          sessionId: workflowSession.id,
          workflowId: workflowSession.workflow_id,
          interactionId: workflowSession.work_item_id,
        });
        mcpInvocations = bindingRun.invocations;
        mcpItemUpdates.push(...bindingRun.itemUpdates);
        if (bindingRun.slotsFilled) {
          mcpSlotsFilled = bindingRun.slotsFilled;
          slotStateTouched = false;
        } else if (Object.keys(bindingRun.slotUpdates || {}).length > 0) {
          slotStateTouched = true;
        }
        if (typeof bindingRun.completionPercentage === "number") {
          mcpCompletionPercentage = bindingRun.completionPercentage;
        }
      } catch (mcpErr) {
        workflowLogger.error("slot_mcp_bindings_failed", agentAssistRuntimePayload({
          sessionId: workflowSession.id,
          interactionId: workflowSession.work_item_id,
          workflowId: workflowSession.workflow_id,
          itemId,
          reason: mcpErr?.message || "binding run failed",
        }));
      }

      // `slotsFilled` always means the whole document, never a patch. A
      // selection with no downstream binding produces no snapshot of its own,
      // so read one rather than returning its mapped values as if they were the
      // authoritative document.
      if (slotStateTouched) mcpSlotsFilled = await readSlotsFilled(workflowSession.id);

      return NextResponse.json({
        ok: true,
        item_id: itemId,
        status: "completed",
        completionPercentage: mcpCompletionPercentage ?? completionPercentage,
        inferredUpdates,
        mcpInvocations,
        itemUpdates: mcpItemUpdates,
        slotsFilled: mcpSlotsFilled,
        mcpSelectionResolved: selection.resolved,
        mcpSelectionSlots: selection.selectedSlotNames || [],
        // Only ever set from a post-MCP read of the whole document.
        slotsFilledAuthoritative: mcpSlotsFilled !== null,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    workflowLogger.error("agent_assist_workflow", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return NextResponse.json(
      { error: error.message || "Failed to complete item" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const PUT = withPermission("agent:self", PUT_handler, { route: "/api/agent-assist/workflow/item/[id]/complete" });
