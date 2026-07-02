/**
 * Re-evaluate waiting reasons for queued calls
 * Updates routing metadata when agent availability or skills change
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { routeCall } from "./routing-engine.js";
import { contactCenterErrorPayload, routingLogger } from "./logging.mjs";

/**
 * Re-evaluate waiting reasons for all queued calls in specified queues
 * @param {string[]} queueIds - Array of queue IDs to re-evaluate (if null/empty, evaluates all queues)
 * @returns {Promise<Object>} Result with count of interactions re-evaluated
 */
export async function reEvaluateWaitingReasonsForQueues(queueIds = null) {
  const pool = getPostgresPool();
  if (!pool) {
    return { success: false, reason: "database_unavailable" };
  }

  try {
    // Build query to get queued interactions
    let query = `
      SELECT 
        i.id,
        i.queue_id,
        i.required_skills,
        i.routing_metadata,
        i.call_control_id,
        i.call_session_id,
        i.from_number,
        i.from_name,
        i.enqueued_at,
        q.routing_strategy
      FROM cc_interactions i
      JOIN cc_queues q ON i.queue_id = q.id
      WHERE i.state = 'queued'
        AND i.agent_username IS NULL
        AND i.completed_at IS NULL
        AND i.abandoned_at IS NULL
        AND q.enabled = true
    `;

    const values = [];
    if (queueIds && Array.isArray(queueIds) && queueIds.length > 0) {
      query += ` AND i.queue_id = ANY($1::text[])`;
      values.push(queueIds);
    }

    query += ` ORDER BY i.enqueued_at ASC`;

    const interactionsResult = await pool.query(
      query,
      values.length > 0 ? values : undefined
    );

    if (!interactionsResult.rows || interactionsResult.rows.length === 0) {
      return { success: true, reEvaluated: 0, reason: "no_queued_interactions" };
    }

    let reEvaluatedCount = 0;
    const updatedInteractions = [];

    // Helper to safely parse JSONB
    const safeParse = (value) => {
      if (!value) return null;
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value;
    };

    // Re-evaluate each queued interaction
    for (const interaction of interactionsResult.rows) {
      try {
        const requiredSkills = safeParse(interaction.required_skills) || {};
        const currentRoutingMetadata = safeParse(interaction.routing_metadata) || {};

        // Re-run routing logic to get updated waiting reason
        const routingResult = await routeCall(interaction.queue_id, {
          required_skills: requiredSkills,
          reserve: false,
        });

        // Determine the new waiting reason
        let newWaitingReason = null;
        let updatedRoutingMetadata = { ...currentRoutingMetadata };

        if (!routingResult.success) {
          // No agent available or skills don't match
          if (routingResult.reason === "no_skills_matching") {
            // Agents are available but skills don't match
            newWaitingReason = {
              type: "no_skills_matching",
              skillMatch: routingResult.routingMetadata?.skillMatch || null,
              requiredSkills: requiredSkills,
            };
            updatedRoutingMetadata = {
              ...updatedRoutingMetadata,
              ...routingResult.routingMetadata,
              lastReEvaluation: new Date().toISOString(),
            };
          } else {
            // No agents available at all
            newWaitingReason = {
              type: "no_agents_available",
            };
            updatedRoutingMetadata = {
              ...updatedRoutingMetadata,
              ...routingResult.routingMetadata,
              lastReEvaluation: new Date().toISOString(),
            };
          }
        } else {
          // Agent is available - this shouldn't happen for queued calls,
          // but if it does, we should still update the metadata
          updatedRoutingMetadata = {
            ...updatedRoutingMetadata,
            ...routingResult.routingMetadata,
            lastReEvaluation: new Date().toISOString(),
          };
        }

        // Check if the waiting reason actually changed
        const previousSkillMatch = currentRoutingMetadata?.skillMatch;
        const newSkillMatch = updatedRoutingMetadata?.skillMatch;

        // Determine previous waiting reason type
        const previousHadSkillMatch = previousSkillMatch && previousSkillMatch.matchRatio !== undefined;
        const newHasSkillMatch = newSkillMatch && newSkillMatch.matchRatio !== undefined;

        // Check if the reason type changed (no agents vs skills not matched)
        const reasonTypeChanged = 
          (previousHadSkillMatch && !newHasSkillMatch) || // Was skills not matched, now no agents
          (!previousHadSkillMatch && newHasSkillMatch);  // Was no agents, now skills not matched

        // Check if skill match details changed
        const skillMatchDetailsChanged = 
          previousHadSkillMatch && newHasSkillMatch &&
          (previousSkillMatch.matchRatio !== newSkillMatch.matchRatio ||
           previousSkillMatch.matchedSkills !== newSkillMatch.matchedSkills ||
           previousSkillMatch.totalRequired !== newSkillMatch.totalRequired ||
           previousSkillMatch.agentsAnalyzed !== newSkillMatch.agentsAnalyzed);

        // Always update if this is the first evaluation or if something changed
        const shouldUpdate = 
          !currentRoutingMetadata.lastReEvaluation || // First evaluation
          reasonTypeChanged || // Reason type changed
          skillMatchDetailsChanged; // Skill match details changed

        if (shouldUpdate) {
          await PgDb.updateInteractionById(interaction.id, {
            routingMetadata: updatedRoutingMetadata,
          });

          reEvaluatedCount++;
          updatedInteractions.push({
            interactionId: interaction.id,
            queueId: interaction.queue_id,
            waitingReason: newWaitingReason,
          });
        }
      } catch (error) {
        routingLogger.error("waitingreasonreevaluator", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
        // Continue with next interaction
      }
    }

    return {
      success: true,
      reEvaluated: reEvaluatedCount,
      interactionsUpdated: updatedInteractions,
    };
  } catch (error) {
    routingLogger.error("waitingreasonreevaluator", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
    return { success: false, reason: "error", error: error.message };
  }
}

/**
 * Re-evaluate waiting reasons for queues where a user is assigned
 * Called when user status or skills change
 * @param {string} userId - User ID whose status/skills changed
 * @returns {Promise<Object>} Result with count of interactions re-evaluated
 */
export async function reEvaluateWaitingReasonsForUserQueues(userId) {
  const pool = getPostgresPool();
  if (!pool) {
    return { success: false, reason: "database_unavailable" };
  }

  try {
    // Get queues where user is assigned and activated
    const queueResult = await pool.query(
      `SELECT DISTINCT qa.queue_id
       FROM cc_queue_user_assignments qa
       JOIN cc_queues q ON q.id = qa.queue_id
       WHERE qa.user_id = $1
         AND qa.enabled = true
         AND q.enabled = true
         AND qa.activated_at IS NOT NULL
         AND qa.deactivated_at IS NULL`,
      [userId]
    );

    if (!queueResult.rows || queueResult.rows.length === 0) {
      return {
        success: true,
        reEvaluated: 0,
        reason: "no_active_queues_for_user",
      };
    }

    const queueIds = queueResult.rows.map((row) => row.queue_id);
    return await reEvaluateWaitingReasonsForQueues(queueIds);
  } catch (error) {
    routingLogger.error("waitingreasonreevaluator", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
    return { success: false, reason: "error", error: error.message };
  }
}
