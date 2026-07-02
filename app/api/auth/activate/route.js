import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { authErrorPayload, authUserPayload, logAuthEvent, normalizeAuthEmail } from "@/lib/auth-logging.mjs";

export async function POST(request) {
  try {
    const body = await request.json();
    const { token } = body;
    logAuthEvent("info", "account_activation_attempt", { activationToken: "[REDACTED]", source: "api" });

    if (!token) {
      logAuthEvent("warn", "account_activation_failed", { reason: "missing_token", activationToken: "[REDACTED]", source: "api" });
      return NextResponse.json(
        { success: false, error: "Missing activation token" },
        { status: 400 }
      );
    }

    // Find user by activation token
    const { getPostgresPool } = await import("@/lib/postgres.mjs");
    const pool = getPostgresPool();
    const result = await pool.query(
      "SELECT * FROM users WHERE activation_token=$1 LIMIT 1",
      [token]
    );

    const user = result.rows?.[0];

    if (!user) {
      logAuthEvent("warn", "account_activation_failed", { reason: "invalid_token", activationToken: "[REDACTED]", source: "api" });
      return NextResponse.json(
        { success: false, error: "Invalid activation token" },
        { status: 400 }
      );
    }

    // Check if already verified
    if (user.verified) {
      logAuthEvent("info", "account_activation_success", { ...authUserPayload(user), alreadyActivated: true, source: "api" });
      return NextResponse.json({
        success: true,
        alreadyActivated: true,
        message: "Account already activated",
      });
    }

    // Check if token has expired
    const tokenExpires = new Date(user.activation_token_expires);
    if (tokenExpires < new Date()) {
      logAuthEvent("warn", "account_activation_failed", { ...authUserPayload(user), reason: "expired_token", activationToken: "[REDACTED]", source: "api" });
      return NextResponse.json(
        { success: false, error: "Activation token has expired" },
        { status: 400 }
      );
    }

    // Activate user account
    await PgDb.updateUserById(user.id, {
      verified: true,
      activation_token: null,
      activation_token_expires: null,
    });

    logAuthEvent("info", "account_activation_success", { ...authUserPayload(user), source: "api" });
    return NextResponse.json({
      success: true,
      message: "Account activated successfully",
    });
  } catch (error) {
    logAuthEvent("error", "account_activation_failed", { reason: "server_error", source: "api", ...authErrorPayload(error) });
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 }
    );
  }
}
