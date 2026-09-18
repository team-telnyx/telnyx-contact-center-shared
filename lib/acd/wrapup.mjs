// ACD-owned wrap-up completion. The segment and agent workflow transition
// commit together; the ordered Core stream projects the committed result.

import { usesNativeLifecycle } from "./channel-registry.mjs";
import { setManualAgentStatusInTransaction, setWorkflowState } from "./agent-state.mjs";
import { appendEvent } from "./events.mjs";

export async function completeAcdWrapup(
  pool,
  {
    workItemId,
    transactionClient = null,
    expectedAgentId = null,
    segmentId = null,
    wrapupCodeId = null,
    nextManualStatus = null,
    actor = "agent:wrapup",
  } = {},
) {
  if (!pool || !workItemId) {
    return { completed: false, reason: "missing_work_item" };
  }

  const channel=(await (transactionClient||pool).query("SELECT channel FROM acd_work_items WHERE id=$1",[workItemId])).rows[0]?.channel;
  if(usesNativeLifecycle(channel)){
    const {completeTextWrapup}=await import("./text-lifecycle.mjs");
    return completeTextWrapup(pool,{workItemId,transactionClient,expectedAgentId,segmentId,wrapupCodeId,nextManualStatus,actor});
  }

  const client = transactionClient || await pool.connect();
  const manageTransaction = !transactionClient;
  try {
    if (manageTransaction) await client.query("BEGIN");

    const workItemResult = await client.query(
      `SELECT id, state, terminal_at
         FROM acd_work_items
        WHERE id = $1
        FOR UPDATE`,
      [workItemId],
    );
    const workItem = workItemResult.rows[0];
    if (!workItem) {
      if (manageTransaction) await client.query("ROLLBACK");
      return { completed: false, reason: "work_item_not_found" };
    }
    const segmentResult = await client.query(
      `SELECT id, agent_id, ended_at, outcome, wrapup_ended_at
         FROM acd_segments
        WHERE work_item_id = $1
          AND kind = 'agent'
          AND agent_id IS NOT NULL
          AND ($2::text IS NULL OR agent_id = $2)
          AND ($3::uuid IS NULL OR id = $3)
        ORDER BY (wrapup_ended_at IS NULL) DESC, seq ASC
        LIMIT 1
        FOR UPDATE`,
      [workItemId, expectedAgentId, segmentId],
    );
    const segment = segmentResult.rows[0];
    if (!segment?.agent_id) {
      if (manageTransaction) await client.query("ROLLBACK");
      return { completed: false, reason: "agent_segment_not_found" };
    }
    if (expectedAgentId && String(segment.agent_id) !== String(expectedAgentId)) {
      if (manageTransaction) await client.query("ROLLBACK");
      return { completed: false, reason: "agent_mismatch" };
    }
    const terminalWorkItem =
      Boolean(workItem.terminal_at) &&
      ["completed", "abandoned", "failed"].includes(workItem.state);
    const transferredSegment =
      segment.outcome === "transferred" && Boolean(segment.ended_at);
    if (!terminalWorkItem && !transferredSegment) {
      if (manageTransaction) await client.query("ROLLBACK");
      return { completed: false, reason: "work_item_not_terminal" };
    }

    const agentStateResult = await client.query(
      `SELECT workflow_state, workflow_deadline_at, routability, workflow_work_item_id
         FROM acd_agent_state
        WHERE agent_id = $1
        FOR UPDATE`,
      [segment.agent_id],
    );
    const agentState = agentStateResult.rows[0];
    if (!agentState) {
      if (manageTransaction) await client.query("ROLLBACK");
      return { completed: false, reason: "agent_state_not_found" };
    }

    // A repeated action:end is idempotent. In particular, it must not release
    // an offer/handling session which started after this wrap-up completed.
    if (segment.wrapup_ended_at) {
      if (manageTransaction) await client.query("COMMIT");
      return {
        completed: true,
        agentId: String(segment.agent_id),
        alreadyCompleted: true,
        agentStateReleased: false,
        reason: "already_completed",
      };
    }

    // Typed workflow ownership is authoritative; historical rows retain the
    // append-only event fallback while the additive migration completes.
    const workflowOwnerResult = await client.query(
      `SELECT work_item_id, payload->>'workflow_state' AS workflow_state
         FROM acd_events
        WHERE agent_id = $1
          AND type = 'agent_workflow_changed'
        ORDER BY id DESC
        LIMIT 1`,
      [segment.agent_id],
    );
    const workflowOwner = agentState.workflow_work_item_id
      ? { workflow_state: agentState.workflow_state, work_item_id: agentState.workflow_work_item_id }
      : workflowOwnerResult.rows[0] || null;
    const ownsCurrentWrapup =
      agentState.workflow_state === "wrapup" &&
      workflowOwner?.workflow_state === "wrapup" &&
      String(workflowOwner.work_item_id || "") === String(workItemId);
    const ownershipReason = ownsCurrentWrapup
      ? null
      : agentState.workflow_state !== "wrapup"
        ? `agent_is_${agentState.workflow_state}`
        : workflowOwner?.workflow_state !== "wrapup"
          ? "wrapup_owner_unknown"
          : "newer_work_item_owns_wrapup";

    await client.query(
      `UPDATE acd_segments
          SET wrapup_ended_at = COALESCE(wrapup_ended_at, now()),
              wrapup_code_id = COALESCE($2, wrapup_code_id)
        WHERE id = $1`,
      [segment.id, wrapupCodeId],
    );
    if (ownsCurrentWrapup) {
      if (nextManualStatus) {
        await setManualAgentStatusInTransaction(client, {
          agentId: segment.agent_id,
          status: nextManualStatus,
          actor,
        });
      }
      await setWorkflowState(client, segment.agent_id, "idle", {
        actor,
        workItemId,
        reason: "wrapup_submitted",
      });

    }

    await appendEvent(client, {
      workItemId,
      agentId: segment.agent_id,
      type: "wrapup_completed",
      payload: {
        segment_id: segment.id,
        wrapup_code_id: wrapupCodeId,
        agent_state_released: ownsCurrentWrapup,
        ownership_reason: ownershipReason,
      },
      actor,
    });

    if (manageTransaction) await client.query("COMMIT");
    return {
      completed: true,
      agentId: String(segment.agent_id),
      alreadyCompleted: false,
      agentStateReleased: ownsCurrentWrapup,
      reason: ownershipReason,
    };
  } catch (error) {
    if (manageTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (manageTransaction) client.release();
  }
}

export async function saveAcdDisposition(db, { segmentId, agentId, codeId, actor }) {
  const segment = (await db.query(`UPDATE acd_segments SET wrapup_code_id = $3
    WHERE id = $1 AND agent_id = $2 AND kind = 'agent' AND ended_at IS NOT NULL AND wrapup_ended_at IS NULL
    RETURNING work_item_id`, [segmentId, agentId, codeId])).rows[0];
  if (!segment) throw Object.assign(new Error("Wrap-up segment changed or belongs to another agent"), { status: 409 });
  await appendEvent(db, { workItemId: segment.work_item_id, agentId, type: "disposition_saved", payload: { segment_id: segmentId, code_id: codeId }, actor });
  return { saved: true };
}
