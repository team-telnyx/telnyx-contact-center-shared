import { NextResponse } from "next/server";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { authLogger, securityErrorPayload, securityUserPayload } from "@/lib/security-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(request, _context, authz) {
  try {
    const user = await PgDb.findUserById(String(authz.user.id));
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Check if user has password set (credentials auth enabled)
    const hasPassword = Boolean(user.hash && user.salt);

    // Check if user has OAuth accounts linked
    const pool = getPostgresPool();

    // Find auth_users record by email
    const authUserResult = await pool.query(
      "SELECT id FROM auth_users WHERE email=$1 LIMIT 1",
      [user.username]
    );
    const authUser = authUserResult.rows?.[0];

    let hasGoogle = false;
    let hasGithub = false;
    let hasFacebook = false;

    if (authUser) {
      // Check for linked OAuth accounts
      const accountsResult = await pool.query(
        "SELECT provider FROM auth_accounts WHERE user_id=$1",
        [authUser.id]
      );

      const providers = accountsResult.rows.map((row) => row.provider);
      hasGoogle = providers.includes("google");
      hasGithub = providers.includes("github");
      hasFacebook = providers.includes("facebook");
    }

    return NextResponse.json({
      authStrategy: user.auth_strategy || "local",
      hasPassword,
      hasGoogle,
      hasGithub,
      hasFacebook,
    });
  } catch (error) {
    authLogger.error("auth_methods_load_failed", { ...securityErrorPayload(error), ...securityUserPayload(null, authz.user?.username) });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("authenticated", GET_handler, { route: "/api/user/auth-methods" });
