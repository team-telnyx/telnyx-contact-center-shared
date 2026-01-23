import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { broadcastToKey } from "@/lib/sse";
import { offerQueuedCallForAgent } from "@/lib/contact-center/queued-call-router";
import { getPostgresPool } from "@/lib/postgres.mjs";

const ALLOWED_THEMES = ["light", "dark", "system"];

// Get allowed statuses from database
async function getAllowedStatuses() {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      // Fallback to default statuses if DB not available
      return ["Available", "Busy", "Away", "Offline"];
    }
    const result = await pool.query(
      `SELECT name FROM cc_user_statuses WHERE is_active = true AND user_selectable = true ORDER BY display_order ASC, name ASC`
    );
    return result.rows.map((row) => row.name);
  } catch (error) {
    console.error("[Profile] Error fetching allowed statuses:", error);
    // Fallback to default statuses
    return ["Available", "Busy", "Away", "Offline"];
  }
}

async function getStatusMetaByName(statusName) {
  try {
    const pool = getPostgresPool();
    if (!pool) return null;
    const result = await pool.query(
      `SELECT name, user_selectable FROM cc_user_statuses WHERE is_active = true AND name = $1 LIMIT 1`,
      [statusName]
    );
    return result.rows?.[0] || null;
  } catch (error) {
    console.error("[Profile] Error fetching status meta:", error);
    return null;
  }
}

/**
 * GET /api/user/profile
 * Get current user profile data
 */
export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "User not found" },
        { status: 404 }
      );
    }

    // Return relevant user data (exclude sensitive fields like hash, salt)
    // Use original Next.js format - snake_case for database fields
    const userData = {
      id: user.id,
      username: user.username,
      first_name: user.first_name,
      last_name: user.last_name,
      nick: user.nick,
      mobile: user.mobile,
      voice_number: user.voice_number,
      sms_number: user.sms_number,
      voice_app_id: user.voice_app_id,
      roles: user.roles || ["agent"],
      theme: user.theme,
      status: user.status,
      language: user.language,
      profile_picture_uri: user.profile_picture_uri,
      setup_completed: user.setup_completed,
    };

    return NextResponse.json({ ok: true, data: userData });
  } catch (err) {
    console.error("[USER] Profile GET error", err);
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}

