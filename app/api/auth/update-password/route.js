import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { verifyUserPassword } from "@/lib/auth";
import { randomBytes, pbkdf2Sync } from "crypto";
import { authErrorPayload, authUserPayload, logAuthEvent } from "@/lib/auth-logging.mjs";

export async function POST(request) {
  try {
    // Get session
    const session = await getServerSession(authOptions);
    logAuthEvent("info", "password_change_attempt", { email: session?.user?.email, source: "api" });
    if (!session?.user?.email) {
      logAuthEvent("warn", "password_change_failed", { reason: "unauthorized", source: "api" });
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const body = await request.json();
    const { currentPassword, newPassword } = body;

    // Find user
    const user = await PgDb.findUserByUsername(session.user.email);
    if (!user) {
      logAuthEvent("warn", "password_change_failed", { email: session.user.email, reason: "user_not_found", source: "api" });
      return NextResponse.json(
        { success: false, error: "User not found" },
        { status: 404 }
      );
    }

    // If user has a password (credentials auth), verify current password
    if (user.hash && user.salt) {
      if (!currentPassword) {
        logAuthEvent("warn", "password_change_failed", { ...authUserPayload(user, session.user.email), reason: "missing_current_password", source: "api" });
        return NextResponse.json(
          { success: false, error: "Current password is required" },
          { status: 400 }
        );
      }

      const isValid = verifyUserPassword(user, currentPassword);
      if (!isValid) {
        logAuthEvent("warn", "password_change_failed", { ...authUserPayload(user, session.user.email), reason: "invalid_current_password", source: "api" });
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
      logAuthEvent("warn", "password_change_failed", { ...authUserPayload(user, session.user.email), reason: "weak_password", source: "api" });
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

    logAuthEvent("info", "password_change_success", { ...authUserPayload(user, session.user.email), source: "api" });
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
