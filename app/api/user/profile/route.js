import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { USER_STATUS_OPTIONS } from "@/config/user";
import { broadcastToKey } from "@/lib/sse";

const ALLOWED_THEMES = ["light", "dark", "system"];
const ALLOWED_STATUSES = USER_STATUS_OPTIONS.map((opt) => opt.value);

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
      role: user.role,
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

    // Status - validate against allowed statuses
    if (typeof payload.status === "string" && payload.status.trim()) {
      const trimmedStatus = payload.status.trim();
      if (ALLOWED_STATUSES.includes(trimmedStatus)) {
        update.status = trimmedStatus;
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

    // If status was updated, broadcast to web clients via SSE and send push to mobile
    if (update.status) {
      const sseKey = `user:status:${userId}`;

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
          previousStatus: user.status,
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
