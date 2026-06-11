import { randomUUID } from "node:crypto";

import { getPostgresPool } from "../postgres.mjs";
import { agentPayload, contactCenterErrorPayload, reservationLogger } from "./logging.mjs";

const ACTIVE_STATES = ["reserved", "ringing", "active"];
const DEFAULT_LEASE_MS = 30_000;

// WS3: cross-node capacity signal on release (inert unless
// ROUTING_EVENT_DRIVEN=true). Fire-and-forget; never affects the release txn.
function signalAgentsAvailable(agentIds, reason) {
  if (!Array.isArray(agentIds) || agentIds.length === 0) return;
  import("./routing-events.js")
    .then(({ publishAgentAvailable }) => {
      for (const agentId of agentIds) {
        publishAgentAvailable(String(agentId), reason);
      }
    })
    .catch(() => {});
}

function resolvePool(pool) {
  const resolved = pool || getPostgresPool();
  if (!resolved) {
    throw new Error("Postgres pool is not available");
  }
  return resolved;
}

function isConnectedPgClient(value) {
  return Boolean(
    value &&
      typeof value.query === "function" &&
      (typeof value.release === "function" ||
        value.constructor?.name === "Client"),
  );
}

async function withClient(poolOrClient, fn) {
  if (isConnectedPgClient(poolOrClient)) {
    return fn(poolOrClient);
  }

  const pool = resolvePool(poolOrClient);
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release?.();
  }
}

export async function reserveAgent(agentId, opts = {}) {
  if (!agentId) return null;

  const {
    pool,
    client,
    id = randomUUID(),
    channel = "inbound",
    interactionId = null,
    attemptId = null,
    queueId = null,
    campaignId = null,
    leaseMs = DEFAULT_LEASE_MS,
  } = opts;

  return withClient(client || pool, async (db) => {
    const manageTransaction = !client;

    try {
      if (manageTransaction) {
        await db.query("BEGIN");
      }

      const lockedAgentResult = await db.query(
        `SELECT u.id, u.max_concurrent_calls
           FROM users u
           JOIN cc_agent_state s ON s.user_id = u.id
          WHERE u.id = $1
            AND s.agent_status = 'Available'
            AND s.is_available_for_routing = true
          FOR UPDATE OF u`,
        [agentId],
      );

      const lockedAgent = lockedAgentResult.rows?.[0];
      if (!lockedAgent) {
        if (manageTransaction) {
          await db.query("COMMIT");
        }
        return null;
      }

      const result = await db.query(
        `INSERT INTO cc_agent_reservations
          (id, agent_id, channel, interaction_id, attempt_id, queue_id, campaign_id, state, reserved_at, lease_expires_at)
         SELECT $1, $2, $3, $4, $5, $6, $7, 'reserved', now(), now() + ($8::text || ' milliseconds')::interval
         WHERE (
             SELECT COUNT(*)
             FROM cc_agent_reservations r
             WHERE r.agent_id = $2
               AND r.state IN ('reserved', 'ringing', 'active')
               AND (
                 r.state = 'active'
                 OR (r.state IN ('reserved', 'ringing') AND r.lease_expires_at > now())
               )
           ) < $9
         RETURNING id`,
        [
          id,
          lockedAgent.id,
          channel,
          interactionId,
          attemptId,
          queueId,
          campaignId,
          leaseMs,
          Number(lockedAgent.max_concurrent_calls ?? 1),
        ],
      );

      const reservationId = result.rows?.[0]?.id || null;
      if (!reservationId) {
        if (manageTransaction) {
          await db.query("COMMIT");
        }
        return null;
      }

      await refreshAgentReservationCount(agentId, { client: db });

      if (manageTransaction) {
        await db.query("COMMIT");
      }
      return reservationId;
    } catch (error) {
      if (manageTransaction) {
        await db.query("ROLLBACK");
      }
      throw error;
    }
  });
}

export async function promoteReservation(id, state, opts = {}) {
  if (!id || !ACTIVE_STATES.includes(state)) return false;
  const { pool, client, leaseMs = DEFAULT_LEASE_MS } = opts;

  return withClient(client || pool, async (db) => {
    const result = await db.query(
      `UPDATE cc_agent_reservations
          SET state = $2,
              lease_expires_at = now() + ($3::text || ' milliseconds')::interval
        WHERE id = $1
          AND state IN ('reserved', 'ringing')
        RETURNING agent_id`,
      [id, state, leaseMs],
    );
    const agentId = result.rows?.[0]?.agent_id;
    if (agentId) {
      await refreshAgentReservationCount(agentId, { client: db });
    }
    return Boolean(agentId);
  });
}

