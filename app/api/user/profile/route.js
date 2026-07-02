import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { setUserStatus } from "@/lib/contact-center/user-status";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

const ALLOWED_THEMES = ["light", "dark", "system"];

// Get allowed statuses from database
async function getAllowedStatuses() {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      // Fallback to default statuses if DB not available (Offline is not user-selectable)
      return ["Available", "Busy", "Away"];
    }
    const result = await pool.query(
      `SELECT name FROM cc_user_statuses WHERE is_active = true AND user_selectable = true ORDER BY display_order ASC, name ASC`,
    );
    return result.rows.map((row) => row.name);
  } catch (error) {
    // Fallback to default statuses (Offline is not user-selectable)
    return ["Available", "Busy", "Away"];
  }
}

async function getStatusMetaByName(statusName) {
  try {
    const pool = getPostgresPool();
    if (!pool) return null;
    const result = await pool.query(
      `SELECT name, user_selectable FROM cc_user_statuses WHERE is_active = true AND name = $1 LIMIT 1`,
      [statusName],
    );
    return result.rows?.[0] || null;
  } catch (error) {
    return null;
  }
}

async function getCurrentAgentStatus(userId) {
  try {
    const pool = getPostgresPool();
    if (!pool || !userId) return "Unknown";
    const result = await pool.query(
      `SELECT agent_status FROM cc_agent_state WHERE user_id = $1`,
      [String(userId)],
    );
    return result.rows?.[0]?.agent_status || "Unknown";
  } catch (error) {
    return "Unknown";
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
        { status: 401 },
      );
    }
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "User not found" },
        { status: 404 },
      );
    }

    const agentStatus = await getCurrentAgentStatus(user.id);

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
      telephony_user_name: user.telephony_user_name,
      roles: user.roles || ["agent"],
      theme: user.theme,
      status: agentStatus,
      language: user.language,
      profile_picture_uri: user.profile_picture_uri,
      setup_completed: user.setup_completed,
    };

    return NextResponse.json({ ok: true, data: userData });
  } catch (err) {
    platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 },
    );
  }
}

export async function PUT(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    const userId = String(user.id);

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
    let requestedStatus = null;

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
        requestedStatus = trimmedStatus;
      } else if (allowSystemStatus) {
        const meta = await getStatusMetaByName(trimmedStatus);
        if (meta?.name) {
          requestedStatus = trimmedStatus;
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

    if (Object.keys(update).length === 0 && !requestedStatus) {
      return NextResponse.json(
        { ok: false, error: "No valid fields to update" },
        { status: 400 },
      );
    }

    if (Object.keys(update).length > 0) {
      await PgDb.updateUserById(userId, update);
    }

    let effectiveStatus = null;
    if (requestedStatus) {
      const previousStatus = await getCurrentAgentStatus(userId);
      effectiveStatus = await setUserStatus({
        userId,
        username: user.username,
        status: requestedStatus,
        previousStatus,
      });
    }

    return NextResponse.json({
      ok: true,
      message: "User profile updated successfully",
      status:
        effectiveStatus ||
        (requestedStatus ? await getCurrentAgentStatus(userId) : undefined),
    });
  } catch (err) {
    platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/user/profile
 * Handle profile updates (used by sendBeacon which always sends POST)
 * Delegates to the same DB-authoritative status writer as PUT.
 */
export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 },
      );
    }

    let payload = {};
    try {
      // Handle sendBeacon (sends Blob) and regular JSON
      const contentType = request.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const body = await request.json();
        if (body?.data && typeof body.data === "object") {
          payload = body.data;
        } else if (body && typeof body === "object") {
          payload = body;
        }
      } else {
        const text = await request.text();
        try {
          payload = JSON.parse(text);
        } catch (_) {
          const jsonMatch = text.match(/\{.*\}/);
          if (jsonMatch) {
            payload = JSON.parse(jsonMatch[0]);
          }
        }
      }
    } catch (_) {}

    let requestedStatus = null;
    if (typeof payload.status === "string" && payload.status.trim()) {
      const trimmedStatus = payload.status.trim();
      const allowSystemStatus = payload.system === true;
      const allowedStatuses = await getAllowedStatuses();
      if (allowedStatuses.includes(trimmedStatus)) {
        requestedStatus = trimmedStatus;
      } else if (allowSystemStatus) {
        const meta = await getStatusMetaByName(trimmedStatus);
        if (meta?.name) {
          requestedStatus = trimmedStatus;
        }
      }
    }

    if (!requestedStatus) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const previousStatus = await getCurrentAgentStatus(user.id);
    await setUserStatus({
      userId: String(user.id),
      username: user.username,
      status: requestedStatus,
      previousStatus,
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 },
    );
  }
}
