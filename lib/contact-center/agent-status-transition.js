import { getPostgresPool } from "@/lib/postgres.mjs";
import { broadcastToKey } from "@/lib/sse";

async function getAgentIdentity(userId, pool) {
  const result = await pool.query(
    `SELECT id, username, agent_status FROM users WHERE id = $1`,
    [String(userId)],
  );
  return result.rows?.[0] || null;
}

async function broadcastAgentStatusChanged({ userId, username, status, previousStatus }) {
  const timestamp = new Date().toISOString();

  try {
    const pool = getPostgresPool();
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
          status,
          previousStatus: previousStatus || null,
          userId: String(userId),
          username,
          timestamp,
        },
        "status_changed",
      );
    }
  } catch (error) {
    console.error("[AgentStatusTransition] Failed to broadcast supervisor status change:", error);
  }

  try {
    await broadcastToKey(
      `user:status:${userId}`,
      {
        type: "status_changed",
        status,
        previousStatus: previousStatus || null,
        userId: String(userId),
        username,
        timestamp,
      },
      "status_changed",
    );
  } catch (error) {
    console.error("[AgentStatusTransition] Failed to broadcast user status change:", error);
  }

  if (username) {
    try {
      await broadcastToKey(`contact-center:agent:${username}`, {
        type: "status_changed",
        status,
        previousStatus: previousStatus || null,
        userId: String(userId),
        username,
        timestamp,
      });
    } catch (error) {
      console.error("[AgentStatusTransition] Failed to broadcast agent stream status change:", error);
    }
  }
}

async function updateStateManagerStatus(userId, status, username) {
  try {
    const { updateAgentStatus } = await import("./state-manager.js");
    await updateAgentStatus(String(userId), status, username);
  } catch (error) {
    console.error("[AgentStatusTransition] Failed to update in-memory agent status:", error);
  }
}

export async function markAgentBusyForRinging({ userId, username = null } = {}) {
  if (!userId) return { changed: false, reason: "missing_user_id" };

  const pool = getPostgresPool();
  if (!pool) return { changed: false, reason: "database_unavailable" };

  const identity = await getAgentIdentity(userId, pool);
  if (!identity) return { changed: false, reason: "agent_not_found" };

  const resolvedUsername = username || identity.username || null;
  const previousStatus = identity.agent_status || null;

  if (previousStatus !== "Available") {
    return {
      changed: false,
      reason: "agent_not_available",
      previousStatus,
      username: resolvedUsername,
    };
  }

  await pool.query(
    `UPDATE users
        SET agent_status = 'Busy', status = 'Busy', updated_at = NOW()
      WHERE id = $1
        AND agent_status = 'Available'`,
    [String(userId)],
  );

  await pool.query(
    `UPDATE cc_agent_state
        SET agent_status = 'Busy',
            current_calls_count = GREATEST(current_calls_count, 1),
            last_status_change = NOW(),
            last_activity = NOW(),
            available_since = NULL
      WHERE user_id = $1
        AND agent_status = 'Available'`,
    [String(userId)],
  );

  await updateStateManagerStatus(String(userId), "Busy", resolvedUsername);
  await broadcastAgentStatusChanged({
    userId: String(userId),
    username: resolvedUsername,
    status: "Busy",
    previousStatus,
  });

  console.log("[AgentStatusTransition][RoutingDiagnostics] agent marked Busy for ringing", {
    userId: String(userId),
    username: resolvedUsername,
    previousStatus,
    timestamp: new Date().toISOString(),
  });

  return { changed: true, status: "Busy", previousStatus, username: resolvedUsername };
}

export async function restoreAgentAvailableAfterFailedRinging({ userId, username = null } = {}) {
  if (!userId) return { changed: false, reason: "missing_user_id" };

  const pool = getPostgresPool();
  if (!pool) return { changed: false, reason: "database_unavailable" };

  const identity = await getAgentIdentity(userId, pool);
  if (!identity) return { changed: false, reason: "agent_not_found" };

  const resolvedUsername = username || identity.username || null;
  const previousStatus = identity.agent_status || null;

  if (previousStatus !== "Busy") {
    return {
      changed: false,
      reason: "agent_not_busy",
      previousStatus,
      username: resolvedUsername,
    };
  }

  const activeCount = await pool.query(
    `SELECT COUNT(*)::int AS active_calls
       FROM cc_agent_reservations
      WHERE agent_id = $1
        AND state IN ('reserved', 'ringing', 'active')
        AND (
          state = 'active'
          OR (state IN ('reserved', 'ringing') AND lease_expires_at > now())
        )`,
    [String(userId)],
  );
  const activeCalls = Number(activeCount.rows?.[0]?.active_calls || 0);
  if (activeCalls > 0) {
    return {
      changed: false,
      reason: "agent_still_has_active_calls",
      activeCalls,
      username: resolvedUsername,
    };
  }

  await pool.query(
    `UPDATE users
        SET agent_status = 'Available', status = 'Available', updated_at = NOW()
      WHERE id = $1
        AND agent_status = 'Busy'`,
    [String(userId)],
  );

  await pool.query(
    `UPDATE cc_agent_state
        SET agent_status = 'Available',
            current_calls_count = 0,
            last_status_change = NOW(),
            last_activity = NOW(),
            available_since = COALESCE(available_since, NOW())
      WHERE user_id = $1
        AND agent_status = 'Busy'`,
    [String(userId)],
  );

  await updateStateManagerStatus(String(userId), "Available", resolvedUsername);
  await broadcastAgentStatusChanged({
    userId: String(userId),
    username: resolvedUsername,
    status: "Available",
    previousStatus,
  });

  console.log("[AgentStatusTransition][RoutingDiagnostics] restored agent Available after failed ringing", {
    userId: String(userId),
    username: resolvedUsername,
    previousStatus,
    timestamp: new Date().toISOString(),
  });

  return { changed: true, status: "Available", previousStatus, username: resolvedUsername };
}
