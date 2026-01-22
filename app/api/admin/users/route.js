import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";

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
      `(username ILIKE $${i} OR first_name ILIKE $${i} OR last_name ILIKE $${i} OR nick ILIKE $${i} OR mobile ILIKE $${i})`
    );
    vals.push(`%${q}%`);
    i += 1;
  }
  if (username) {
    where.push(`username ILIKE $${i}`);
    vals.push(`%${username}%`);
    i += 1;
  }
  if (role && role !== "all") {
    // Check roles array only
    where.push(`$${i} = ANY(roles)`);
    vals.push(role);
    i += 1;
  }
  if (status) {
    where.push(`status=$${i}`);
    vals.push(status);
    i += 1;
  }
  if (verified === "true" || verified === "false") {
    where.push(`verified=$${i}`);
    vals.push(verified === "true");
    i += 1;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rowsSql = `SELECT id, username, first_name, last_name, nick, mobile, roles, verified, status, created_at, updated_at FROM users ${whereSql} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`;
  const [rowsRes, countRes] = await Promise.all([
    pool.query(rowsSql, vals),
    pool.query(`SELECT COUNT(*) AS c FROM users ${whereSql}`, vals),
  ]);
  return NextResponse.json({
    rows: rowsRes.rows || [],
    count: Number(countRes.rows?.[0]?.c || 0),
  });
}

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json();
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
