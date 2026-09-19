/**
 * Agent Assist Workflow - Slot Update API
 * PUT - Manually update a slot value
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentAssistRuntimePayload, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import { readSlotsFilled, runAndPersistSlotMcpBindings } from "@/lib/agent-assist/slot-mcp-execute";
import { reconcileDerivedSlots } from "@/lib/agent-assist/derived-slot-reconciliation.mjs";
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

// PUT /api/agent-assist/workflow/slot/[name] - Update slot value
async function PUT_handler(request, { params }) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { name: slotName } = await params;
    
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

    if (value === undefined) {
      return NextResponse.json(
        { error: "value is required" },
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

    // Find the slot item in this workflow
    const { rows: [slotItem] } = await pool.query(
      `SELECT i.id
       FROM aa_workflow_items i
       JOIN aa_workflow_stages s ON i.stage_id = s.id
       WHERE s.workflow_id = $1 AND i.slot_name = $2`,
      [workflowSession.workflow_id, slotName]
    );

    // Merge only the edited key. workflowSession.slots_filled is a snapshot
    // read before this request did anything — writing the whole object back
    // would delete any slot a concurrent analyze call captured meanwhile
    // (same atomic jsonb merge the complete route and analyze route use).
    let slotsFilled = { ...(workflowSession.slots_filled || {}) };
    slotsFilled[slotName] = value;
    let derivedUpdates = [];

    // The manual value, its agent-owned item status, and retirement of any MCP
    // candidate generation for this item are one atomic state change. Without
    // this, a stale candidate chip can survive the manual edit and later
    // republish the old lookup result and sibling outputs.
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE aa_workflow_sessions
         SET slots_filled = COALESCE(slots_filled, '{}'::jsonb) || $1::jsonb,
             slots_version = COALESCE(slots_version, 0) + 1,
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify({ [slotName]: value }), workflowSession.id]
      );

      // If there's a corresponding item, update its status too. Unconditional
      // (an earlier fix): this is the agent EDITING a value, and the common case is a
      // slot that is already completed (crossed out) or sitting as an
      // unconfirmed suggestion. The old `AND status = 'pending'` guard silently
      // skipped exactly those rows, so the stale extracted_value kept winning in
      // the checklist (pickSlotValue prefers it over slots_filled) and the
      // analyzer still saw the row as AI-owned and could overwrite the edit.
      // is_manual_edit=TRUE is the manual-edit marker the analyzer's correction
      // guards key on — set ONLY here and by the complete route, never inferred
      // from confidence_score, since an agent-SPOKEN capture can also carry
      // confidence_score=1.0 and must stay distinguishable from a manual edit.
      if (slotItem) {
        // derived_from_slot = NULL (Codex review, PR #1387, P1): an agent
        // manually overriding a copied value makes it this item's own
        // independent answer. Left set, reconcileDerivedSlots below would
        // keep re-syncing the agent's deliberate edit right back.
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
          [value, workflowSession.id, slotItem.id]
        );

        // A manual slot-summary edit supersedes every parked MCP choice for this
        // item. Keep this in the same transaction as the authoritative agent
        // write so a token from the previous generation cannot remain valid.
        await client.query(
          `UPDATE aa_workflow_sessions
              SET mcp_candidates = COALESCE(mcp_candidates, '{}'::jsonb) - ARRAY(
                    SELECT key
                      FROM jsonb_each(COALESCE(mcp_candidates, '{}'::jsonb))
                     WHERE value ->> 'item_id' = $2
                  ),
                  updated_at = NOW()
            WHERE id = $1`,
          [workflowSession.id, slotItem.id]
        );

      }

      // Codex review (PR #1387, P1): this route can manually edit either
      // premise a derived slot depends on directly (caller_facility itself,
      // or pickup_same_as_requesting_facility) — reconcile atomically with
      // that same write, in the same transaction, rather than leaving a
      // stale copied value to wait for the next transcript analyze pass
      // (which may never come before dispatch). Runs regardless of whether
      // this specific slotName had a matching item, since the raw
      // slots_filled write above always happens. See
      // derived-slot-reconciliation.mjs for the full relationship.
      derivedUpdates = (await reconcileDerivedSlots({ client, sessionId: workflowSession.id })).updates;
      for (const update of derivedUpdates) {
        if (update.status === "pending") {
          delete slotsFilled[update.slot_name];
        } else {
          slotsFilled[update.slot_name] = update.extracted_value;
        }
      }

      // Codex review (P2): moved to run AFTER reconciliation, not nested
      // inside `if (slotItem)` before it - reconciliation can reopen a
      // previously-completed pickup_facility (the premise changed), and a
      // percentage computed beforehand would still show the pre-reopen
      // total, including a stale 100% returned to the client. Runs
      // unconditionally: reconciliation can change completion state even
      // when this specific edit's slotName had no matching item.
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
      // Codex review (P1, same finding as item/[id]/complete/route.js):
      // this route never itself promotes a session to 'completed', but a
      // session already 'completed' via analyze or the complete route can
      // have a slot reopened here by reconciliation. POST /analyze only
      // operates on status = 'in_progress' sessions, so a session stuck at
      // 'completed' with a reopened slot could never be refilled by further
      // speech. Demote it back so it can be.
      if (completionPercentage < 100) {
        await client.query(
          `UPDATE aa_workflow_sessions
             SET status = 'in_progress', completed_at = NULL
           WHERE id = $1 AND status = 'completed'`,
          [workflowSession.id]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    // A manually entered slot must trigger its binding exactly like an extracted
    // one: enrichment should not depend on how the value arrived.
    let mcpInvocations = [];
    let mcpItemUpdates = [];
    let mcpCompletionPercentage = null;
    let slotsFilledAuthoritative = false;
    try {
      const bindingRun = await runAndPersistSlotMcpBindings({
        sessionId: workflowSession.id,
        workflowId: workflowSession.workflow_id,
        interactionId: workflowSession.work_item_id,
      });
      mcpInvocations = bindingRun.invocations;
      // Authoritative map, never a merge: an ambiguous rerun REMOVES slots, and
      // merging would keep returning values the session no longer holds.
      if (bindingRun.slotsFilled) {
        slotsFilled = bindingRun.slotsFilled;
        slotsFilledAuthoritative = true;
      }
      mcpItemUpdates = bindingRun.itemUpdates;
      mcpCompletionPercentage = bindingRun.completionPercentage;
    } catch (mcpErr) {
      // Enrichment is best-effort; a tool outage must not fail the agent's edit.
      workflowLogger.error("slot_mcp_bindings_failed", agentAssistRuntimePayload({
        sessionId: workflowSession.id,
        interactionId: workflowSession.work_item_id,
        workflowId: workflowSession.workflow_id,
        slotName,
        reason: mcpErr?.message || "binding run failed",
      }));
    }

    // Merged unconditionally (not just on the try's happy path): reconciliation
    // already committed inside the transaction above, whether or not the
    // binding run itself succeeded.
    //
    // Codex review (P2): slotsFilled here is still request-start
    // workflowSession.slots_filled plus this request's own local edits -
    // NOT a full re-read. A concurrent analyze call can have committed an
    // unrelated slot after that initial read; the atomic jsonb merges used
    // throughout this route and reconciliation preserve it in the DB, but
    // marking THIS local (now stale-relative-to-that-write) object
    // authoritative would tell the client to replace its state with it,
    // erasing the concurrent capture from the UI. Re-read the full document
    // instead, same as item/[id]/complete/route.js already does via
    // readSlotsFilled whenever it sets slotsFilledAuthoritative.
    if (derivedUpdates.length > 0) {
      mcpItemUpdates = [...mcpItemUpdates, ...derivedUpdates];
      slotsFilled = await readSlotsFilled(workflowSession.id);
      slotsFilledAuthoritative = true;
    }

    return NextResponse.json({
      ok: true,
      slot: slotName,
      value,
      slotsFilled,
      mcpInvocations,
      // Let the desktop tick derived checklist items and refresh progress
      // without waiting for the next session refetch.
      itemUpdates: mcpItemUpdates,
      completionPercentage: mcpCompletionPercentage,
      slotsFilledAuthoritative,
    });
  } catch (error) {
    workflowLogger.error("agent_assist_workflow", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return NextResponse.json(
      { error: error.message || "Failed to update slot" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const PUT = withPermission("agent:self", PUT_handler, { route: "/api/agent-assist/workflow/slot/[name]" });
