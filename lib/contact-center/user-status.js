import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { broadcastToKey } from "@/lib/sse";
import { offerQueuedCallForAgent } from "@/lib/contact-center/queued-call-router";

export async function setUserStatus({
  userId,
  username,
  status,
  previousStatus,
}) {
  if (!userId || !status) return;
  if (previousStatus && previousStatus === status) return;

  console.log("[UserStatus] Status change requested:", {
    userId: String(userId),
    username,
    previousStatus,
    status,
    timestamp: new Date().toISOString(),
  });

  await PgDb.updateUserById(String(userId), { status });

  const pool = getPostgresPool();
  if (pool) {
    await pool.query(
      `UPDATE users SET agent_status = $1, updated_at = NOW() WHERE id = $2`,
      [status, String(userId)]
    );
    await pool.query(
      `INSERT INTO cc_agent_state (user_id, username, agent_status, last_status_change, last_activity)
       VALUES ($1, $2, $3, NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         agent_status = EXCLUDED.agent_status,
         last_status_change = NOW(),
         last_activity = NOW()`,
      [String(userId), username || null, status]
    );
  }

  try {
    const { updateAgentStatus } = await import(
      "@/lib/contact-center/state-manager"
    );
    updateAgentStatus(String(userId), status, username);
  } catch (_) {}

  if (["Available", "Busy"].includes(status)) {
    try {
      console.log("[UserStatus] Offering queued call after status change:", {
        userId: String(userId),
        username,
        status,
      });
      await offerQueuedCallForAgent({ userId: String(userId) });
    } catch (error) {
      console.error(
        "[UserStatus] Failed to offer queued calls after status change:",
        error
      );
    }
  }

  try {
    const supervisors = pool
      ? await pool.query(
          `SELECT id FROM users WHERE 'supervisor' = ANY(roles) OR 'admin' = ANY(roles) OR 'owner' = ANY(roles)`
        )
      : null;
    for (const supervisor of supervisors?.rows || []) {
      await broadcastToKey(
        `monitor:${supervisor.id}`,
        {
          type: "status_changed",
          status,
          userId: String(userId),
          username,
          timestamp: new Date().toISOString(),
        },
        "status_changed"
      );
    }
  } catch (_) {}

  await broadcastToKey(
    `user:status:${userId}`,
    {
      type: "status_changed",
      status,
      userId: String(userId),
      username,
      timestamp: new Date().toISOString(),
    },
    "status_changed"
  );

  if (username) {
    await broadcastToKey(`contact-center:agent:${username}`, {
      type: "status_changed",
      status,
      previousStatus: previousStatus || null,
    });
  }

  try {
    const lastStatusActivity = await PgDb.getUserActivityLog(String(userId), {
      activityType: "status_change",
      pageSize: 1,
    });

    let previousActivityStartedAt = null;
    if (lastStatusActivity.rows.length > 0) {
      const lastActivity = lastStatusActivity.rows[0];
      if (
        lastActivity.activity_value === previousStatus &&
        lastActivity.started_at
      ) {
        previousActivityStartedAt = lastActivity.started_at;
      }
    }

    await PgDb.logUserActivity({
      userId: String(userId),
      activityType: "status_change",
      activityValue: status,
      previousValue: previousStatus,
      startedAt: previousActivityStartedAt || new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
  } catch (_) {}
}

