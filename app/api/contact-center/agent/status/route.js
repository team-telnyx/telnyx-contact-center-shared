import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { setUserStatus } from "@/lib/contact-center/user-status";
import { agentPayload, contactCenterErrorPayload, statusLogger } from "@/lib/contact-center/logging.mjs";

/**
 * PUT /api/contact-center/agent/status
 * Update agent status
 * If userId is provided and requester is supervisor/admin, update status for that user
 */
export async function PUT(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

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
      if (!isSupervisorOrAdmin(user)) {
        return NextResponse.json(
          {
            ok: false,
            error: "Only supervisors and admins can manage other users' status",
          },
          { status: 403 },
        );
      }
      targetUserIdFinal = targetUserId;
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
    const targetUserRes = await pool.query(
      `SELECT u.id, u.username, s.agent_status AS current_agent_status
         FROM users u
         LEFT JOIN cc_agent_state s ON s.user_id = u.id
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
    const previousStatus = targetUser.current_agent_status || "Unknown";

    // Update status using the setUserStatus function which handles all the necessary updates
    const statusUpdateStartedAt = Date.now();
    const effectiveStatus = await setUserStatus({
      userId: String(targetUserIdFinal),
      username: targetUser.username,
      status,
      previousStatus,
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

    return NextResponse.json({
      ok: true,
      status: effectiveStatus || status,
      requestedStatus: status,
      userId: String(targetUserIdFinal),
      previousStatus,
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err.message || "Server error" },
      { status: 500 },
    );
  }
}
