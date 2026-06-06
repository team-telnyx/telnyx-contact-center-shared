import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { randomBytes, pbkdf2Sync } from "crypto";

export async function POST(request) {
  try {
    const body = await request.json();
    const { token, password } = body;

    if (!token || !password) {
      return NextResponse.json(
        { success: false, error: "Missing required fields" },
        { status: 400 }
      );
    }

    // Validate password strength
    const strong =
      /[a-z]/.test(password) &&
      /[A-Z]/.test(password) &&
      /[^A-Za-z0-9]/.test(password) &&
      password.length >= 8;

    if (!strong) {
      return NextResponse.json(
        {
          success: false,
          error:
            "Password must be at least 8 characters with uppercase, lowercase, and special characters",
        },
        { status: 400 }
      );
    }

    // Find user by reset token
    const { getPostgresPool } = await import("@/lib/postgres.mjs");
    const pool = getPostgresPool();
    const result = await pool.query(
      "SELECT * FROM users WHERE reset_password_token=$1 LIMIT 1",
      [token]
    );

    const user = result.rows?.[0];

    if (!user) {
      return NextResponse.json(
        { success: false, error: "Invalid or expired reset token" },
        { status: 400 }
      );
    }

    // Check if token has expired
    const tokenExpires = new Date(user.reset_password_token_expires);
    if (tokenExpires < new Date()) {
      return NextResponse.json(
        { success: false, error: "Reset token has expired" },
        { status: 400 }
      );
    }

    // Hash new password
    const salt = randomBytes(32).toString("hex");
    const hash = pbkdf2Sync(password, salt, 25000, 64, "sha256").toString(
      "hex"
    );

    // Update user password and clear reset token
    await PgDb.updateUserById(user.id, {
      hash,
      salt,
      iterations: 25000,
      reset_password_token: null,
      reset_password_token_expires: null,
    });

    return NextResponse.json({
      success: true,
      message: "Password reset successful",
    });
  } catch (error) {
    console.error("[Reset Password] Error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 }
    );
  }
}
