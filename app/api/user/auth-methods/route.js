import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { PgDb } from "@/lib/pgdb";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { authLogger, securityErrorPayload, securityUserPayload } from "@/lib/security-logging.mjs";

export async function GET() {
  try {
    // Get session
    const session = await getServerSession(authOptions);
    if (!session?.user?.email) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Find user in users table
    const user = await PgDb.findUserByUsername(session.user.email);
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
      [session.user.email]
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
    authLogger.error("auth_methods_load_failed", { ...securityErrorPayload(error), ...securityUserPayload(null, session?.user?.email) });
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
