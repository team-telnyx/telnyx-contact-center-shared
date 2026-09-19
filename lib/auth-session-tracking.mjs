import { randomUUID } from "node:crypto";

import { getPostgresPool } from "./postgres.mjs";

function normalizedEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email || null;
}

export async function resolveTrackedAuthUser(
  { userId = null, email = null } = {},
  { pool = getPostgresPool() } = {},
) {
  if (!pool || (!userId && !email)) return null;
  const result = await pool.query(
    `SELECT *
       FROM users
      WHERE ($1::text IS NOT NULL AND id::text = $1::text)
         OR ($2::text IS NOT NULL AND lower(username) = $2::text)
      ORDER BY CASE WHEN id::text = $1::text THEN 0 ELSE 1 END
      LIMIT 1`,
    [userId == null ? null : String(userId), normalizedEmail(email)],
  );
  return result.rows?.[0] || null;
}

export async function openTrackedAuthSession(
  {
    userId = null,
    email = null,
    sessionToken = null,
    source = "nextauth",
    loginAt = null,
  } = {},
  { pool = getPostgresPool() } = {},
) {
  if (!pool) return { opened: false, reason: "database_unavailable" };
  const user = await resolveTrackedAuthUser({ userId, email }, { pool });
  if (!user?.id) return { opened: false, reason: "user_not_found" };

  const trackingToken = sessionToken || randomUUID();
  const sessionId = randomUUID();
  const activityId = randomUUID();
  const startedAt = loginAt || new Date().toISOString();
  const client = await pool.connect();
  let opened = false;
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO cc_user_sessions (
         id, user_id, session_token, login_at, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (session_token) WHERE session_token IS NOT NULL DO NOTHING
       RETURNING id`,
      [sessionId, String(user.id), trackingToken, startedAt],
    );
    opened = (inserted.rowCount || 0) > 0;
    if (opened) {
      await client.query(
        `INSERT INTO cc_user_activity_log (
           id, user_id, activity_type, activity_value, metadata,
           started_at, created_at
         ) VALUES ($1, $2, 'login', 'session_created', $3::jsonb, $4, NOW())`,
        [
          activityId,
          String(user.id),
          JSON.stringify({ source, session_id: sessionId }),
          startedAt,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return {
    opened,
    user,
    sessionId: opened ? sessionId : null,
    sessionToken: trackingToken,
  };
}

export async function closeTrackedAuthSession(
  {
    userId = null,
    email = null,
    sessionToken = null,
    source = "nextauth",
    logoutAt = null,
  } = {},
  { pool = getPostgresPool() } = {},
) {
  if (!pool) return { closed: false, reason: "database_unavailable" };
  const user = await resolveTrackedAuthUser({ userId, email }, { pool });
  if (!user?.id) return { closed: false, reason: "user_not_found" };

  const endedAt = logoutAt || new Date().toISOString();
  const client = await pool.connect();
  let closedSession = null;
  let durationSeconds = 0;
  try {
    await client.query("BEGIN");
    const openSession = await client.query(
      `SELECT id, login_at, session_token
        FROM cc_user_sessions
        WHERE user_id = $1
          AND logout_at IS NULL
          AND ($2::text IS NULL OR session_token = $2::text)
        ORDER BY
          CASE WHEN $2::text IS NOT NULL AND session_token = $2::text THEN 0 ELSE 1 END,
          login_at DESC
        LIMIT 1
        FOR UPDATE`,
      [String(user.id), sessionToken || null],
    );
    closedSession = openSession.rows?.[0] || null;
    if (closedSession) {
      durationSeconds = closedSession.login_at
        ? Math.max(
            0,
            Math.floor(
              (new Date(endedAt).getTime() -
                new Date(closedSession.login_at).getTime()) /
                1000,
            ),
          )
        : 0;
      const updated = await client.query(
        `UPDATE cc_user_sessions
            SET logout_at = $2,
                duration_seconds = $3,
                updated_at = NOW()
          WHERE id = $1 AND logout_at IS NULL
          RETURNING id`,
        [closedSession.id, endedAt, durationSeconds],
      );
      if ((updated.rowCount || 0) > 0) {
        await client.query(
          `INSERT INTO cc_user_activity_log (
             id, user_id, activity_type, activity_value, metadata,
             started_at, ended_at, duration_seconds, created_at
           ) VALUES ($1, $2, 'logout', 'session_closed', $3::jsonb, $4, $5, $6, NOW())`,
          [
            randomUUID(),
            String(user.id),
            JSON.stringify({ source, session_id: closedSession.id }),
            closedSession.login_at || endedAt,
            endedAt,
            durationSeconds,
          ],
        );
      } else {
        closedSession = null;
      }
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  return {
    closed: Boolean(closedSession),
    user,
    sessionId: closedSession?.id || null,
    durationSeconds,
  };
}

export async function completeTrackedLogout(
  params = {},
  options = {},
) {
  const pool = options.pool || getPostgresPool();
  if (!pool) return { closed: false, reason: "database_unavailable" };
  const user = await resolveTrackedAuthUser(params, { pool });
  if (!user?.id) return { closed: false, reason: "user_not_found" };

  let trackingResult;
  let trackingError = null;
  try {
    trackingResult = await closeTrackedAuthSession(
      { ...params, userId: String(user.id), email: user.username },
      { ...options, pool },
    );
  } catch (error) {
    trackingError = error;
    trackingResult = { closed: false, reason: "tracking_failed", user };
  }

  // Authentication lifecycle does not author routing presence. The WebRTC
  // client explicitly ends or expires its acd_agent_sessions heartbeat.

  if (trackingError) throw trackingError;
  return { ...trackingResult, user };
}