export async function PUT(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const userId = user.id;

    let payload = {};
    try {
      const body = await request.json();
      // Handle both direct payload and nested data object (for mobile compatibility)
      if (body?.data && typeof body.data === "object") {
        payload = body.data;
      } else if (body && typeof body === "object") {
        payload = body;
      }
    } catch (_) {}

    const update = {};

    // Theme
    if (
      typeof payload.theme === "string" &&
      ALLOWED_THEMES.includes(payload.theme)
    ) {
      update.theme = payload.theme;
    }

    // Status - validate against allowed statuses from database
    if (typeof payload.status === "string" && payload.status.trim()) {
      const trimmedStatus = payload.status.trim();
      const allowSystemStatus = payload.system === true;
      const allowedStatuses = await getAllowedStatuses();
      if (allowedStatuses.includes(trimmedStatus)) {
        update.status = trimmedStatus;
      } else if (allowSystemStatus) {
        const meta = await getStatusMetaByName(trimmedStatus);
        if (meta?.name) {
          update.status = trimmedStatus;
        }
      }
    }

    // User profile fields
    if (typeof payload.firstName === "string") {
      update.firstName = payload.firstName.trim();
    }
    if (typeof payload.lastName === "string") {
      update.lastName = payload.lastName.trim();
    }
    if (typeof payload.nick === "string") {
      update.nick = payload.nick.trim();
    }
    if (typeof payload.mobile === "string") {
      update.mobile = payload.mobile.trim();
    }
    if (typeof payload.smsNumber === "string") {
      update.smsNumber = payload.smsNumber.trim();
    }
    if (typeof payload.voiceNumber === "string") {
      update.voiceNumber = payload.voiceNumber.trim();
    }
    if (typeof payload.language === "string") {
      update.language = payload.language.trim();
    }
    if (typeof payload.profilePictureUri === "string") {
      update.profilePictureUri = payload.profilePictureUri.trim();
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { ok: false, error: "No valid fields to update" },
        { status: 400 }
      );
    }

    await PgDb.updateUserById(String(userId), update);

    // If status was updated, also update agent_status and state manager
    if (update.status) {
      const previousStatus = user.status || user.agent_status || "Unknown";
      const sseKey = `user:status:${userId}`;
      console.log("[Profile] Status update requested:", {
        userId: String(userId),
        username: user.username,
        previousStatus,
        status: update.status,
        timestamp: new Date().toISOString(),
      });

      // Update agent_status to match status for contact center
      try {
        const { getPostgresPool } = await import("@/lib/postgres.mjs");
        const pool = getPostgresPool();
        if (pool) {
          await pool.query(
            `UPDATE users SET agent_status = $1, updated_at = NOW() WHERE id = $2`,
            [update.status, userId]
          );
          // Also update cc_agent_state table
          await pool.query(
            `INSERT INTO cc_agent_state (user_id, username, agent_status, last_status_change, last_activity)
             VALUES ($1, $2, $3, NOW(), NOW())
             ON CONFLICT (user_id) DO UPDATE SET
               agent_status = EXCLUDED.agent_status,
               last_status_change = NOW(),
               last_activity = NOW()`,
            [userId, user.username, update.status]
          );
        }

        // Update state manager
        const { updateAgentStatus } = await import(
          "@/lib/contact-center/state-manager"
        );
        updateAgentStatus(userId, update.status, user.username);

        if (["Available", "Busy"].includes(update.status)) {
          try {
            console.log("[Profile] Offering queued call after status update:", {
              userId: String(userId),
              username: user.username,
              status: update.status,
            });
            await offerQueuedCallForAgent({ userId: String(userId) });
          } catch (offerError) {
            console.error(
              "[Profile] Failed to offer queued calls after status update:",
              offerError
            );
          }
        }

        // Broadcast to monitor streams
        try {
          const { broadcastToKey } = await import("@/lib/sse");
          // Broadcast to all monitor streams
          const { getPostgresPool: getPool } = await import(
            "@/lib/postgres.mjs"
          );
          const monitorPool = getPool();
          if (monitorPool) {
            const supervisors = await monitorPool.query(
              `SELECT id FROM users WHERE 'supervisor' = ANY(roles) OR 'admin' = ANY(roles) OR 'owner' = ANY(roles)`
            );
            for (const supervisor of supervisors.rows || []) {
              await broadcastToKey(
                `monitor:${supervisor.id}`,
                {
                  type: "status_changed",
                  status: update.status,
                  userId: String(userId),
                  username: user.username,
                  timestamp: new Date().toISOString(),
                },
                "status_changed"
              );
            }
          }
        } catch (monitorError) {
          console.error(
            "[Status] Failed to broadcast to monitors:",
            monitorError
          );
        }
      } catch (stateError) {
        console.error("[Status] Failed to update agent status:", stateError);
      }

      // Log status change activity
      try {
        // Find the last status change activity to calculate duration
        const lastStatusActivity = await PgDb.getUserActivityLog(
          String(userId),
          {
            activityType: "status_change",
            pageSize: 1,
          }
        );

        let previousActivityStartedAt = null;
        if (lastStatusActivity.rows.length > 0) {
          const lastActivity = lastStatusActivity.rows[0];
          if (
            lastActivity.activity_value === previousStatus &&
            lastActivity.started_at
          ) {
            previousActivityStartedAt = lastActivity.started_at;
          }
        }

        // Log the status change
        await PgDb.logUserActivity({
          userId: String(userId),
          activityType: "status_change",
          activityValue: update.status,
          previousValue: previousStatus,
          startedAt: previousActivityStartedAt || new Date().toISOString(),
          endedAt: new Date().toISOString(),
        });
      } catch (activityError) {
        console.error("[Status] Failed to log activity:", activityError);
        // Don't fail the request if activity logging fails
      }

      // Broadcast to web clients via SSE
      try {
        await broadcastToKey(
          sseKey,
          {
            type: "status_changed",
            status: update.status,
            userId: String(userId),
            username: user.username,
            timestamp: new Date().toISOString(),
          },
          "status_changed" // Event type for SSE
        );
        console.log(
          `[Status] SSE broadcast sent to ${user.username} for status: ${update.status}`
        );
      } catch (sseError) {
        console.error("[Status] Failed to broadcast via SSE:", sseError);
        // Don't fail the request if SSE fails
      }

      // Also broadcast to contact center stream
      try {
        await broadcastToKey(`contact-center:agent:${user.username}`, {
          type: "status_changed",
          status: update.status,
          previousStatus: previousStatus,
        });
      } catch (ccError) {
        console.error(
          "[Status] Failed to broadcast to contact center stream:",
          ccError
        );
        // Don't fail the request if this fails
      }

      // Push notifications are not used in contact center project
    }

    return NextResponse.json({
      ok: true,
      message: "User profile updated successfully",
    });
  } catch (err) {
    console.error("[USER] Profile PUT error", err);
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}
