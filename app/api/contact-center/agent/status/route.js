import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isSupervisorOrAdmin } from "@/lib/role-utils";
import { setUserStatus } from "@/lib/contact-center/user-status";

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
        { status: 401 }
      );
    }

    const body = await request.json();
    const { status, userId: targetUserId } = body;

    if (!status || typeof status !== "string") {
      return NextResponse.json(
        { ok: false, error: "Status is required" },
        { status: 400 }
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
          { status: 403 }
        );
      }
      targetUserIdFinal = targetUserId;
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    // Validate status against database
    let validStatuses = ["Available", "Busy", "Away", "Offline"];
    try {
      const statusResult = await pool.query(
        `SELECT name FROM cc_user_statuses WHERE is_active = true ORDER BY display_order ASC, name ASC`
      );
      if (statusResult.rows.length > 0) {
        validStatuses = statusResult.rows.map((row) => row.name);
      }
    } catch (error) {
      console.error("[AgentStatus] Error fetching statuses:", error);
      // Use fallback statuses
    }

    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        {
          ok: false,
          error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        },
        { status: 400 }
      );
    }

    // Get target user info
    const targetUserRes = await pool.query(
      `SELECT id, username, status, agent_status FROM users WHERE id = $1`,
      [targetUserIdFinal]
    );

    if (!targetUserRes.rows || targetUserRes.rows.length === 0) {
      return NextResponse.json(
        { ok: false, error: "User not found" },
        { status: 404 }
      );
    }

    const targetUser = targetUserRes.rows[0];
    const previousStatus = targetUser.status || targetUser.agent_status || "Unknown";

    // Update status using the setUserStatus function which handles all the necessary updates
    await setUserStatus({
      userId: String(targetUserIdFinal),
      username: targetUser.username,
      status,
      previousStatus,
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
        console.error(
          "[AgentStatus] Failed to log supervisor activity:",
          activityError
        );
        // Don't fail the request if activity logging fails
      }
    }

    return NextResponse.json({
      ok: true,
      status,
      userId: String(targetUserIdFinal),
      previousStatus,
    });
  } catch (err) {
    console.error("[ContactCenter] Status update error:", err);
    return NextResponse.json(
      { ok: false, error: err.message || "Server error" },
      { status: 500 }
    );
  }
}

