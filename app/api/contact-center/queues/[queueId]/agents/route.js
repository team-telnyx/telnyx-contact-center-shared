import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { getRealtimeAgentMetrics } from "@/lib/contact-center/state-manager.js";

/**
 * GET /api/contact-center/queues/[queueId]/agents
 * Get available agents for a queue with their skills
 */
export async function GET(request, { params }) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Only supervisors and admins can view queue agents
    if (!isSupervisorOrAdmin(user)) {
      return NextResponse.json(
        { ok: false, error: "Forbidden" },
        { status: 403 }
      );
    }

    const { queueId } = await params;
    if (!queueId) {
      return NextResponse.json(
        { ok: false, error: "Queue ID is required" },
        { status: 400 }
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    // Get agents assigned to this queue and currently active
    const query = `
      SELECT 
        u.id,
        u.username,
        u.first_name,
        u.last_name,
        u.agent_status,
        u.skills,
        u.max_concurrent_calls,
        u.available_for_routing,
        COALESCE(ast.is_available_for_routing, true) as is_available_for_routing,
        qa.priority as queue_priority,
        qa.enabled as assignment_enabled,
        qa.activated_at,
        qa.deactivated_at
      FROM users u
      INNER JOIN cc_queue_user_assignments qa ON u.id = qa.user_id
      LEFT JOIN cc_agent_state ast ON u.id = ast.user_id
      WHERE qa.queue_id = $1
        AND qa.enabled = true
        AND (qa.activated_at IS NOT NULL AND qa.deactivated_at IS NULL)
      GROUP BY u.id, u.username, u.first_name, u.last_name, u.agent_status, u.skills, u.max_concurrent_calls, 
               u.available_for_routing, ast.is_available_for_routing, qa.priority, 
               qa.enabled, qa.activated_at, qa.deactivated_at
      ORDER BY qa.priority DESC, u.agent_status ASC
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
      const { activeCalls } = getRealtimeAgentMetrics(agent.id);
      const agentSkillsRaw = safeParse(agent.skills);
      const agentSkills = convertAgentSkillsToNames(agentSkillsRaw);

      return {
        id: agent.id,
        username: agent.username,
        firstName: agent.first_name,
        lastName: agent.last_name,
        agentStatus: agent.agent_status,
        skills: agentSkills, // Converted to use skill names as keys
        maxConcurrentCalls: agent.max_concurrent_calls,
        availableForRouting: agent.available_for_routing,
        isAvailableForRouting: agent.is_available_for_routing,
        queuePriority: agent.queue_priority,
        currentCallsCount: activeCalls || 0,
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
    console.error("[QueueAgents] Error fetching queue agents:", error);
    return NextResponse.json(
      { ok: false, error: "Failed to fetch queue agents" },
      { status: 500 }
    );
  }
}
