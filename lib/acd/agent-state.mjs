// Canonical ACD Core agent-state writer (the internal documentation §4.3).
// Presence, manual status and workflow are committed through this module so
// capacity, UI snapshots and status intervals always describe the same state.

import { createHash, randomUUID } from "node:crypto";
import { appendEvent } from "./events.mjs";

const WORKFLOW_STATES = new Set(["idle", "offered", "handling", "wrapup"]);
const PRESENCE_STATES = new Set(["online", "offline"]);
const STATE_COLUMNS = new Set([
  "presence",
  "routability",
  "status_id",
  "manual_status",
  "manual_status_set_at",
  "workflow_state",
  "workflow_deadline_at",
  "workflow_work_item_id",
]);
// Effective statuses during which a manual choice waits for the work to end.
const BUSY_STATUSES = new Set(["Busy", "Wrapup"]);

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function intervalKey({ agentId, status, nextStatus, startedAt, endedAt, sourceEventId }) {
  const values = sourceEventId
    ? ["event", sourceEventId, agentId, status, nextStatus]
    : ["interval", agentId, status, nextStatus, iso(startedAt), iso(endedAt)];
  return createHash("sha256")
    .update(values.map((value) => String(value || "")).join("\u0000"))
    .digest("hex");
}

export function effectiveAgentStatus(state) {
  if (!state) return "Offline";
  if (state.workflow_state === "handling" || state.workflow_state === "offered") return "Busy";
  if (state.workflow_state === "wrapup") return "Wrapup";
  return state.presence === "offline" ? "Offline" : state.manual_status || "Available";
}

/** SQL equivalent of effectiveAgentStatus for server-side lists and filters. */
export function effectiveAgentStatusSql(alias = "ast") {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error("Invalid agent-state SQL alias");
  }
  return `CASE
    WHEN ${alias}.workflow_state IN ('handling', 'offered') THEN 'Busy'
    WHEN ${alias}.workflow_state = 'wrapup' THEN 'Wrapup'
    WHEN ${alias}.agent_id IS NULL OR ${alias}.presence = 'offline' THEN 'Offline'
    ELSE COALESCE(${alias}.manual_status, 'Available')
  END`;
}

function isRoutable(state) {
  return state.presence === "online"
    && state.manual_status === "Available"
    && state.workflow_state === "idle";
}

// What an agent (and their supervisor) should see: the effective status plus
// the manual status that is waiting to apply once every current interaction
// ends. A pending status already stops new offers (router, capacity), so it
// must never stay hidden behind "Busy".
export function agentStatusPresentation(state) {
  const status = effectiveAgentStatus(state);
  const manual = state?.manual_status || null;
  const pending = BUSY_STATUSES.has(status) && manual && manual !== "Available" && manual !== status ? manual : null;
  return {
    status,
    version: state?.version == null ? null : String(state.version),
    pendingStatus: pending,
    pendingSince: pending ? iso(state.manual_status_set_at) : null,
  };
}

/** SQL equivalent of agentStatusPresentation().pendingStatus for list queries. */
export function pendingAgentStatusSql(alias = "ast") {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) {
    throw new Error("Invalid agent-state SQL alias");
  }
  return `CASE
    WHEN ${alias}.workflow_state IN ('handling', 'offered', 'wrapup')
      AND ${alias}.manual_status IS NOT NULL AND ${alias}.manual_status <> 'Available'
      AND ${alias}.manual_status <> CASE WHEN ${alias}.workflow_state = 'wrapup' THEN 'Wrapup' ELSE 'Busy' END
    THEN ${alias}.manual_status
  END`;
}

export async function readAgentStatusPresentation(db, agentId, fallback = "Offline") {
  if (!db || !agentId) return { status: fallback, pendingStatus: null, pendingSince: null };
  await ensureAgentState(db, agentId);
  const state = (
    await db.query("SELECT * FROM acd_agent_state WHERE agent_id = $1", [String(agentId)])
  ).rows[0];
  return state ? agentStatusPresentation(state) : { status: fallback, pendingStatus: null, pendingSince: null };
}

