import { resolveReportingScope } from "@/lib/acd/reporting-scope.mjs";
import { agentAdherenceReport } from "@/lib/acd/workforce-reports.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { contactCenterRuntimeLogger, runtimePayload } from "@/lib/runtime-logging.mjs";
import {
  effectiveAgentStatus,

} from "@/lib/acd/agent-state.mjs";
import {
  enrichAcdRealtimeCalls,
  getAcdRealtimeAgentCalls,
} from "@/lib/acd/realtime-queue-calls.mjs";
import { withPermission } from "@/lib/authz/guard";
import { agentInScope } from "@/lib/authz/scope.mjs";

/**
 * GET /api/contact-center/agents/[userId]/calls
 * Get all active calls for a specific agent with detailed statistics
 */
async function GET_handler(request, { params }, authz) {
  try {
    const user = authz.user;

    // Only supervisors and admins can view agent calls

    const { userId } = await params;
    if (!userId) {
      return NextResponse.json(
        { ok: false, error: "User ID is required" },
        { status: 400 },
      );
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 },
      );
    }

    // Get agent info

    const agentResult = await pool.query(
      `SELECT
         u.id,
         u.username,
         u.first_name,
         u.last_name,
         ast.agent_id AS state_agent_id,
         ast.presence,
         ast.routability,
         ast.manual_status,
         ast.workflow_state,
         u.max_concurrent_calls
       FROM users u
       LEFT JOIN acd_agent_state ast ON ast.agent_id = u.id
       WHERE u.id = $1`,
      [userId],
    );

    if (agentResult.rows.length === 0 || !agentInScope(authz.scope, userId)) {
      return NextResponse.json(
        { ok: false, error: "Agent not found" },
        { status: 404 },
      );
    }

    const agent = agentResult.rows[0];
    const agentName =
      agent.first_name || agent.last_name
        ? `${agent.first_name || ""} ${agent.last_name || ""}`.trim()
        : agent.username;

    const calls = await enrichAcdRealtimeCalls(
      pool,
      await getAcdRealtimeAgentCalls(pool, userId),
    );

    // Filter active calls (not completed or abandoned)
    const activeCalls = calls.filter(
      (call) =>
        call.state &&
        !["completed", "abandoned", "failed"].includes(
          call.state.toLowerCase(),
        ),
    );

    // Include the current status interval and clip today's totals to the
    // supervisor's timezone, using the same ledger as the adherence report.
    const scope = await resolveReportingScope(pool, new URLSearchParams({
      period: "today", timezone: new URL(request.url).searchParams.get("timezone") || "UTC",
    }), authz.scope);
    const workforce = await agentAdherenceReport(pool, { ...scope, agentId: userId });
    const timeTracking = workforce.agents.find(row => row.username === agent.username);

    return NextResponse.json({
      ok: true,
      agent: {
        id: agent.id,
        username: agent.username,
        name: agentName,
        firstName: agent.first_name,
        lastName: agent.last_name,
        status: effectiveAgentStatus(agent.state_agent_id ? agent : null),
        maxConcurrentCalls: agent.max_concurrent_calls,
      },
      calls,
      activeCalls,
      timeTracking: {
        callSeconds: timeTracking?.callSeconds || 0,
        breakSeconds: timeTracking?.breakSeconds || 0,
        workSeconds: timeTracking?.loggedInSeconds || 0,
      },
    });
  } catch (error) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: "Failed to fetch agent calls" },
      { status: 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agents:read", GET_handler, { route: "/api/contact-center/agents/[userId]/calls" });
