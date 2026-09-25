import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readAgentStatusPresentation, setManualAgentStatus } from "@/lib/acd/agent-state.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

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

async function getCurrentAgentStatus(userId) {
  try {
    const pool = getPostgresPool();
    if (!pool || !userId) return { status: "Unknown", pendingStatus: null, pendingSince: null };
    return await readAgentStatusPresentation(pool, String(userId), "Offline");
  } catch (error) {
    return { status: "Unknown", pendingStatus: null, pendingSince: null };
  }
}

/**
 * GET /api/user/profile
 * Get current user profile data
 */
async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;
    if (!user) {
      return NextResponse.json(
        { ok: false, error: "User not found" },
        { status: 404 },
      );
    }

    const agentStatus = await getCurrentAgentStatus(user.id);
    const voicePolicy = (await getPostgresPool().query(
      "SELECT enabled FROM cc_agent_channel_policies WHERE agent_id=$1 AND channel='voice'",[String(user.id)])).rows[0];

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
      status: agentStatus.status,
      // Manual status waiting to apply once the agent's current interactions end.
      pending_status: agentStatus.pendingStatus,
      pending_since: agentStatus.pendingSince,
      agent_state_version: agentStatus.version,
      voice_enabled: voicePolicy?.enabled !== false,
      language: user.language,
      profile_picture_uri: user.profile_picture_uri,
      setup_completed: user.setup_completed,
      experimental_features: user.experimental_features === true,
    };

    return NextResponse.json({ ok: true, data: userData });
  } catch (err) {
    platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    // Domain rejections carry their own status code and a message meant for the agent.
    return NextResponse.json(
      { ok: false, error: err?.status ? err.message : "Server error" },
      { status: err?.status || 500 },
    );
  }
}

async function PUT_handler(request, _context, authz) {
  try {
    const user = authz.user;

    const userId = String(user.id);
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 503 },
      );
    }

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
      const allowedStatuses = await getAllowedStatuses();
      if (allowedStatuses.includes(trimmedStatus)) {
        requestedStatus = trimmedStatus;
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

    if (requestedStatus && payload.expectedVersion == null) return NextResponse.json({error:"Refresh your status before changing it."},{status:428});
    if (Object.keys(update).length > 0) {
      await PgDb.updateUserById(userId, update);
    }

    let presentation = null;
    if (requestedStatus) {
      await setManualAgentStatus(pool, {
        agentId: userId,
        status: requestedStatus,
        actor: `agent:${userId}`,
        expectedVersion: payload.expectedVersion ?? null,
      });
      presentation = await getCurrentAgentStatus(userId);
    }

    return NextResponse.json({
      ok: true,
      message: "User profile updated successfully",
      status: presentation?.status,
      pendingStatus: presentation?.pendingStatus ?? null,
      pendingSince: presentation?.pendingSince ?? null,
      version: presentation?.version ?? null,
    });
  } catch (err) {
    platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    // Domain rejections carry their own status code and a message meant for the agent.
    return NextResponse.json(
      { ok: false, error: err?.status ? err.message : "Server error" },
      { status: err?.status || 500 },
    );
  }
}

/**
 * POST /api/user/profile
 * Handle profile updates (used by sendBeacon which always sends POST)
 * Delegates to the same DB-authoritative status writer as PUT.
 */
async function POST_handler(request, _context, authz) {
  try {
    const user = authz.user;

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
      const allowedStatuses = await getAllowedStatuses();
      if (allowedStatuses.includes(trimmedStatus)) {
        requestedStatus = trimmedStatus;
      }
    }

    if (!requestedStatus) {
      return NextResponse.json({ ok: true }, { status: 200 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 503 },
      );
    }
    if (payload.expectedVersion == null) return NextResponse.json({error:"Refresh your status before changing it."},{status:428});
    await setManualAgentStatus(pool, {
      agentId: String(user.id),
      status: requestedStatus,
      actor: `agent:${user.id}`,
      expectedVersion: payload.expectedVersion ?? null,
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    platformApiLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    // Domain rejections carry their own status code and a message meant for the agent.
    return NextResponse.json(
      { ok: false, error: err?.status ? err.message : "Server error" },
      { status: err?.status || 500 },
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("authenticated", GET_handler, { route: "/api/user/profile" });
export const PUT = withPermission("authenticated", PUT_handler, { route: "/api/user/profile" });
export const POST = withPermission("authenticated", POST_handler, { route: "/api/user/profile" });
