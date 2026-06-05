import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { markAgentBusyForRinging } from "./agent-status-transition.js";
import { setUserStatus } from "./user-status.js";

async function resolveAgent({ userId = null, username = null } = {}) {
  if (userId) {
    const user = await PgDb.findUserById(String(userId));
    if (user) return user;
  }
  if (username) {
    const user = await PgDb.findUserByUsername(username);
    if (user) return user;
  }
  return null;
}

async function getResolvedAgentStatus(agentId) {
  const pool = getPostgresPool();
  if (!pool || !agentId) return null;
  const result = await pool.query(
    "SELECT agent_status FROM cc_agent_state WHERE user_id = $1",
    [String(agentId)],
  );
  return result.rows?.[0]?.agent_status || null;
}

async function clearResolvedAgentCallCount(agentId) {
  const pool = getPostgresPool();
  if (!pool || !agentId) return;
  await pool.query(
    `UPDATE cc_agent_state
        SET current_calls_count = 0,
            last_activity = NOW()
      WHERE user_id = $1`,
    [String(agentId)],
  );
}

async function setResolvedAgentStatus({
  userId,
  username,
  status,
  clearCallCount = false,
}) {
  const agent = await resolveAgent({ userId, username });
  if (!agent?.id) {
    return { changed: false, reason: "agent_not_found", status };
  }

  const resolvedUserId = String(agent.id);
  const resolvedUsername = username || agent.username;
  const previousStatus = await getResolvedAgentStatus(resolvedUserId);

  if (clearCallCount) {
    await clearResolvedAgentCallCount(resolvedUserId);
  }

  await setUserStatus({
    userId: resolvedUserId,
    username: resolvedUsername,
    status,
    previousStatus: previousStatus || "Unknown",
  });

  return {
    changed: true,
    status,
    userId: resolvedUserId,
    username: resolvedUsername,
  };
}

/**
 * Single backend-owned status state machine for Contact Center call lifecycle.
 *
 * UI/presence/localStorage must not write these lifecycle statuses. The only
 * frontend status writer is the manual user dropdown. Call-state events map to:
 * - ringing -> Busy
 * - connected -> Busy
 * - disconnected after answered evidence -> Wrapup
 * - rejected/no-answer before answer -> Agent Not Answering
 * - customer-abandoned before answer -> Available
 * - wrapup-ended -> Available
 */
export async function handleAgentCallLifecycleStatus({
  event,
  userId = null,
  username = null,
  interaction = null,
} = {}) {
  const interactionUsername = username || interaction?.agent_username || null;

  switch (event) {
    case "ringing": {
      const agent = await resolveAgent({ userId, username: interactionUsername });
      if (!agent?.id) return { changed: false, reason: "agent_not_found", event };
      return markAgentBusyForRinging({
        userId: String(agent.id),
        username: interactionUsername || agent.username,
      });
    }

    case "connected": {
      const agent = await resolveAgent({ userId, username: interactionUsername });
      if (!agent?.id) return { changed: false, reason: "agent_not_found", event };
      return markAgentBusyForRinging({
        userId: String(agent.id),
        username: interactionUsername || agent.username,
      });
    }

    case "disconnected": {
      const answeredAt = interaction?.answered_at || interaction?.answeredAt;
      if (!answeredAt) {
        return { changed: false, reason: "not_answered_no_wrapup", event };
      }
      return setResolvedAgentStatus({
        userId,
        username: interactionUsername,
        status: "Wrapup",
        clearCallCount: true,
      });
    }

    case "rejected": {
      return setResolvedAgentStatus({
        userId,
        username: interactionUsername,
        status: "Agent Not Answering",
        clearCallCount: true,
      });
    }

    case "no-answer": {
      return setResolvedAgentStatus({
        userId,
        username: interactionUsername,
        status: "Agent Not Answering",
        clearCallCount: true,
      });
    }

    case "customer-abandoned": {
      return setResolvedAgentStatus({
        userId,
        username: interactionUsername,
        status: "Available",
        clearCallCount: true,
      });
    }

    case "wrapup-ended": {
      return setResolvedAgentStatus({
        userId,
        username: interactionUsername,
        status: "Available",
      });
    }

    default:
      return { changed: false, reason: "unsupported_event", event };
  }
}
