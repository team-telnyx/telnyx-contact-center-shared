export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { randomUUID, randomBytes } from "crypto";

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

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ rows: [], count: 0 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, Number(searchParams.get("page") || 1));
  const pageSize = Math.min(
    100,
    Math.max(1, Number(searchParams.get("pageSize") || 20))
  );
  const offset = (page - 1) * pageSize;

  const where = [];
  const vals = [];
  let i = 1;
  const q = searchParams.get("q");
  const username = searchParams.get("username");
  const role = searchParams.get("role");
  const verified = searchParams.get("verified");
  const status = searchParams.get("status");

  if (q) {
    where.push(
      `(u.username ILIKE $${i} OR u.first_name ILIKE $${i} OR u.last_name ILIKE $${i} OR u.nick ILIKE $${i} OR u.mobile ILIKE $${i})`
    );
    vals.push(`%${q}%`);
    i += 1;
  }
  if (username) {
    where.push(`u.username ILIKE $${i}`);
    vals.push(`%${username}%`);
    i += 1;
  }
  if (role && role !== "all") {
    // Check roles array only
    where.push(`$${i} = ANY(u.roles)`);
    vals.push(role);
    i += 1;
  }
  if (status) {
    where.push(`s.agent_status=$${i}`);
    vals.push(status);
    i += 1;
  }
  if (verified === "true" || verified === "false") {
    where.push(`u.verified=$${i}`);
    vals.push(verified === "true");
    i += 1;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const fromSql = `FROM users u LEFT JOIN cc_agent_state s ON s.user_id = u.id`;
  const rowsSql = `SELECT u.id, u.username, u.first_name, u.last_name, u.nick, u.mobile, u.roles, u.verified, s.agent_status AS status, u.skills, u.created_at, u.updated_at ${fromSql} ${whereSql} ORDER BY u.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
  const [rowsRes, countRes] = await Promise.all([
    pool.query(rowsSql, vals),
    pool.query(`SELECT COUNT(*) AS c ${fromSql} ${whereSql}`, vals),
  ]);
  return NextResponse.json({
    rows: rowsRes.rows || [],
    count: Number(countRes.rows?.[0]?.c || 0),
  });
}

export async function POST(request) {
  const adminUser = await requireAdmin();
  if (!adminUser) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json();

  // If creating a new user (has firstName/lastName) vs legacy upsert
  const isCreateUser = body.firstName !== undefined || body.lastName !== undefined;

  if (isCreateUser) {
    // New user creation flow
    const username = String(body.username || "").trim();
    const firstName = String(body.firstName || "").trim();
    const lastName = String(body.lastName || "").trim();
    const role = body.role || "agent";
    const roles = body.roles || [role];
    const nick = body.nick || null;
    const mobile = body.mobile || null;
    const sendInvite = Boolean(body.sendInvite !== false); // default true

    if (!username) {
      return NextResponse.json({ error: "Email (username) is required" }, { status: 400 });
    }
    if (!firstName) {
      return NextResponse.json({ error: "First name is required" }, { status: 400 });
    }
    if (!lastName) {
      return NextResponse.json({ error: "Last name is required" }, { status: 400 });
    }

    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json({ error: "Server not ready" }, { status: 500 });
    }

    // Validate email domain against allowed domains
    const emailDomain = username.split("@")[1]?.toLowerCase();
    if (!emailDomain) {
      return NextResponse.json({ error: "Invalid email address" }, { status: 400 });
    }
    const allowedDomains = await pool.query(
      "SELECT domain FROM domains WHERE active=true ORDER BY domain"
    );
    if (allowedDomains.rows.length > 0) {
      const domainList = allowedDomains.rows.map((r) => r.domain.toLowerCase());
      if (!domainList.includes(emailDomain)) {
        return NextResponse.json(
          { error: `Email domain "@${emailDomain}" is not allowed. Allowed domains: ${domainList.map((d) => "@" + d).join(", ")}` },
          { status: 422 }
        );
      }
    }

    // Check if username already exists
    const existing = await pool.query(
      "SELECT id FROM users WHERE username=$1 LIMIT 1",
      [username]
    );
    if (existing.rows?.length > 0) {
      return NextResponse.json(
        { error: "A user with this email already exists" },
        { status: 409 }
      );
    }

    const id = randomUUID();
    let inviteToken = null;
    let inviteExpires = null;
    let inviteSentAt = null;
    let inviteStatus = "none";

    if (sendInvite) {
      inviteToken = randomBytes(32).toString("hex");
      inviteExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      inviteSentAt = new Date();
      inviteStatus = "pending";
    }

    // Insert new user (no password)
    await pool.query(
      `INSERT INTO users (
        id, username, first_name, last_name, nick, mobile, roles,
        active, verified, auth_strategy, language, theme,
        invite_token, invite_token_expires, invite_sent_at, invite_status,
        skills, agent_groups, preferred_languages,
        created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        false, false, 'local', 'en-US', 'system',
        $8, $9, $10, $11,
        '{}', '{}', ARRAY['en-US']::TEXT[],
        NOW(), NOW()
      )`,
      [
        id, username, firstName, lastName, nick, mobile,
        Array.isArray(roles) ? roles : [roles],
        inviteToken, inviteExpires, inviteSentAt, inviteStatus,
      ]
    );

    const { ensureAgentStatusState } = await import(
      "@/lib/contact-center/user-status"
    );
    await ensureAgentStatusState({
      userId: id,
      username,
      status: "Available",
    });

    // Send invite email if requested
    if (sendInvite && inviteToken) {
      const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
      const inviteUrl = `${baseUrl}/set-password/${inviteToken}`;
      try {
        const { sendUserInviteEmail } = await import("@/lib/email-notifications.js");
        await sendUserInviteEmail(
          { first_name: firstName, last_name: lastName, username },
          inviteUrl
        );
      } catch (emailError) {
        console.error("[CreateUser] Failed to send invite email:", emailError);
        // Don't fail - user was created
      }
    }

    const newUser = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
    return NextResponse.json({ ok: true, user: newUser.rows?.[0] }, { status: 201 });
  }

  // Legacy upsert flow (backwards compatible)
  const username = String(body.username || "").trim();
  if (!username)
    return NextResponse.json({ error: "username required" }, { status: 400 });

  const fields = {
    firstName: body.firstName || null,
    lastName: body.lastName || null,
    nick: body.nick || null,
    language: body.language || "en-US",
    status: body.status || "Available",
    theme: body.theme || "system",
    mobile: body.mobile || null,
    smsNumber: body.smsNumber || "Telnyx",
    voiceNumber: body.voiceNumber || null,
    roles: body.roles || ["agent"], // Roles array
    verified: Boolean(body.verified),
    authStrategy: body.authStrategy || "local",
    telephonyCredentialsId: body.telephonyCredentialsId || null,
    telephonyUserName: body.telephonyUserName || null,
    profilePictureUri: body.profilePictureUri || null,
  };

  try {
    const id = await PgDb.upsertUserByUsername(username, fields);
    return NextResponse.json({ ok: true, id });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
