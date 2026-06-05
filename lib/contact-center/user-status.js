import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { broadcastToKey } from "@/lib/sse";
import { offerQueuedCallForAgent } from "@/lib/contact-center/queued-call-router";

async function persistAgentStatus({ userId, username, status }) {
  if (!userId || !status) return;

  const pool = getPostgresPool();
  if (!pool) {
    return;
  }

  const client = await pool.connect();
  let previousState = null;
  try {
    await client.query("BEGIN");
    const previousStateResult = await client.query(
      `SELECT agent_status, last_status_change
       FROM cc_agent_state
       WHERE user_id = $1
       FOR UPDATE`,
      [String(userId)],
    );
    previousState = previousStateResult.rows?.[0] || null;
    // Manage available_since for idle time tracking.
    // Rules:
    // 1. Preserve when transitioning TO break statuses, "Agent Not Answering", or "Offline".
    // 2. Preserve when transitioning FROM break statuses, "Agent Not Answering", or "Offline" TO "Available".
    // 3. Reset ONLY when transitioning from "Wrapup" to "Available" after handling a call.
    // 4. For all other transitions to "Available", preserve existing available_since or set it if null.
    // 5. Clear when leaving "Available" except to break statuses, "Agent Not Answering", or "Offline".
    await client.query(
      `INSERT INTO cc_agent_state (user_id, username, agent_status, last_status_change, last_activity, available_since)
       VALUES ($1, $2, $3, NOW(), NOW(), CASE WHEN $3 = 'Available' THEN NOW() ELSE NULL END)
       ON CONFLICT (user_id) DO UPDATE SET
         username = COALESCE(EXCLUDED.username, cc_agent_state.username),
         agent_status = EXCLUDED.agent_status,
         last_status_change = NOW(),
         last_activity = NOW(),
         available_since = CASE
           WHEN EXCLUDED.agent_status = 'Agent Not Answering'
             OR EXCLUDED.agent_status = 'Offline'
             OR EXISTS (SELECT 1 FROM cc_user_statuses WHERE name = EXCLUDED.agent_status AND type = 'break' AND is_active = true)
             THEN cc_agent_state.available_since
           WHEN EXCLUDED.agent_status = 'Available' AND cc_agent_state.agent_status = 'Wrapup' THEN NOW()
           WHEN EXCLUDED.agent_status = 'Available'
             AND (cc_agent_state.agent_status = 'Agent Not Answering'
               OR cc_agent_state.agent_status = 'Offline'
               OR EXISTS (SELECT 1 FROM cc_user_statuses WHERE name = cc_agent_state.agent_status AND type = 'break' AND is_active = true))
             THEN cc_agent_state.available_since
           WHEN EXCLUDED.agent_status = 'Available'
             AND cc_agent_state.agent_status != 'Available'
             THEN COALESCE(cc_agent_state.available_since, NOW())
           WHEN EXCLUDED.agent_status = 'Available' AND cc_agent_state.agent_status = 'Available' THEN cc_agent_state.available_since
           WHEN cc_agent_state.agent_status = 'Available'
             AND EXCLUDED.agent_status != 'Available'
             AND EXCLUDED.agent_status != 'Agent Not Answering'
             AND EXCLUDED.agent_status != 'Offline'
             AND NOT EXISTS (SELECT 1 FROM cc_user_statuses WHERE name = EXCLUDED.agent_status AND type = 'break' AND is_active = true)
             THEN NULL
           ELSE cc_agent_state.available_since
         END`,
      [String(userId), username || null, status],
    );
    await client.query("COMMIT");
    return {
      previousStatus: previousState?.agent_status || null,
      previousStatusChangedAt: previousState?.last_status_change || null,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function refreshAgentStatusReadModel({ userId, username, status }) {
  if (!userId || !status) return;
  try {
    const { updateAgentStatus } =
      await import("@/lib/contact-center/state-manager");
    await updateAgentStatus(String(userId), status, username);
  } catch (_) {}
}

async function reconcileAgentStatusStores({ userId, username, status }) {
  const transition = await persistAgentStatus({ userId, username, status });
  await refreshAgentStatusReadModel({ userId, username, status });
  return transition;
}

async function getPersistedAgentStatus(userId) {
  const pool = getPostgresPool();
  if (!pool || !userId) return null;
  const result = await pool.query(
    `SELECT agent_status
       FROM cc_agent_state
      WHERE user_id = $1`,
    [String(userId)],
  );
  return result.rows?.[0]?.agent_status || null;
}

export async function ensureAgentStatusState({
  userId,
  username,
  status = "Available",
  activeQueueIds,
}) {
  if (!userId) return;

  const pool = getPostgresPool();
  if (!pool) return;

  await pool.query(
    `INSERT INTO cc_agent_state (
       user_id,
       username,
       agent_status,
       active_queue_ids,
       last_status_change,
       last_activity,
       available_since
     )
     VALUES (
       $1,
       $2,
       $3,
       COALESCE($4::text[], ARRAY[]::TEXT[]),
       NOW(),
       NOW(),
       CASE WHEN $3 = 'Available' THEN NOW() ELSE NULL END
     )
     ON CONFLICT (user_id) DO UPDATE SET
       username = COALESCE(EXCLUDED.username, cc_agent_state.username),
       agent_status = COALESCE(cc_agent_state.agent_status, EXCLUDED.agent_status),
       active_queue_ids = COALESCE($4::text[], cc_agent_state.active_queue_ids),
       available_since = COALESCE(cc_agent_state.available_since, EXCLUDED.available_since),
       last_activity = NOW()`,
    [String(userId), username || null, status, activeQueueIds || null],
  );
}

export async function setUserStatus({
  userId,
  username,
  status,
  previousStatus,
}) {
  if (!userId || !status) return null;
  console.log("[UserStatus][RoutingDiagnostics] status request", {
    userId: String(userId),
    username,
    status,
    previousStatus: previousStatus || null,
    unchanged: Boolean(previousStatus && previousStatus === status),
    timestamp: new Date().toISOString(),
  });
  if (previousStatus && previousStatus === status) {
    if (status === "Available") {
      try {
        await reconcileAgentStatusStores({
          userId: String(userId),
          username,
          status,
        });
        console.log("[UserStatus] Offering queued call after unchanged Available status:", {
          userId: String(userId),
          username,
          status,
        });
        const offerResult = await offerQueuedCallForAgent({ userId: String(userId) });
        console.log("[UserStatus][RoutingDiagnostics] offerQueuedCallForAgent result", {
          userId: String(userId),
          username,
          status,
          unchanged: true,
          result: offerResult,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.error(
          "[UserStatus] Failed to offer queued calls after unchanged Available status:",
          error,
        );
      }
    }
    return (await getPersistedAgentStatus(String(userId))) || status;
  }

  // If agent is manually changing status from "Agent Not Answering", that's fine
  // The status change itself will override it
  // But if they're changing to Available/Busy, make sure we're not in "Agent Not Answering"
  if (
    previousStatus === "Agent Not Answering" &&
    ["Available", "Busy"].includes(status)
  ) {
    // Agent is manually changing status, which is allowed
    console.log(
      "[UserStatus] Agent manually changing status from 'Agent Not Answering' to",
      status,
    );
  }

  console.log("[UserStatus] Status change requested:", {
    userId: String(userId),
    username,
    previousStatus,
    status,
    timestamp: new Date().toISOString(),
  });

  const persistedTransition = await persistAgentStatus({
    userId: String(userId),
    username,
    status,
  });
  await refreshAgentStatusReadModel({ userId: String(userId), username, status });

  let persistedCurrentStatus = status;
  if (status === "Available") {
    try {
      console.log("[UserStatus] Offering queued call after status change:", {
        userId: String(userId),
        username,
        status,
      });
      const offerResult = await offerQueuedCallForAgent({ userId: String(userId) });
      console.log("[UserStatus][RoutingDiagnostics] offerQueuedCallForAgent result", {
        userId: String(userId),
        username,
        status,
        unchanged: false,
        result: offerResult,
        timestamp: new Date().toISOString(),
      });
      persistedCurrentStatus = await getPersistedAgentStatus(String(userId));
    } catch (error) {
      console.error(
        "[UserStatus] Failed to offer queued calls after status change:",
        error,
      );
    }
  }
  const broadcastStatus = persistedCurrentStatus || status;

  // Re-evaluate waiting reasons for queued calls in queues where this user is assigned
  // This updates the waiting reason display when agents become available/unavailable
  try {
    const { reEvaluateWaitingReasonsForUserQueues } =
      await import("./waiting-reason-re-evaluator.js");
    // Run asynchronously - don't wait for it to complete
    reEvaluateWaitingReasonsForUserQueues(String(userId)).catch((error) => {
      console.error("[UserStatus] Error re-evaluating waiting reasons:", error);
    });
  } catch (reEvalError) {
    // Log but don't fail the status update
    console.error(
      "[UserStatus] Failed to trigger waiting reason re-evaluation:",
      reEvalError,
    );
  }

  const pool = getPostgresPool();
  try {
    const supervisors = pool
      ? await pool.query(
          `SELECT id FROM users WHERE 'supervisor' = ANY(roles) OR 'admin' = ANY(roles) OR 'owner' = ANY(roles)`,
        )
      : null;
    for (const supervisor of supervisors?.rows || []) {
      await broadcastToKey(
        `monitor:${supervisor.id}`,
        {
          type: "status_changed",
          status: broadcastStatus,
          userId: String(userId),
          username,
          timestamp: new Date().toISOString(),
        },
        "status_changed",
      );
    }
  } catch (_) {}

  await broadcastToKey(
    `user:status:${userId}`,
    {
      type: "status_changed",
      status: broadcastStatus,
      userId: String(userId),
      username,
      timestamp: new Date().toISOString(),
    },
    "status_changed",
  );

  if (username) {
    await broadcastToKey(`contact-center:agent:${username}`, {
      type: "status_changed",
      status: broadcastStatus,
      previousStatus: previousStatus || null,
    });
  }

  try {
    const providedPreviousStatus =
      previousStatus && previousStatus !== "Unknown" ? previousStatus : null;
    const effectivePreviousStatus =
      providedPreviousStatus || persistedTransition?.previousStatus || null;
    const previousStatusStartedAt =
      persistedTransition?.previousStatusChangedAt || new Date().toISOString();
    const endedAt = new Date().toISOString();
    const durationSeconds = effectivePreviousStatus
      ? Math.max(
          0,
          Math.floor((new Date(endedAt) - new Date(previousStatusStartedAt)) / 1000),
        )
      : 0;

    if (username) {
      await PgDb.insertAgentStatusHistory({
        agentUsername: username,
        status,
        previousStatus: effectivePreviousStatus,
        durationSeconds,
      });
    }

    await PgDb.logUserActivity({
      userId: String(userId),
      activityType: "status_change",
      activityValue: effectivePreviousStatus || status,
      previousValue: status,
      startedAt: previousStatusStartedAt,
      endedAt,
      durationSeconds,
    });
  } catch (_) {}

  return broadcastStatus;
}
