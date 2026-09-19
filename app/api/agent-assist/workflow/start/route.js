/**
 * Agent Assist Workflow - Start Session API
 * POST - Start a new workflow session for an interaction
 * 
 * Also checks for pending AI handoff data and applies it to the session.
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { applyPendingAiHandoff, broadcastAiHandoffToAgent, recalculateCurrentStage } from "@/lib/agent-assist/ai-handoff-processor";
import { buildWorkflowPrefillFromClientState } from "@/lib/agent-assist/workflow-prefill";
import { runAndPersistSlotMcpBindings } from "@/lib/agent-assist/slot-mcp-execute";
import { agentAssistRuntimePayload, handoffLogger, workflowLogger } from "@/lib/agent-assist/logging.mjs";
import { interactionAgentMatches } from "@/lib/contact-center/interaction-agent-access.mjs";
import { findWorkItemByReference } from "@/lib/acd/work-item-repository.mjs";
import { withPermission } from "@/lib/authz/guard";

function hasPrivilegedRole(roles = []) {
  return roles.includes("admin") || roles.includes("owner") || roles.includes("supervisor");
}

// session.user.username is derived from the JWT's token.email, captured at
// login — a username rename or email-fallback login after that can leave it
// stale relative to the Core assignment owner. A fresh by-id lookup is
// the second candidate identity, same pattern as the wrapup/metrics routes.
async function getUsernameForUserId(pool, userId) {
  if (!pool || !userId) return null;
  const { rows: [row] } = await pool.query(
    `SELECT username FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  return row?.username || null;
}

// POST /api/agent-assist/workflow/start - Start workflow session
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
    const { interactionId, workflowId } = body;

    if (!interactionId) {
      return NextResponse.json(
        { error: "interactionId is required" },
        { status: 400 }
      );
    }

    if (!workflowId) {
      return NextResponse.json(
        { error: "workflowId is required" },
        { status: 400 }
      );
    }

    // Verify interaction exists and check for AI call control ID
    const interaction = await findWorkItemByReference(pool, interactionId);

    if (!interaction) {
      return NextResponse.json(
        { error: "Interaction not found" },
        { status: 404 }
      );
    }

    // A plain login must not be able to start a session on another agent's
    // interaction and trigger its startup MCP pass (network egress + side
    // effects) — same check as the manual MCP submit and slot/complete routes.
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

    // Check if this interaction has AI call control ID (came from AI assistant)
    const aiCallControlId = interaction.metadata?.ai_call_control_id;
    const hasAiHandoff = Boolean(aiCallControlId);
    // Check if session already exists for this interaction
    const { rows: [existingSession] } = await pool.query(
      `SELECT id FROM aa_workflow_sessions
        WHERE work_item_id = $1`,
      [interaction.work_item_id]
    );

    if (existingSession) {
      return NextResponse.json(
        { error: "Workflow session already exists for this interaction" },
        { status: 409 }
      );
    }

    // Verify workflow exists and is active
    const { rows: [workflow] } = await pool.query(
      `SELECT id, name, is_active FROM aa_workflows WHERE id = $1`,
      [workflowId]
    );

    if (!workflow) {
      return NextResponse.json(
        { error: "Workflow not found" },
        { status: 404 }
      );
    }

    if (!workflow.is_active) {
      return NextResponse.json(
        { error: "Workflow is not active" },
        { status: 400 }
      );
    }

    // Get first stage of workflow
    const { rows: [firstStage] } = await pool.query(
      `SELECT id FROM aa_workflow_stages 
       WHERE workflow_id = $1 
       ORDER BY order_index 
       LIMIT 1`,
      [workflowId]
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Read the previous session status BEFORE upsert so we can reliably detect
      // a completed→in_progress restart without relying on post-upsert row state
      const { rows: [prevSession] } = await client.query(
        `SELECT status FROM aa_workflow_sessions
          WHERE work_item_id = $1`,
        [interaction.work_item_id]
      );
      const wasCompleted = prevSession?.status === 'completed';

      // Read workflow slot items before creating the session so call-flow data can
      // become the initial slots_filled payload.
      const { rows: items } = await client.query(
        `SELECT i.id as item_id, i.id, i.type, i.slot_name
         FROM aa_workflow_items i
         JOIN aa_workflow_stages s ON i.stage_id = s.id
         WHERE s.workflow_id = $1
         ORDER BY s.order_index, i.order_index`,
        [workflowId]
      );

      const callFlowWorkflowData =
        interaction.metadata?.workflow_data ||
        interaction.metadata?.agent_assist_config?.workflow_data_resolved ||
        {};
      const workflowPrefill = buildWorkflowPrefillFromClientState(
        { workflow_data: callFlowWorkflowData },
        { items },
      );

      // Create workflow session — ON CONFLICT: return existing session if already started
      // If the previous session was 'completed', fully reset progress.
      const { rows: [workflowSession] } = await client.query(
        `INSERT INTO aa_workflow_sessions 
         (work_item_id, workflow_id, current_stage_id, status, started_at, slots_filled, completion_percentage)
         VALUES ($1, $2, $3, 'in_progress', NOW(), $4::jsonb, 0)
         ON CONFLICT (work_item_id) WHERE work_item_id IS NOT NULL DO UPDATE
           SET workflow_id = EXCLUDED.workflow_id,
               current_stage_id = EXCLUDED.current_stage_id,
               status = CASE WHEN aa_workflow_sessions.status = 'completed' THEN 'in_progress' ELSE aa_workflow_sessions.status END,
               started_at = CASE WHEN aa_workflow_sessions.status = 'completed' THEN NOW() ELSE aa_workflow_sessions.started_at END,
               slots_filled = CASE WHEN aa_workflow_sessions.status = 'completed' THEN $4::jsonb ELSE aa_workflow_sessions.slots_filled END,
               -- Codex review (PR #1388, P1): slots_filled gets wholesale
               -- REPLACED above without this - every other writer of this
               -- column bumps slots_version, and reconcileDerivedSlots (and
               -- any other optimistic-concurrency reader) relies on that
               -- being universally true to detect a stale read. Left
               -- unbumped, a reconciliation pass that read the OLD document
               -- moments before this restart would see its version guard
               -- pass anyway and blindly apply its stale delta on top of
               -- the brand-new prefill document.
               slots_version = CASE WHEN aa_workflow_sessions.status = 'completed' THEN COALESCE(aa_workflow_sessions.slots_version, 0) + 1 ELSE aa_workflow_sessions.slots_version END,
               completion_percentage = CASE WHEN aa_workflow_sessions.status = 'completed' THEN 0 ELSE aa_workflow_sessions.completion_percentage END,
               -- MCP state is session-scoped and must reset with everything
               -- else. Carrying mcp_runs over would skip bindings whose
               -- arguments match the previous call, and stale mcp_results would
               -- fire on_result chains against the last caller's facility.
               mcp_results = CASE WHEN aa_workflow_sessions.status = 'completed' THEN '{}'::jsonb ELSE COALESCE(aa_workflow_sessions.mcp_results, '{}'::jsonb) END,
               mcp_runs = CASE WHEN aa_workflow_sessions.status = 'completed' THEN '{}'::jsonb ELSE COALESCE(aa_workflow_sessions.mcp_runs, '{}'::jsonb) END,
               mcp_candidates = CASE WHEN aa_workflow_sessions.status = 'completed' THEN '{}'::jsonb ELSE COALESCE(aa_workflow_sessions.mcp_candidates, '{}'::jsonb) END
         RETURNING *`,
        [interaction.work_item_id, workflowId, firstStage?.id || null, JSON.stringify(workflowPrefill.slotsFilled)]
      );

      // If restarting a completed session, reset all item statuses back to pending
      // (ON CONFLICT DO NOTHING would otherwise preserve old completed states)
      // is_manual_edit reset too (Codex review, P2): a fresh run of the
      // workflow starts collecting from scratch — a prior manual edit from
      // the ENDED session must not protect whatever gets captured for that
      // slot THIS time, whether spoken, prefilled, or edited again.
      // derived_from_slot reset too (Codex review, PR #1387, P1): the
      // ENDED session's pickup_facility <- caller_facility provenance is
      // meaningless once slots_filled itself has been wiped below. Left
      // stale, a genuinely independent completion written for THIS new
      // session by the call-flow/AI-handoff prefill writers below (which
      // don't touch this column) would inherit the old marker and get
      // wrongly reopened by reconciliation the first time it runs, since
      // the new run hasn't answered pickup_same_as_requesting_facility yet.
      const sessionWasCompleted = wasCompleted;
      if (sessionWasCompleted) {
        await client.query(
          `UPDATE aa_workflow_item_status SET status = 'pending', completed_at = NULL,
           completed_by = NULL, extracted_value = NULL, confidence_score = NULL,
           source_transcript = NULL, is_manual_edit = FALSE, derived_from_slot = NULL,
           updated_at = NOW()
           WHERE session_id = $1`,
          [workflowSession.id]
        );
      }

      // Insert pending status for new items — ON CONFLICT DO NOTHING (idempotent for active sessions)
      for (const item of items) {
        await client.query(
          `INSERT INTO aa_workflow_item_status (session_id, item_id, status)
           VALUES ($1, $2, 'pending')
           ON CONFLICT (session_id, item_id) DO NOTHING`,
          [workflowSession.id, item.item_id]
        );
      }

      if (workflowPrefill.itemCompletions.length > 0) {
        await client.query(
          `UPDATE aa_workflow_sessions
           SET slots_filled = COALESCE(slots_filled, '{}'::jsonb) || $2::jsonb,
               slots_version = COALESCE(slots_version, 0) + 1,
               updated_at = NOW()
           WHERE id = $1`,
          [workflowSession.id, JSON.stringify(workflowPrefill.slotsFilled)]
        );

        for (const completion of workflowPrefill.itemCompletions) {
          await client.query(
            `INSERT INTO aa_workflow_item_status
             (session_id, item_id, status, extracted_value, confidence_score, completed_at, completed_by, source_transcript)
             VALUES ($1, $2, 'completed', $3, NULL, NOW(), 'call_flow', $4)
             ON CONFLICT (session_id, item_id)
             DO UPDATE SET
               status = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.status ELSE 'completed' END,
               extracted_value = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.extracted_value ELSE $3 END,
               confidence_score = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.confidence_score ELSE NULL END,
               completed_at = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.completed_at ELSE NOW() END,
               completed_by = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN 'agent' ELSE 'call_flow' END,
               source_transcript = CASE WHEN aa_workflow_item_status.completed_by = 'agent' THEN aa_workflow_item_status.source_transcript ELSE $4 END,
               -- Codex review (PR #1387, P1): unconditional, no CASE needed -
               -- an agent-protected row should already be NULL here (every
               -- agent-driven completion path clears it), and this prefill
               -- value is by definition independent of the copy-guard
               -- relationship, not a leftover from a previous session.
               derived_from_slot = NULL,
               updated_at = NOW()`,
            [
              workflowSession.id,
              completion.itemId,
              typeof completion.value === "string" ? completion.value : JSON.stringify(completion.value),
              "client_state.workflow_data",
            ]
          );
        }
      }

      await client.query("COMMIT");
      if (workflowPrefill.itemCompletions.length > 0) {
        await recalculateCurrentStage(workflowSession.id);
      }

      workflowLogger.info("workflow_session_started", agentAssistRuntimePayload({
        sessionId: workflowSession.id,
        interactionId,
        workflowId,
        stageId: firstStage?.id || null,
        username: session.user?.email || session.user?.username || null,
        hasAiHandoff,
        prefilledSlots: Object.keys(workflowPrefill.slotsFilled || {}).length,
        prefilledItems: workflowPrefill.itemCompletions.length,
        restartedCompletedSession: sessionWasCompleted,
      }));

      // Check for pending AI handoff data and apply it
      let aiHandoffApplied = false;
      let aiHandoffData = null;
      if (hasAiHandoff) {
        try {
          handoffLogger.info("workflow_start", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
          aiHandoffData = await applyPendingAiHandoff(interactionId, workflowSession.id);
          if (aiHandoffData) {
            aiHandoffApplied = true;
            handoffLogger.info("workflow_start", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
            
            // Broadcast AI handoff data to agent
            await broadcastAiHandoffToAgent(interaction, workflowSession.id, aiHandoffData);
          }
        } catch (aiErr) {
          handoffLogger.warn("workflow_start", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
          // Don't fail session start if AI handoff fails
        }
      }

      // Startup prefill and pending AI handoff are first-class slot writers, but
      // bindings may also be immediately eligible with no caller input at all
      // (for example an input-free on_complete tool). Run one startup pass after
      // initialization unconditionally; the adapter returns cheaply when the
      // workflow has no bindings or no binding is currently eligible.
      try {
        await runAndPersistSlotMcpBindings({
          sessionId: workflowSession.id,
          workflowId,
          interactionId,
        });
      } catch (mcpErr) {
        // Session startup must remain available when enrichment is down. The
        // same best-effort policy is used by the manual slot-edit route.
        workflowLogger.error("slot_mcp_bindings_failed", agentAssistRuntimePayload({
          sessionId: workflowSession.id,
          interactionId,
          workflowId,
          reason: mcpErr?.message || "binding run failed during workflow startup",
        }));
      }

      // Fetch complete session state after startup MCP so the initial response
      // includes any derived slots, candidate chips, and completion changes.
      const sessionState = await getWorkflowSessionState(pool, workflowSession.id);

      return NextResponse.json({
        ok: true,
        session: sessionState,
        aiHandoffApplied,
        hasAiHandoff,
        aiCallControlId: aiCallControlId || null,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (error) {
    handoffLogger.error("agent_assist_workflow", agentAssistRuntimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : typeof parseError !== "undefined" ? parseError : typeof aiErr !== "undefined" ? aiErr : undefined, sessionId: typeof sessionId !== "undefined" ? sessionId : typeof workflowSession !== "undefined" ? workflowSession?.id : undefined, interactionId: typeof interactionId !== "undefined" ? interactionId : undefined, workflowId: typeof workflowId !== "undefined" ? workflowId : typeof workflow !== "undefined" ? workflow?.id : undefined, itemId: typeof itemId !== "undefined" ? itemId : typeof id !== "undefined" ? id : undefined, slotName: typeof slotName !== "undefined" ? slotName : typeof name !== "undefined" ? name : undefined, language: typeof language !== "undefined" ? language : typeof targetLanguage !== "undefined" ? targetLanguage : undefined, provider: typeof provider !== "undefined" ? provider : "telnyx", reason: typeof reason !== "undefined" ? reason : undefined, status: typeof status !== "undefined" ? status : undefined, statusCode: typeof response !== "undefined" ? response?.status : undefined }));
    return NextResponse.json(
      { error: error.message || "Failed to start workflow session" },
      { status: 500 }
    );
  }
}

/**
 * Helper function to get complete workflow session state
 */
