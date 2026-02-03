/**
 * Re-evaluate waiting interactions when user skills change
 * Checks if updated user now matches any waiting calls in skills-based queues
 */

import { getPostgresPool } from "@/lib/postgres.mjs";
import { assignCallToAgent, getRealtimeAgentMetrics } from "./state-manager.js";
import { PgDb } from "@/lib/pgdb";
import { addTimelineEvent, TimelineEventTypes } from "./call-timeline-tracker.js";

/**
 * Re-evaluate waiting interactions for a user after skills change
 * @param {string} userId - User ID whose skills were updated
 * @returns {Promise<Object>} Result with count of interactions re-evaluated and routed
 */
export async function reEvaluateWaitingInteractionsForUser(userId) {
  const pool = getPostgresPool();
  if (!pool) {
    return { success: false, reason: "database_unavailable" };
  }

  try {
    // Get user info to check availability
    const userResult = await pool.query(
      `SELECT 
        u.id,
        u.username,
        u.first_name,
        u.last_name,
        u.agent_status,
        u.skills,
        u.max_concurrent_calls,
        u.available_for_routing,
        COALESCE(ast.is_available_for_routing, true) as is_available_for_routing
      FROM users u
      LEFT JOIN cc_agent_state ast ON u.id = ast.user_id
      WHERE u.id = $1`,
      [userId]
    );

    if (!userResult.rows || userResult.rows.length === 0) {
      return { success: false, reason: "user_not_found" };
    }

    const user = userResult.rows[0];
    
    // Check if user is available for routing
    if (user.agent_status !== "Available") {
      return { success: true, routed: 0, reason: "user_not_available" };
    }

    if (!user.available_for_routing || user.is_available_for_routing === false) {
      return { success: true, routed: 0, reason: "user_not_available_for_routing" };
    }

    // Get user's current call count
    const { activeCalls } = getRealtimeAgentMetrics(user.id);
    const currentCallsCount = activeCalls || 0;

    if (currentCallsCount >= user.max_concurrent_calls) {
      return { success: true, routed: 0, reason: "user_at_capacity" };
    }

    // Get queues where user is assigned and activated
    const queueResult = await pool.query(
      `SELECT qa.queue_id, q.id, q.name, q.routing_strategy
       FROM cc_queue_user_assignments qa
       JOIN cc_queues q ON q.id = qa.queue_id
       WHERE qa.user_id = $1
         AND qa.enabled = true
         AND q.enabled = true
         AND qa.activated_at IS NOT NULL
         AND qa.deactivated_at IS NULL
         AND q.routing_strategy = 'Skill-based'`,
      [userId]
    );

    if (!queueResult.rows || queueResult.rows.length === 0) {
      return { success: true, routed: 0, reason: "no_skills_based_queues" };
    }

    const queueIds = queueResult.rows.map((row) => row.queue_id);
    
    // Import and get skills mapping
    const { getSkillsMapping } = await import("./routing-engine.js");
    const skillsMapping = await getSkillsMapping();

    // Get all waiting interactions in these queues
    const interactionsResult = await pool.query(
      `SELECT 
        i.id,
        i.queue_id,
        i.required_skills,
        i.routing_metadata,
        i.call_control_id,
        i.call_session_id,
        i.from_number,
        i.from_name,
        i.enqueued_at
      FROM cc_interactions i
      WHERE i.queue_id = ANY($1::text[])
        AND i.state = 'queued'
        AND i.agent_username IS NULL
        AND i.completed_at IS NULL
        AND i.abandoned_at IS NULL
      ORDER BY i.enqueued_at ASC`,
      [queueIds]
    );

    if (!interactionsResult.rows || interactionsResult.rows.length === 0) {
      return { success: true, routed: 0, reason: "no_waiting_interactions" };
    }

    // Helper to safely parse JSONB
    const safeParse = (value) => {
      if (!value) return null;
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return null;
        }
      }
      return value;
    };

    // Convert user skills from UUIDs to names
    const userSkillsRaw = user.skills || {};
    const userSkills = {};
    if (typeof userSkillsRaw === 'string') {
      try {
        const parsed = JSON.parse(userSkillsRaw);
        Object.assign(userSkills, parsed);
      } catch {
        // Ignore parse errors
      }
    } else if (typeof userSkillsRaw === 'object') {
      Object.assign(userSkills, userSkillsRaw);
    }

    // Convert UUIDs to names
    const userSkillsByName = {};
    for (const [skillId, proficiency] of Object.entries(userSkills)) {
      const skillName = skillsMapping.get(skillId);
      if (skillName) {
        userSkillsByName[skillName] = proficiency;
      }
    }

    let routedCount = 0;
    const routedInteractions = [];

    // Check each waiting interaction
    for (const interaction of interactionsResult.rows) {
      // Skip if user is now at capacity
      const { activeCalls: currentActiveCalls } = getRealtimeAgentMetrics(user.id);
      if (currentActiveCalls >= user.max_concurrent_calls) {
        break;
      }

      const requiredSkills = safeParse(interaction.required_skills) || {};
      
      // Skip if no required skills
      if (!requiredSkills || Object.keys(requiredSkills).length === 0) {
        continue;
      }

      // Check if user matches all required skills
      let matchesAllSkills = true;
      for (const [skillName, requiredLevel] of Object.entries(requiredSkills)) {
        const userLevel = userSkillsByName[skillName] || 0;
        if (userLevel < requiredLevel) {
          matchesAllSkills = false;
          break;
        }
      }

      if (!matchesAllSkills) {
        continue;
      }

      // User matches! Directly assign this interaction to the user
      // We've already verified: user is available, matches skills, is activated in queue, has capacity
      try {
        const queue = queueResult.rows.find((q) => q.queue_id === interaction.queue_id);
        if (!queue) continue;

        // Double-check user is still available and has capacity before assigning
        const { activeCalls: finalCheckActiveCalls } = getRealtimeAgentMetrics(user.id);
        if (finalCheckActiveCalls >= user.max_concurrent_calls) {
          break; // User is now at capacity, stop processing
        }

        const assignedAt = new Date().toISOString();
        const waitTimeSeconds = interaction.enqueued_at
          ? Math.floor(
              (new Date(assignedAt).getTime() -
                new Date(interaction.enqueued_at).getTime()) /
                1000
            )
          : 0;

        const agentDisplayName = [user.first_name, user.last_name]
          .filter(Boolean)
          .join(" ")
          .trim();

        const routingMetadataWithAlerting = addTimelineEvent(
          safeParse(interaction.routing_metadata) || {},
          TimelineEventTypes.ALERTING,
          {
            timestamp: assignedAt,
            agentUsername: user.username,
            agentId: user.id,
            routingAlgorithm: "skills_based",
            reEvaluated: true,
          }
        );

        // Update interaction state first - this removes it from the queue
        await PgDb.updateInteractionById(interaction.id, {
          agentUsername: user.username,
          state: "ringing",
          toName: agentDisplayName || user.username,
          assignedAt,
          routingMetadata: routingMetadataWithAlerting,
          waitTimeSeconds,
        });

        // Update state manager to remove from queue and assign to agent
        assignCallToAgent(
          interaction.queue_id,
          interaction.id,
          user.id,
          assignedAt
        );

        // Stop queue audio before transferring to agent
        try {
          const { stopQueueAudio } = await import("./queue-audio-service.js");
          await stopQueueAudio(interaction.call_control_id);
        } catch (audioError) {
          console.error(
            `[SkillsReEvaluator] Failed to stop queue audio for ${interaction.id}:`,
            audioError
          );
          // Continue with transfer even if audio stop fails
        }

        // Automatically transfer call to agent's WebRTC client
        try {
          const { bridgeCallToAgent } = await import("./webrtc-bridge.js");
          const bridgeResult = await bridgeCallToAgent(
            interaction.call_session_id,
            interaction.call_control_id,
            user.username,
            interaction.from_number,
            interaction.from_name
          );
          
          if (!bridgeResult.success) {
            console.error(
              `[SkillsReEvaluator] Bridge call failed for ${interaction.id}:`,
              bridgeResult
            );
          }
        } catch (bridgeError) {
          console.error(
            `[SkillsReEvaluator] Error bridging call ${interaction.id} to agent ${user.username}:`,
            bridgeError
          );
          // Don't fail if transfer fails - agent can still answer manually
        }

        // Notify agent via SSE
        try {
          const { broadcastToKey } = await import("@/lib/sse");
          await broadcastToKey(`contact-center:agent:${user.username}`, {
            type: "new_interaction",
            interaction: {
              id: interaction.id,
              queueName: queue.name,
              fromNumber: interaction.from_number,
              toNumber: null,
              fromName: interaction.from_name,
              state: "ringing",
              callControlId: interaction.call_control_id,
              callSessionId: interaction.call_session_id,
              callerName: interaction.from_name,
              callerNumber: interaction.from_number,
              queueId: interaction.queue_id,
              queuedAt: interaction.enqueued_at,
              assignedAt,
              aiCallControlId: interaction.metadata?.ai_call_control_id || null,
              metadata: interaction.metadata || {},
            },
          });
        } catch (sseError) {
          console.error(
            `[SkillsReEvaluator] Failed to broadcast SSE for ${interaction.id}:`,
            sseError
          );
        }

        routedCount++;
        routedInteractions.push(interaction.id);
      } catch (error) {
        console.error(
          `[SkillsReEvaluator] Error routing interaction ${interaction.id}:`,
          error
        );
        // Continue with next interaction
      }
    }

    return {
      success: true,
      routed: routedCount,
      interactionsRouted: routedInteractions,
    };
  } catch (error) {
    console.error("[SkillsReEvaluator] Error re-evaluating interactions:", error);
    return { success: false, reason: "error", error: error.message };
  }
}
