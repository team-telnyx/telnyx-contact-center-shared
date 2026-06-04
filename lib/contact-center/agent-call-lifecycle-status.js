import { PgDb } from "@/lib/pgdb";
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

async function setResolvedAgentStatus({ userId, username, status }) {
  const agent = await resolveAgent({ userId, username });
  if (!agent?.id) {
    return { changed: false, reason: "agent_not_found", status };
  }

  await setUserStatus({
    userId: String(agent.id),
    username: username || agent.username,
    status,
    previousStatus: agent.agent_status || agent.status || "Unknown",
  });

  return {
    changed: true,
    status,
    userId: String(agent.id),
    username: username || agent.username,
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
      });
    }

    case "rejected": {
      return setResolvedAgentStatus({
        userId,
        username: interactionUsername,
        status: "Agent Not Answering",
      });
    }

    case "no-answer": {
      return setResolvedAgentStatus({
        userId,
        username: interactionUsername,
        status: "Agent Not Answering",
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