export async function releaseReservation(id, opts = {}) {
  if (!id) return [];
  const { pool, client } = opts;

  return withClient(client || pool, async (db) => {
    const result = await db.query(
      `UPDATE cc_agent_reservations
          SET state = 'released', released_at = now()
        WHERE id = $1
          AND state <> 'released'
        RETURNING agent_id`,
      [id],
    );
    const agentIds = result.rows.map((row) => row.agent_id).filter(Boolean);
    for (const agentId of agentIds) {
      await refreshAgentReservationCount(agentId, { client: db });
    }
    signalAgentsAvailable(agentIds, "reservation_released");
    return agentIds;
  });
}

export async function releaseByInteraction(interactionId, opts = {}) {
  return releaseByColumn("interaction_id", interactionId, opts);
}

export async function releaseByAttempt(attemptId, opts = {}) {
  return releaseByColumn("attempt_id", attemptId, opts);
}

async function releaseByColumn(column, value, opts = {}) {
  if (!value) return [];
  const { pool, client } = opts;

  return withClient(client || pool, async (db) => {
    const result = await db.query(
      `UPDATE cc_agent_reservations
          SET state = 'released', released_at = now()
        WHERE ${column} = $1
          AND state <> 'released'
        RETURNING agent_id`,
      [value],
    );
    const agentIds = [...new Set(result.rows.map((row) => row.agent_id).filter(Boolean))];
    for (const agentId of agentIds) {
      await refreshAgentReservationCount(agentId, { client: db });
    }
    signalAgentsAvailable(agentIds, "reservation_released");
    return agentIds;
  });
}

export async function countActiveReservations(agentId, opts = {}) {
  if (!agentId) return 0;
  const { pool, client } = opts;

  return withClient(client || pool, async (db) => {
    const result = await db.query(
      `SELECT COUNT(*)::int AS count
         FROM cc_agent_reservations
        WHERE agent_id = $1
          AND state IN ('reserved', 'ringing', 'active')
          AND (
            state = 'active'
            OR (state IN ('reserved', 'ringing') AND lease_expires_at > now())
          )`,
      [agentId],
    );
    return Number(result.rows?.[0]?.count || 0);
  });
}

export async function refreshAgentReservationCount(agentId, opts = {}) {
  if (!agentId) return 0;
  const { pool, client } = opts;

  return withClient(client || pool, async (db) => {
    const result = await db.query(
      `UPDATE cc_agent_state s
          SET current_calls_count = (
            SELECT COUNT(*)::int
              FROM cc_agent_reservations r
             WHERE r.agent_id = s.user_id
               AND r.state IN ('reserved', 'ringing', 'active')
               AND (
                 r.state = 'active'
                 OR (r.state IN ('reserved', 'ringing') AND r.lease_expires_at > now())
               )
          )
        WHERE s.user_id = $1
        RETURNING current_calls_count`,
      [agentId],
    );
    return Number(result.rows?.[0]?.current_calls_count || 0);
  });
}

async function restoreAgentAfterExpiredReservation(agentId, opts = {}) {
  try {
    const { handleAgentCallLifecycleStatus } = await import(
      "./agent-call-lifecycle-status.js"
    );
    await handleAgentCallLifecycleStatus({
      event: "no-answer",
      userId: agentId,
    });
  } catch (error) {
    reservationLogger.error("expired_reservation_no_answer_status_failed", {
      ...agentPayload({ agentUserId: agentId }),
      ...contactCenterErrorPayload(error),
    });
  }
}

export async function sweepExpiredReservations(opts = {}) {
  const { pool, client } = opts;

  return withClient(client || pool, async (db) => {
    const result = await db.query(
      `UPDATE cc_agent_reservations
          SET state = 'released', released_at = now()
        WHERE state IN ('reserved', 'ringing')
          AND lease_expires_at < now()
        RETURNING agent_id`,
    );
    const agentIds = [...new Set(result.rows.map((row) => row.agent_id).filter(Boolean))];
    for (const agentId of agentIds) {
      const activeReservations = await refreshAgentReservationCount(agentId, { client: db });
      if (activeReservations === 0) {
        await restoreAgentAfterExpiredReservation(agentId, { client: db });
      }
    }
    signalAgentsAvailable(agentIds, "reservation_expired");
    return agentIds;
  });
}
