import { NextResponse } from "next/server";
import { randomBytes, pbkdf2Sync } from "crypto";

export async function GET(request, { params }) {
  try {
    const resolvedParams = await params;
    const token = resolvedParams?.token;
    if (!token) {
      return NextResponse.json({ valid: false, reason: "not_found" });
    }

    const { getPostgresPool } = await import("@/lib/postgres.mjs");
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { valid: false, reason: "server_error" },
        { status: 500 }
      );
    }

    const result = await pool.query(
      "SELECT id, first_name, last_name, username, invite_status, invite_token_expires FROM users WHERE invite_token=$1 LIMIT 1",
      [token]
    );

    const user = result.rows?.[0];

    if (!user) {
      return NextResponse.json({ valid: false, reason: "not_found" });
    }

    if (user.invite_status === "accepted") {
      return NextResponse.json({ valid: false, reason: "already_accepted" });
    }

    if (
      user.invite_token_expires &&
      new Date(user.invite_token_expires) < new Date()
    ) {
      return NextResponse.json({ valid: false, reason: "expired" });
    }

    return NextResponse.json({
      valid: true,
      user: {
        firstName: user.first_name,
        lastName: user.last_name,
        email: user.username,
      },
    });
  } catch (error) {
    console.error("[Invite GET] Error:", error);
    return NextResponse.json(
      { valid: false, reason: "server_error" },
      { status: 500 }
    );
  }
}

export async function POST(request, { params }) {
  try {
    const resolvedParams = await params;
    const token = resolvedParams?.token;
    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Invalid token" },
        { status: 400 }
      );
    }

    const body = await request.json();
    const { password } = body;

    if (!password) {
      return NextResponse.json(
        { ok: false, error: "Password is required" },
        { status: 400 }
      );
    }

    // Validate password strength
    const strong =
      password.length >= 8 &&
      /[a-z]/.test(password) &&
      /[A-Z]/.test(password) &&
      /[0-9]/.test(password) &&
      /[^A-Za-z0-9]/.test(password);

    if (!strong) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Password must be at least 8 characters with uppercase, lowercase, number and special character",
        },
        { status: 400 }
      );
    }

    const { getPostgresPool } = await import("@/lib/postgres.mjs");
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    const result = await pool.query(
      "SELECT id, invite_status, invite_token_expires FROM users WHERE invite_token=$1 LIMIT 1",
      [token]
    );

    const user = result.rows?.[0];

    if (!user) {
      return NextResponse.json(
        { ok: false, error: "Invalid or expired invitation link" },
        { status: 400 }
      );
    }

    if (user.invite_status === "accepted") {
      return NextResponse.json(
        { ok: false, error: "This invitation has already been used" },
        { status: 400 }
      );
    }

    if (
      user.invite_token_expires &&
      new Date(user.invite_token_expires) < new Date()
    ) {
      return NextResponse.json(
        { ok: false, error: "This invitation has expired" },
        { status: 400 }
      );
    }

    // Hash password using pbkdf2 (same pattern as reset-password)
    const salt = randomBytes(32).toString("hex");
    const hash = pbkdf2Sync(password, salt, 25000, 64, "sha256").toString(
      "hex"
    );

    // Update user: set password, accept invite, activate, verify email
    await pool.query(
      `UPDATE users SET
        hash=$1,
        salt=$2,
        iterations=$3,
        invite_status='accepted',
        invite_accepted_at=NOW(),
        invite_token=NULL,
        invite_token_expires=NULL,
        verified=true,
        active=true,
        updated_at=NOW()
      WHERE id=$4`,
      [hash, salt, 25000, user.id]
    );

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[Invite POST] Error:", error);
    return NextResponse.json(
      { ok: false, error: "Server error" },
      { status: 500 }
    );
  }
}
