import { randomUUID } from "node:crypto";
import { getPostgresPool } from "../postgres.mjs";

const globalAny = globalThis;
const NODE_ID = (globalAny.__cc_presence_node_id ||= `${process.env.HOSTNAME || "node"}-${process.pid || "pid"}-${Date.now()}`);
const DEFAULT_TTL_MS = 45_000;

export function isGlobalPresenceEnabled() {
  return String(process.env.GLOBAL_PRESENCE || "false").toLowerCase() === "true";
}

function ttlMs() {
  const configured = Number(process.env.GLOBAL_PRESENCE_TTL_MS || DEFAULT_TTL_MS);
  return Number.isFinite(configured) && configured >= 10_000 ? configured : DEFAULT_TTL_MS;
}

function ttlInterval() {
  return `${Math.ceil(ttlMs() / 1000)} seconds`;
}

async function fallbackHasActiveClients(fallbackKey) {
  if (!fallbackKey) return false;
  try {
    const { hasActiveClients } = await import("../sse.js");
    return hasActiveClients(fallbackKey);
  } catch {
    return false;
  }
}

export async function registerSessionPresence({ userId, username, connectionId = randomUUID() } = {}) {
  if (!isGlobalPresenceEnabled() || !userId) return { enabled: false, connectionId };
  const pool = getPostgresPool();
  if (!pool) return { enabled: false, connectionId };

  await pool.query(
    `INSERT INTO cc_session_presence (connection_id, user_id, username, node_id, last_seen, expires_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW() + $5::interval)
     ON CONFLICT (connection_id) DO UPDATE SET
       user_id = EXCLUDED.user_id,
       username = COALESCE(EXCLUDED.username, cc_session_presence.username),
       node_id = EXCLUDED.node_id,
       last_seen = NOW(),
       expires_at = NOW() + $5::interval`,
    [connectionId, String(userId), username || null, NODE_ID, ttlInterval()],
  );
  return { enabled: true, connectionId };
}

export async function touchSessionPresence({ userId, connectionId } = {}) {
  if (!isGlobalPresenceEnabled() || !userId || !connectionId) return false;
  const pool = getPostgresPool();
  if (!pool) return false;
  await pool.query(
    `UPDATE cc_session_presence
        SET last_seen = NOW(), expires_at = NOW() + $3::interval
      WHERE user_id = $1 AND connection_id = $2`,
    [String(userId), connectionId, ttlInterval()],
  );
  return true;
}

export async function removeSessionPresence({ userId, connectionId } = {}) {
  if (!isGlobalPresenceEnabled() || !userId || !connectionId) return false;
  const pool = getPostgresPool();
  if (!pool) return false;
  await pool.query(
    `DELETE FROM cc_session_presence
      WHERE user_id = $1 AND connection_id = $2`,
    [String(userId), connectionId],
  );
  return true;
}

export async function hasActiveSessionPresence({ userId, fallbackKey } = {}) {
  if (!isGlobalPresenceEnabled() || !userId) {
    return fallbackHasActiveClients(fallbackKey);
  }
  const pool = getPostgresPool();
  if (!pool) return fallbackHasActiveClients(fallbackKey);

  try {
    const result = await pool.query(
      `SELECT 1
         FROM cc_session_presence
        WHERE user_id = $1
          AND expires_at > NOW()
        LIMIT 1`,
      [String(userId)],
    );
    return (result.rowCount || 0) > 0;
  } catch {
    return fallbackHasActiveClients(fallbackKey);
  }
}

async function markAgentOfflineForExpiredSession({ userId, username, previousStatus }) {
  const pool = getPostgresPool();
  if (!pool || !userId) return false;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const previousStateResult = await client.query(
      `SELECT agent_status, last_status_change
         FROM cc_agent_state
        WHERE user_id = $1
        FOR UPDATE`,
      [String(userId)],
    );
    const previousState = previousStateResult.rows?.[0] || null;
    if (previousState?.agent_status === "Offline") {
      await client.query("COMMIT");
      return false;
    }

    const previousStatusStartedAt = previousState?.last_status_change || new Date();
    const effectivePreviousStatus = previousState?.agent_status || previousStatus || null;
    const durationSeconds = effectivePreviousStatus
      ? Math.max(
          0,
          Math.floor((Date.now() - new Date(previousStatusStartedAt).getTime()) / 1000),
        )
      : 0;

    await client.query(
      `INSERT INTO cc_agent_state (user_id, username, agent_status, last_status_change, last_activity)
       VALUES ($1, $2, 'Offline', NOW(), NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         username = COALESCE(EXCLUDED.username, cc_agent_state.username),
         agent_status = 'Offline',
         last_status_change = NOW(),
         last_activity = NOW(),
         available_since = cc_agent_state.available_since`,
      [String(userId), username || null],
    );

    if (username) {
      await client.query(
        `INSERT INTO cc_agent_status_history (id, agent_username, status, previous_status, duration_seconds, created_at)
         VALUES ($1, $2, 'Offline', $3, $4, NOW())`,
        [randomUUID(), username, effectivePreviousStatus, durationSeconds],
      );
    }

    await client.query(
      `INSERT INTO cc_user_activity_log (
         id, user_id, activity_type, activity_value, previous_value,
         metadata, started_at, ended_at, duration_seconds, created_at
       ) VALUES ($1, $2, 'status_change', $3, 'Offline', $4, $5, NOW(), $6, NOW())`,
      [
        randomUUID(),
        String(userId),
        effectivePreviousStatus || "Offline",
        JSON.stringify({ source: "global_presence_sweep" }),
        previousStatusStartedAt,
        durationSeconds,
      ],
    );

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function sweepExpiredSessionPresence() {
  if (!isGlobalPresenceEnabled()) return { enabled: false, offlineCount: 0, deletedCount: 0 };
  const pool = getPostgresPool();
  if (!pool) return { enabled: false, offlineCount: 0, deletedCount: 0 };

  const expiredUsersResult = await pool.query(
    `SELECT DISTINCT sp.user_id, COALESCE(sp.username, u.username, ast.username) AS username, ast.agent_status
       FROM cc_session_presence sp
       LEFT JOIN users u ON u.id::text = sp.user_id::text
       LEFT JOIN cc_agent_state ast ON ast.user_id::text = sp.user_id::text
      WHERE sp.expires_at <= NOW()
        AND NOT EXISTS (
          SELECT 1
            FROM cc_session_presence active_sp
           WHERE active_sp.user_id = sp.user_id
             AND active_sp.expires_at > NOW()
        )
        AND COALESCE(ast.agent_status, '') <> 'Offline'`,
  );

  let offlineCount = 0;
  for (const row of expiredUsersResult.rows || []) {
    const markedOffline = await markAgentOfflineForExpiredSession({
      userId: String(row.user_id),
      username: row.username || undefined,
      previousStatus: row.agent_status || null,
    });
    if (markedOffline) {
      offlineCount += 1;
    }
  }

  const deleteResult = await pool.query(
    `DELETE FROM cc_session_presence
      WHERE expires_at <= NOW()`,
  );

  return {
    enabled: true,
    offlineCount,
    deletedCount: deleteResult.rowCount || 0,
  };
}
