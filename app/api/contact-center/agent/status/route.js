import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { effectiveAgentStatus, ensureAgentState, readAgentStatusPresentation, setManualAgentStatus } from "@/lib/acd/agent-state.mjs";
import { agentPayload, contactCenterErrorPayload, statusLogger } from "@/lib/contact-center/logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { agentInScope } from "@/lib/authz/scope.mjs";

/**
 * PUT /api/contact-center/agent/status
 * Update agent status
 * If userId is provided and requester is supervisor/admin, update status for that user
 */
async function PUT_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const body = await request.json();
    const { status, userId: targetUserId } = body;
    statusLogger.debug("status_update_requested", {
      requesterUserId: String(user.id),
      requesterUsername: user.username || user.email || null,
      requestedStatus: status || null,
      targetUserId: targetUserId ? String(targetUserId) : null,
    });

    if (!status || typeof status !== "string") {
      return NextResponse.json(
        { ok: false, error: "Status is required" },
        { status: 400 },
      );
    }

    // Determine which user's status to update
    // If userId is provided and requester is supervisor/admin, use that userId
    // Otherwise, use the authenticated user's id
    let targetUserIdFinal = user.id;
    if (targetUserId && targetUserId !== user.id) {
      targetUserIdFinal = targetUserId;
      // Changing another agent's status needs agents:status.set (`authz.elevated`)
      // and the agent must be within the caller's data scope (Phase 3a).
      if (!authz.elevated || !agentInScope(authz.scope, targetUserId)) {
        return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
      }
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 },
      );
    }

    // Validate status against database
    // If supervisor is changing another agent's status, only allow user-selectable statuses
    // Otherwise (self-update), allow all active statuses (but Offline is not user-selectable)
    const isSupervisorChangingOtherUser = targetUserIdFinal !== user.id;
    let validStatuses = isSupervisorChangingOtherUser
      ? ["Available", "Busy", "Away"] // User-selectable only (Offline is not user-selectable)
      : ["Available", "Busy", "Away"]; // For self-update, still exclude Offline (system-only)
    try {
      const query = isSupervisorChangingOtherUser
        ? `SELECT name FROM cc_user_statuses WHERE is_active = true AND user_selectable = true ORDER BY display_order ASC, name ASC`
        : `SELECT name FROM cc_user_statuses WHERE is_active = true AND user_selectable = true ORDER BY display_order ASC, name ASC`;
      const statusResult = await pool.query(query);
      if (statusResult.rows.length > 0) {
        validStatuses = statusResult.rows.map((row) => row.name);
      }
    } catch (error) {
      statusLogger.error("status_catalog_fetch_failed", contactCenterErrorPayload(error));
      // Use fallback statuses (Offline is not user-selectable)
    }

    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        {
          ok: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        },
        { status: 400 },
      );
    }

    // Get target user info and Contact Center authoritative status
    await ensureAgentState(pool, targetUserIdFinal);
    const targetUserRes = await pool.query(
      `SELECT u.id, u.username, s.*
         FROM users u
         JOIN acd_agent_state s ON s.agent_id = u.id
        WHERE u.id = $1`,
      [targetUserIdFinal],
    );

    if (!targetUserRes.rows || targetUserRes.rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "User not found" },
        { status: 404 },
      );
    }

    const targetUser = targetUserRes.rows[0];
    const previousStatus = effectiveAgentStatus(targetUser);

    // Commit the operator's selection through the canonical Core state writer.
    const statusUpdateStartedAt = Date.now();
    const effectiveStatus = await setManualAgentStatus(pool, {
      agentId: String(targetUserIdFinal),
      status,
      actor: targetUserIdFinal !== user.id ? `supervisor:${user.id}` : `agent:${user.id}`,
      expectedVersion: body.expectedVersion ?? null,
    });
    statusLogger.info("status_update_completed", {
      ...agentPayload({ agentUserId: targetUserIdFinal, agentUsername: targetUser.username }),
      requestedStatus: status,
      effectiveStatus: effectiveStatus || status,
      previousStatus,
      durationMs: Date.now() - statusUpdateStartedAt,
      reason: targetUserIdFinal !== user.id ? "supervisor_action" : "self_update",
    });

    // Log activity for supervisor/admin actions
    if (targetUserIdFinal !== user.id) {
      try {
        const { PgDb } = await import("@/lib/pgdb");
        await PgDb.logUserActivity({
          userId: String(targetUserIdFinal),
          activityType: "status_change",
          activityValue: status,
          previousValue: previousStatus,
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          metadata: {
            changedBy: user.id,
            changedByUsername: user.username,
            supervisorAction: true,
          },
        });
      } catch (activityError) {
        statusLogger.error("supervisor_activity_log_failed", {
          ...agentPayload({ agentUserId: targetUserIdFinal, agentUsername: targetUser.username }),
          ...contactCenterErrorPayload(activityError),
          reason: "supervisor_status_change",
        });
        // Don't fail the request if activity logging fails
      }
    }

    // One snapshot decides the whole tuple. Reading the status from before the
    // write and the pending fields from after it can report Busy with no
    // pending status while the database already holds the applied break.
    const presentation = await readAgentStatusPresentation(pool, String(targetUserIdFinal), effectiveStatus || status);
    return NextResponse.json({
      ok: true,
      status: presentation.status,
      pendingStatus: presentation.pendingStatus,
      pendingSince: presentation.pendingSince,
      requestedStatus: status,
      userId: String(targetUserIdFinal),
      previousStatus,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err.message || "Server error" },
      { status: err.status || 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const PUT = withPermission(["agents:status.set","agent:self"], PUT_handler, { route: "/api/contact-center/agent/status", elevated: "agents:status.set" });
