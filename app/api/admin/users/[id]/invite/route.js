import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { randomBytes } from "crypto";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

async function requireAdmin() {
  const session = await getServerSession(authOptions);
  const id = session?.user?.id || null;
  const email = session?.user?.email || null;
  if (!id && !email) return null;
  let user = null;
  if (id) user = await PgDb.findUserById(id);
  if (!user && email) user = await PgDb.findUserByUsername(email);
  if (!user) return null;
  if (!isAdmin(user)) return null;
  return user;
}

export async function POST(request, { params }) {
  const adminUser = await requireAdmin();
  if (!adminUser)
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id)
    return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  // Fetch the target user
  const userResult = await pool.query(
    "SELECT id, username, first_name, last_name, invite_status FROM users WHERE id=$1 LIMIT 1",
    [id]
  );
  const targetUser = userResult.rows?.[0];
  if (!targetUser)
    return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Generate invite token
  const inviteToken = randomBytes(32).toString("hex");
  const inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const sentAt = new Date();

  // Update user with invite token
  await pool.query(
    `UPDATE users SET
      invite_token=$1,
      invite_token_expires=$2,
      invite_sent_at=$3,
      invite_status='pending',
      updated_at=NOW()
    WHERE id=$4`,
    [inviteToken, inviteExpires.toISOString(), sentAt.toISOString(), id]
  );

  // Send invite email
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  const inviteUrl = `${baseUrl}/set-password/${inviteToken}`;

  try {
    const { sendUserInviteEmail } = await import("@/lib/email-notifications.js");
    const emailResult = await sendUserInviteEmail(targetUser, inviteUrl);
    if (!emailResult.success) {
      adminRuntimeLogger.warn("runtime_warning", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    }
  } catch (emailError) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    // Don't fail the request if email fails - token is already set
  }

  return NextResponse.json({ ok: true, sentAt: sentAt.toISOString() });
}
