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

  let resolvedUsername = username || null;
  let previousStatus = null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const identityResult = await client.query(
      `SELECT id, username, agent_status
         FROM users
        WHERE id = $1
        FOR UPDATE`,
      [String(userId)],
    );
    const identity = identityResult.rows?.[0] || null;
    if (!identity) {
      await client.query("ROLLBACK");
      return { changed: false, reason: "agent_not_found" };
    }

    resolvedUsername = username || identity.username || null;
    previousStatus = identity.agent_status || null;

    await client.query(
      `UPDATE users
          SET agent_status = 'Busy', status = 'Busy', updated_at = NOW()
        WHERE id = $1`,
      [String(userId)],
    );

    await client.query(
      `INSERT INTO cc_agent_state (
          user_id, username, agent_status, current_calls_count,
          last_status_change, last_activity, available_since
        ) VALUES ($1, $2, 'Busy', 1, NOW(), NOW(), NULL)
        ON CONFLICT (user_id) DO UPDATE SET
          username = COALESCE(EXCLUDED.username, cc_agent_state.username),
          agent_status = EXCLUDED.agent_status,
          current_calls_count = GREATEST(cc_agent_state.current_calls_count, 1),
          last_status_change = NOW(),
          last_activity = NOW(),
          available_since = NULL`,
      [String(userId), resolvedUsername],
    );

    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }

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
