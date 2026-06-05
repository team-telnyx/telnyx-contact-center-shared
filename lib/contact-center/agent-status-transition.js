import { getPostgresPool } from "@/lib/postgres.mjs";
import { broadcastToKey } from "@/lib/sse";

async function getAgentIdentity(userId, pool) {
  const result = await pool.query(
    `SELECT u.id, u.username, s.agent_status
       FROM users u
       LEFT JOIN cc_agent_state s ON s.user_id = u.id
      WHERE u.id = $1`,
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
  } catch (_) {}

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
  } catch (_) {}

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
    } catch (_) {}
  }
}

async function updateStateManagerStatus(userId, status, username) {
  try {
    const { updateAgentStatus } = await import("./state-manager.js");
    await updateAgentStatus(String(userId), status, username);
  } catch (_) {}
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
      `SELECT u.id, u.username, s.agent_status
         FROM users u
         LEFT JOIN cc_agent_state s ON s.user_id = u.id
        WHERE u.id = $1
        FOR UPDATE OF u`,
      [String(userId)],
    );
    const identity = identityResult.rows?.[0] || null;
    if (!identity) {
      await client.query("ROLLBACK");
      return { changed: false, reason: "agent_not_found" };
    }

    resolvedUsername = username || identity.username || null;
    previousStatus = identity.agent_status || null;

    const liveWorkResult = await client.query(
      `SELECT COUNT(*)::int AS live_count
         FROM (
           SELECT COALESCE(r.interaction_id, r.id) AS live_id
             FROM cc_agent_reservations r
            WHERE r.agent_id = $1
              AND r.state IN ('reserved', 'ringing', 'active')
              AND (
                r.state = 'active'
                OR (r.state IN ('reserved', 'ringing') AND r.lease_expires_at > now())
              )
           UNION
           SELECT i.id
             FROM cc_interactions i
            WHERE i.agent_username = $2
              AND i.state IN ('ringing', 'answered', 'connected', 'active')
              AND i.completed_at IS NULL
              AND i.abandoned_at IS NULL
              AND i.assigned_at IS NOT NULL
              AND COALESCE(i.metadata->>'timeout_re_enqueued', 'false') <> 'true'
         ) live_work`,
      [String(userId), resolvedUsername],
    );
    const liveCount = Number(liveWorkResult.rows?.[0]?.live_count || 0);

    if (liveCount <= 0) {
      await client.query("ROLLBACK");
      return {
        changed: false,
        reason: "no_live_ringing_evidence",
        previousStatus,
        username: resolvedUsername,
      };
    }

    await client.query(
      `INSERT INTO cc_agent_state (
          user_id, username, agent_status, current_calls_count,
          last_status_change, last_activity, available_since
        ) VALUES ($1, $2, 'Busy', $3, NOW(), NOW(), NULL)
        ON CONFLICT (user_id) DO UPDATE SET
          username = COALESCE(EXCLUDED.username, cc_agent_state.username),
          agent_status = EXCLUDED.agent_status,
          current_calls_count = EXCLUDED.current_calls_count,
          last_status_change = NOW(),
          last_activity = NOW(),
          available_since = NULL`,
      [String(userId), resolvedUsername, liveCount],
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



  return { changed: true, status: "Busy", previousStatus, username: resolvedUsername };
}