/** Persist one effective-status boundary in the Core-owned interval ledger. */
export async function closeAgentStatusInterval(
  db,
  {
    agentId,
    agentUsername = null,
    status,
    nextStatus,
    startedAt,
    endedAt,
    sourceEventId = null,
    workItemId = null,
    reason = null,
  } = {},
) {
  const start = iso(startedAt);
  const end = iso(endedAt);
  if (!db || !agentId || !status || !nextStatus || !start || !end) return null;
  if (status === nextStatus || new Date(end) < new Date(start)) return null;
  const idempotencyKey = intervalKey({
    agentId,
    status,
    nextStatus,
    startedAt: start,
    endedAt: end,
    sourceEventId,
  });
  const result = await db.query(
    `INSERT INTO cc_agent_status_intervals (
       id, idempotency_key, user_id, agent_username, status, status_type,
       next_status, started_at, ended_at, duration_seconds, source,
       source_event_id, work_item_id, reason, metadata,
       created_at
     )
     SELECT $1, $2, $3, $4, $5,
            COALESCE((SELECT type FROM cc_user_statuses WHERE name = $5 LIMIT 1), 'active'),
            $6, $7::timestamptz, $8::timestamptz,
            GREATEST(0, FLOOR(EXTRACT(EPOCH FROM ($8::timestamptz - $7::timestamptz))))::int,
            'acd_core', $9, $10, $11,
            jsonb_build_object('authority', 'acd_core'), now()
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [
      randomUUID(),
      idempotencyKey,
      String(agentId),
      agentUsername,
      status,
      nextStatus,
      start,
      end,
      sourceEventId == null ? null : String(sourceEventId),
      workItemId == null ? null : String(workItemId),
      reason,
    ],
  );
  return result.rows?.[0] || null;
}

async function persistAgentState(
  db,
  before,
  changes,
  { actor, reason = null, workItemId = null } = {},
) {
  const entries = Object.entries(changes).filter(([column]) => STATE_COLUMNS.has(column));
  if (entries.length === 0) return before;
  const transition = (await db.query("SELECT clock_timestamp() AS at")).rows[0].at;
  const assignments = entries.map(([column], index) => `${column} = $${index + 3}`);
  const updated = (
    await db.query(
      `UPDATE acd_agent_state
          SET ${assignments.join(", ")}, version = version + 1,
              updated_at = $2::timestamptz
        WHERE agent_id = $1
        RETURNING *`,
      [String(before.agent_id), transition, ...entries.map(([, value]) => value)],
    )
  ).rows[0];
  const previousStatus = effectiveAgentStatus(before);
  const nextStatus = effectiveAgentStatus(updated);
  if (previousStatus !== nextStatus) {
    const statusEvent = await appendEvent(db, {
      workItemId,
      agentId: before.agent_id,
      type: "agent_effective_status_changed",
      payload: {
        status: nextStatus,
        previous_status: previousStatus,
        reason,
        version: updated.version,
      },
      actor,
    });
    const identity = (
      await db.query("SELECT username FROM users WHERE id = $1", [String(before.agent_id)])
    ).rows[0];
    await closeAgentStatusInterval(db, {
      agentId: before.agent_id,
      agentUsername: identity?.username || null,
      status: previousStatus,
      nextStatus,
      startedAt: before.status_started_at || before.updated_at || transition,
      endedAt: transition,
      sourceEventId: statusEvent.eventId,
      workItemId,
      reason,
    });
    updated.status_started_at = transition;
    await db.query(
      "UPDATE acd_agent_state SET status_started_at = $2::timestamptz WHERE agent_id = $1",
      [String(before.agent_id), transition],
    );
  }
  return updated;
}

export async function setWorkflowState(db, agentId, workflowState, options = {}) {
  let {
    deadlineAt = null,
    actor = "saga",
    workItemId = null,
    reason = null,
    expectedVersion = null,
  } = options;
  if (!WORKFLOW_STATES.has(workflowState)) {
    throw new Error(`setWorkflowState: illegal state ${workflowState}`);
  }
  const before = (
    await db.query("SELECT * FROM acd_agent_state WHERE agent_id = $1 FOR UPDATE", [agentId])
  ).rows[0];
  if (!before) return false;
  if (expectedVersion != null && String(before.version) !== String(expectedVersion)) {
    throw Object.assign(new Error("Agent state changed; refresh and retry"), {
      status: 409,
      code: "ACD_VERSION_CONFLICT",
    });
  }
  if (workflowState === "wrapup" && workItemId && deadlineAt) {
    await db.query(
      `UPDATE acd_segments s SET wrapup_deadline_at = COALESCE(wrapup_deadline_at, $3)
        WHERE work_item_id = $1 AND agent_id = $2 AND kind = 'agent'
          AND ended_at IS NOT NULL AND wrapup_ended_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM acd_text_assignments a
            WHERE a.segment_id=s.id AND a.state<>'wrapup')`,
      [workItemId, agentId, deadlineAt],
    );
  }
  if (workflowState === "idle" || workflowState === "wrapup") {
    const live = (
      await db.query(
        `SELECT state, work_item_id, channel FROM acd_reservations r WHERE agent_id = $1
          AND state <> 'released'
          AND (state = 'active' OR owner_saga_id IS NOT NULL OR lease_expires_at > now())
          AND NOT EXISTS (SELECT 1 FROM acd_text_assignments a
            WHERE a.reservation_id = r.id AND a.state = 'wrapup')
          ORDER BY (channel = 'voice') DESC, (state = 'active') DESC, created_at LIMIT 1`,
        [agentId],
      )
    ).rows[0];
    const wrap = (
      await db.query(
        `SELECT work_item_id, wrapup_deadline_at FROM acd_segments s
          WHERE agent_id = $1 AND kind = 'agent' AND ended_at IS NOT NULL
            AND wrapup_ended_at IS NULL AND wrapup_deadline_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM acd_text_assignments a
              WHERE a.segment_id=s.id AND a.state<>'wrapup')
          ORDER BY wrapup_deadline_at, ended_at, id LIMIT 1`,
        [agentId],
      )
    ).rows[0];
    // Chat wrap-up keeps its utilization reservation until disposition, but
    // must take precedence over other text work in the global agent status.
    // A live voice call still owns its handling/offered workflow.
    if (wrap && live?.channel !== "voice") {
      workflowState = "wrapup";
      workItemId = wrap.work_item_id;
      deadlineAt = wrap.wrapup_deadline_at;
    } else if (live) {
      workflowState = live.state === "active" ? "handling" : "offered";
      workItemId = live.work_item_id;
      deadlineAt = null;
    } else if (wrap) {
      workflowState = "wrapup";
      workItemId = wrap.work_item_id;
      deadlineAt = wrap.wrapup_deadline_at;
    }
  }
  // `workflow_work_item_id` identifies the current workflow owner. Keep the
  // supplied work item on the audit event below, but never project a finished
  // assignment as current once the agent is genuinely idle.
  const workflowWorkItemId = workflowState === "idle" ? null : workItemId;
  const desired = {
    ...before,
    workflow_state: workflowState,
    workflow_deadline_at: deadlineAt,
    workflow_work_item_id: workflowWorkItemId,
  };
  const updated = await persistAgentState(
    db,
    before,
    {
      workflow_state: workflowState,
      workflow_deadline_at: deadlineAt,
      workflow_work_item_id: workflowWorkItemId,
      routability: isRoutable(desired) ? "routable" : "not_routable",
    },
    { actor, reason, workItemId },
  );
  await appendEvent(db, {
    workItemId,
    agentId,
    type: "agent_workflow_changed",
    payload: {
      workflow_state: workflowState,
      deadline_at: deadlineAt,
      routability: updated.routability,
      manual_status: updated.manual_status,
      status: effectiveAgentStatus(updated),
      reason,
      version: updated.version,
    },
    actor,
  });
  return true;
}

export async function setAgentPresence(
  db,
  agentId,
  presence,
  { actor = "session", reason = null } = {},
) {
  if (!PRESENCE_STATES.has(presence)) throw new Error(`Invalid agent presence ${presence}`);
  const before = (
    await db.query("SELECT * FROM acd_agent_state WHERE agent_id = $1 FOR UPDATE", [agentId])
  ).rows[0];
  if (!before) return null;
  if (before.presence === presence) return before;
  const desired = { ...before, presence };
  const updated = await persistAgentState(
    db,
    before,
    {
      presence,
      routability: isRoutable(desired) ? "routable" : "not_routable",
    },
    { actor, reason, workItemId: before.workflow_work_item_id },
  );
  await appendEvent(db, {
    workItemId: updated.workflow_work_item_id,
    agentId,
    type: "agent_presence_changed",
    payload: {
      presence,
      routability: updated.routability,
      status: effectiveAgentStatus(updated),
      reason,
      version: updated.version,
    },
    actor,
  });
  return updated;
}

export async function setAgentRoutability(
  db,
  agentId,
  routable,
  { actor = "saga", reason = null } = {},
) {
  const before = (
    await db.query("SELECT * FROM acd_agent_state WHERE agent_id = $1 FOR UPDATE", [agentId])
  ).rows[0];
  if (!before) return null;
  const manualStatus = !routable && reason === "no_answer" && before.manual_status === "Available"
    ? "Agent Not Answering"
    : before.manual_status;
  const desired = { ...before, manual_status: manualStatus };
  const allowed = routable && isRoutable(desired);
  const updated = await persistAgentState(
    db,
    before,
    {
      manual_status: manualStatus,
      routability: allowed ? "routable" : "not_routable",
    },
    { actor, reason, workItemId: before.workflow_work_item_id },
  );
  await appendEvent(db, {
    workItemId: updated.workflow_work_item_id,
    agentId,
    type: "agent_routability_changed",
    payload: {
      routable: allowed,
      reason,
      status: effectiveAgentStatus(updated),
      version: updated.version,
    },
    actor,
  });
  return updated;
}

/** Apply a system-owned manual status while preserving workflow authority. */
export async function setSystemAgentStatus(
  db,
  agentId,
  status,
  { actor = "system", reason = null, workItemId = null } = {},
) {
  const before = (
    await db.query("SELECT * FROM acd_agent_state WHERE agent_id = $1 FOR UPDATE", [agentId])
  ).rows[0];
  if (!before) return null;
  const configured = (
    await db.query(
      "SELECT id, name FROM cc_user_statuses WHERE name = $1 AND is_active = true LIMIT 1",
      [status],
    )
  ).rows[0];
  // Lifecycle compensation must never roll back because an older deployment
  // renamed or deactivated a seeded status. The admin API protects these rows,
  // while this fallback keeps already-drifted installations recoverable.
  const appliedStatus = configured?.name || status;
  const desired = { ...before, manual_status: appliedStatus };
  const updated = await persistAgentState(
    db,
    before,
    {
      manual_status: appliedStatus,
      status_id: configured?.id || null,
      routability: isRoutable(desired) ? "routable" : "not_routable",
    },
    { actor, reason, workItemId: workItemId || before.workflow_work_item_id },
  );
  await appendEvent(db, {
    workItemId: workItemId || updated.workflow_work_item_id,
    agentId,
    type: "agent_system_status_applied",
    payload: {
      manual_status: appliedStatus,
      status_configured: Boolean(configured),
      routability: updated.routability,
      reason,
      version: updated.version,
    },
    actor,
  });
  return updated;
}

export async function setManualAgentStatusInTransaction(
  db,
  { agentId, status, actor = "agent", expectedVersion = null },
) {
  await ensureAgentState(db, agentId);
  const before = (
    await db.query("SELECT * FROM acd_agent_state WHERE agent_id = $1 FOR UPDATE", [agentId])
  ).rows[0];
  const valid = await db.query(
    "SELECT id FROM cc_user_statuses WHERE name = $1 AND is_active = true",
    [status],
  );
  if (!valid.rowCount || ["Offline", "Wrapup", "On Outbound Call", "Agent Not Answering"].includes(status)) {
    throw Object.assign(new Error("Invalid manual status"), { status: 400 });
  }
  if (expectedVersion != null && String(before.version) !== String(expectedVersion)) {
    throw Object.assign(new Error("Agent state changed"), { status: 409 });
  }
  const desired = { ...before, manual_status: status };
  const updated = await persistAgentState(
    db,
    before,
    {
      manual_status: status,
      manual_status_set_at: new Date().toISOString(),
      status_id: valid.rows[0].id,
      routability: isRoutable(desired) ? "routable" : "not_routable",
    },
    { actor, reason: "manual_status", workItemId: before.workflow_work_item_id },
  );
  const presentation = agentStatusPresentation(updated);
  await appendEvent(db, {
    workItemId: updated.workflow_work_item_id,
    agentId,
    type: "agent_manual_status_changed",
    payload: {
      status,
      effective_status: presentation.status,
      pending: updated.workflow_state !== "idle",
      pending_status: presentation.pendingStatus,
      version: updated.version,
    },
    actor,
  });
  return updated;
}

export async function setManualAgentStatus(
  pool,
  { agentId, status, actor = "agent", expectedVersion = null },
) {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    const updated = await setManualAgentStatusInTransaction(tx, {
      agentId,
      status,
      actor,
      expectedVersion,
    });
    await tx.query("COMMIT");
    return effectiveAgentStatus(updated);
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}

export async function ensureAgentState(db, agentId) {
  await db.query(
    `INSERT INTO acd_agent_state (agent_id, status_id)
     VALUES ($1, (SELECT id FROM cc_user_statuses WHERE name = 'Available' LIMIT 1))
     ON CONFLICT (agent_id) DO NOTHING`,
    [agentId],
  );
}

export async function readEffectiveAgentStatus(db, agentId, fallback = "Offline") {
  if (!db || !agentId) return fallback;
  await ensureAgentState(db, agentId);
  const state = (
    await db.query("SELECT * FROM acd_agent_state WHERE agent_id = $1", [String(agentId)])
  ).rows[0];
  return state ? effectiveAgentStatus(state) : fallback;
}