async function getWorkflowSessionState(pool, sessionId) {
  // Get session with interaction and agent info
  const { rows: [session] } = await pool.query(
    `SELECT s.*, 
            w.name as workflow_name, 
            w.category as workflow_category,
            w.data_action_buttons,
            i.agent_username,
            u.first_name as agent_first_name,
            u.last_name as agent_last_name
     FROM aa_workflow_sessions s
     JOIN aa_workflows w ON s.workflow_id = w.id
     LEFT JOIN acd_history_interactions i ON s.work_item_id = i.id
     LEFT JOIN users u ON u.username = i.agent_username
     WHERE s.id = $1`,
    [sessionId]
  );

  if (!session) return null;
  
  // Build agent_name from user record
  const agentName = session.agent_first_name 
    ? `${session.agent_first_name}${session.agent_last_name ? ' ' + session.agent_last_name : ''}`
    : session.agent_username || null;

  // Get stages with items
  const { rows: stages } = await pool.query(
    `SELECT * FROM aa_workflow_stages 
     WHERE workflow_id = $1 
     ORDER BY order_index`,
    [session.workflow_id]
  );

  // Get all items for this workflow
  const stageIds = stages.map(s => s.id);
  let items = [];
  if (stageIds.length > 0) {
    const { rows } = await pool.query(
      `SELECT * FROM aa_workflow_items WHERE stage_id = ANY($1) ORDER BY stage_id, order_index`,
      [stageIds]
    );
    items = rows;
  }

  // Get item statuses for this session
  const { rows: itemStatuses } = await pool.query(
    `SELECT * FROM aa_workflow_item_status WHERE session_id = $1`,
    [sessionId]
  );

  // Create item status map
  const statusMap = itemStatuses.reduce((acc, status) => {
    acc[status.item_id] = status;
    return acc;
  }, {});

  // Attach items to stages with status
  const itemsByStage = items.reduce((acc, item) => {
    if (!acc[item.stage_id]) acc[item.stage_id] = [];
    acc[item.stage_id].push({
      ...item,
      status: statusMap[item.id] || { status: 'pending' },
    });
    return acc;
  }, {});

  stages.forEach(stage => {
    stage.items = itemsByStage[stage.id] || [];
  });

  // Calculate current stage index
  const currentStageIndex = stages.findIndex(s => s.id === session.current_stage_id);

  return {
    ...session,
    agent_name: agentName,
    stages,
    currentStageIndex: currentStageIndex >= 0 ? currentStageIndex : 0,
  };
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("agent:self", POST_handler, { route: "/api/agent-assist/workflow/start" });
