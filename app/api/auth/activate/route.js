import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";

export async function POST(request) {
  try {
    const body = await request.json();
    const { token } = body;

    if (!token) {
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
      return NextResponse.json(
        { success: false, error: "Invalid activation token" },
        { status: 400 }
      );
    }

    // Check if already verified
    if (user.verified) {
      return NextResponse.json({
        success: true,
        alreadyActivated: true,
        message: "Account already activated",
      });
    }

    // Check if token has expired
    const tokenExpires = new Date(user.activation_token_expires);
    if (tokenExpires < new Date()) {
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

    return NextResponse.json({
      success: true,
      message: "Account activated successfully",
    });
  } catch (error) {
    console.error("[Account Activation] Error:", error);
    return NextResponse.json(
      { success: false, error: "Server error" },
      { status: 500 }
    );
  }
}
