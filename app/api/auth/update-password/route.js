import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { verifyUserPassword } from "@/lib/auth";
import { randomBytes, pbkdf2Sync } from "crypto";
import { authErrorPayload, authUserPayload, logAuthEvent } from "@/lib/auth-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

async function POST_handler(request, _context, authz) {
  try {
    const email = authz.user.username;
    logAuthEvent("info", "password_change_attempt", { email, source: "api" });
    const body = await request.json();
    const { currentPassword, newPassword } = body;

    if (typeof newPassword !== "string" || (currentPassword != null && typeof currentPassword !== "string")) {
      return NextResponse.json({ success: false, error: "Invalid password fields" }, { status: 400 });
    }

    // Find user
    const user = await PgDb.findUserById(String(authz.user.id));
    if (!user) {
      logAuthEvent("warn", "password_change_failed", { email: email, reason: "user_not_found", source: "api" });
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    // If user has a password (credentials auth), verify current password
    if (user.hash && user.salt) {
      if (!currentPassword) {
        logAuthEvent("warn", "password_change_failed", { ...authUserPayload(user, email), reason: "missing_current_password", source: "api" });
        return NextResponse.json(
          { success: false, error: "Current password is required" },
          { status: 400 }
        );
      }

      const isValid = verifyUserPassword(user, currentPassword);
      if (!isValid) {
        logAuthEvent("warn", "password_change_failed", { ...authUserPayload(user, email), reason: "invalid_current_password", source: "api" });
        return NextResponse.json(
          { success: false, error: "Current password is incorrect" },
          { status: 400 }
        );
      }
    }

    // Validate new password strength
    const strong =
      /[a-z]/.test(newPassword) &&
      /[A-Z]/.test(newPassword) &&
      /[^A-Za-z0-9]/.test(newPassword) &&
      newPassword.length >= 8;

    if (!strong) {
      logAuthEvent("warn", "password_change_failed", { ...authUserPayload(user, email), reason: "weak_password", source: "api" });
      return NextResponse.json(
        {
          success: false,
          error:
            "Password must be at least 8 characters with uppercase, lowercase, and special characters",
        },
        { status: 400 }
      );
    }

    // Hash new password
    const salt = randomBytes(32).toString("hex");
    const hash = pbkdf2Sync(newPassword, salt, 25000, 64, "sha256").toString(
      "hex"
    );

    // Update user password
    await PgDb.updateUserById(user.id, {
      hash,
      salt,
      iterations: 25000,
    });

    logAuthEvent("info", "password_change_success", { ...authUserPayload(user, email), source: "api" });
    return NextResponse.json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    logAuthEvent("error", "password_change_failed", { reason: "server_error", source: "api", ...authErrorPayload(error) });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("authenticated", POST_handler, { route: "/api/auth/update-password" });
