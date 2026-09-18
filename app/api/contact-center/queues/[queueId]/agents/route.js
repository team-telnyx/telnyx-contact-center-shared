import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { contactCenterErrorPayload, queuesLogger } from "@/lib/contact-center/logging.mjs";
import { effectiveAgentStatusSql, pendingAgentStatusSql } from "@/lib/acd/agent-state.mjs";
import { withPermission } from "@/lib/authz/guard";
import { queueInScope } from "@/lib/authz/scope.mjs";

/**
 * GET /api/contact-center/queues/[queueId]/agents
 * Get available agents for a queue with their skills
 */
async function GET_handler(request, { params }, authz) {
  try {
    const user = authz.user;

    // Only supervisors and admins can view queue agents

    const { queueId } = await params;
    if (!queueId) {
      return NextResponse.json(
        { ok: false, error: "Queue ID is required" },
        { status: 400 }
      );
    }
    if (!queueInScope(authz.scope, queueId)) {
      return NextResponse.json({ ok: false, error: "Queue not found" }, { status: 404 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    // Get agents assigned to this queue and currently active
    const effectiveStatus = effectiveAgentStatusSql("ast");
    const query = `
      SELECT 
        u.id,
        u.username,
        u.first_name,
        u.last_name,
        ${effectiveStatus} AS agent_status,
        ${pendingAgentStatusSql("ast")} AS pending_status,
        u.skills,
        u.max_concurrent_calls,
        u.available_for_routing,
        COALESCE(ast.routability = 'routable', false) as is_available_for_routing,
        COUNT(DISTINCT r.work_item_id) FILTER (
          WHERE r.state <> 'released'
            AND (r.state = 'active' OR r.owner_saga_id IS NOT NULL OR r.lease_expires_at > now())
        )::int AS active_calls,
        qa.priority as queue_priority,
        qa.enabled as assignment_enabled,
        qa.activated_at,
        qa.deactivated_at
      FROM users u
      INNER JOIN cc_queue_user_assignments qa ON u.id = qa.user_id
      LEFT JOIN acd_agent_state ast ON u.id = ast.agent_id
      LEFT JOIN acd_reservations r ON r.agent_id = u.id
      WHERE qa.queue_id = $1
        AND qa.enabled = true
        AND (qa.activated_at IS NOT NULL AND qa.deactivated_at IS NULL)
      GROUP BY u.id, u.username, u.first_name, u.last_name, ast.agent_id, ast.presence,
               ast.routability, ast.workflow_state, ast.manual_status, u.skills, u.max_concurrent_calls,
               u.available_for_routing, qa.priority,
               qa.enabled, qa.activated_at, qa.deactivated_at
      ORDER BY qa.priority DESC, agent_status ASC
    `;

    const result = await pool.query(query, [queueId]);

    // Load skills mapping (UUID to name)
    const skillsResult = await pool.query(
      `SELECT id, name FROM skills WHERE is_active = true`
    );
    const skillsMapping = new Map();
    skillsResult.rows.forEach((row) => {
      skillsMapping.set(row.id, row.name);
    });

    // Helper function to safely parse JSONB skills
    const safeParse = (value) => {
      if (!value) return {};
      if (typeof value === "string") {
        try {
          return JSON.parse(value);
        } catch {
          return {};
        }
      }
      return value || {};
    };

    // Helper function to convert agent skills from UUID keys to name keys
    const convertAgentSkillsToNames = (agentSkills) => {
      if (!agentSkills || typeof agentSkills !== "object") {
        return {};
      }
      const converted = {};
      for (const [skillId, proficiency] of Object.entries(agentSkills)) {
        const skillName = skillsMapping.get(skillId);
        if (skillName) {
          converted[skillName] = proficiency;
        }
      }
      return converted;
    };

    const agentsWithCounts = result.rows.map((agent) => {
      const agentSkillsRaw = safeParse(agent.skills);
      const agentSkills = convertAgentSkillsToNames(agentSkillsRaw);

      return {
        id: agent.id,
        username: agent.username,
        firstName: agent.first_name,
        lastName: agent.last_name,
        agentStatus: agent.agent_status,
        pendingStatus: agent.pending_status || null,
        skills: agentSkills, // Converted to use skill names as keys
        maxConcurrentCalls: agent.max_concurrent_calls,
        availableForRouting: agent.available_for_routing,
        isAvailableForRouting: agent.is_available_for_routing,
        queuePriority: agent.queue_priority,
        currentCallsCount: Number(agent.active_calls || 0),
      };
    });

    // Filter to available agents (Available status, available for routing, under capacity)
    const availableAgents = agentsWithCounts.filter((agent) => {
      if (agent.agentStatus !== "Available") return false;
      if (!agent.availableForRouting) return false;
      if (agent.isAvailableForRouting === false) return false;
      return agent.currentCallsCount < agent.maxConcurrentCalls;
    });

    return NextResponse.json({
      ok: true,
      agents: availableAgents,
    });
  } catch (error) {
    queuesLogger.error("queueagents", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
    return NextResponse.json(
      { ok: false, error: "Failed to fetch queue agents" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("monitor:read", GET_handler, { route: "/api/contact-center/queues/[queueId]/agents" });
