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

export async function GET(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const r = await pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
  if (!r.rows?.[0])
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(r.rows[0]);
}

export async function PUT(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const body = await request.json();

  const set = {};
  const maybeSet = (key, val) => {
    if (val !== undefined) set[key] = val;
  };

  maybeSet(
    "username",
    body.username != null ? String(body.username).trim() : undefined
  );
  maybeSet(
    "firstName",
    body.firstName != null ? String(body.firstName) : undefined
  );
  maybeSet(
    "lastName",
    body.lastName != null ? String(body.lastName) : undefined
  );
  maybeSet("nick", body.nick != null ? String(body.nick) : undefined);
  maybeSet(
    "language",
    body.language != null ? String(body.language) : undefined
  );
  maybeSet("status", body.status != null ? String(body.status) : undefined);
  maybeSet("theme", body.theme != null ? String(body.theme) : undefined);
  maybeSet("mobile", body.mobile != null ? String(body.mobile) : undefined);
  maybeSet(
    "smsNumber",
    body.smsNumber != null ? String(body.smsNumber) : undefined
  );
  maybeSet(
    "voiceNumber",
    body.voiceNumber != null ? String(body.voiceNumber) : undefined
  );
  if (body.roles !== undefined) {
    set.roles = Array.isArray(body.roles) ? body.roles : [body.roles];
  }
  maybeSet(
    "verified",
    body.verified != null ? Boolean(body.verified) : undefined
  );
  maybeSet("active", body.active != null ? Boolean(body.active) : undefined);
  maybeSet(
    "authStrategy",
    body.authStrategy != null ? String(body.authStrategy) : undefined
  );
  maybeSet(
    "telephonyCredentialsId",
    body.telephonyCredentialsId != null
      ? String(body.telephonyCredentialsId)
      : undefined
  );
  maybeSet(
    "telephonyUserName",
    body.telephonyUserName != null ? String(body.telephonyUserName) : undefined
  );
  maybeSet(
    "profilePictureUri",
    body.profilePictureUri != null ? String(body.profilePictureUri) : undefined
  );

  try {
    await PgDb.updateUserById(id, set);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err?.message || String(err);
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const targetRes = await pool.query(`SELECT roles FROM users WHERE id=$1`, [
    id,
  ]);
  const target = targetRes.rows?.[0] || null;
  if (!target)
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  const targetRoles = target.roles || ["agent"];
  if (targetRoles.includes("owner")) {
    return NextResponse.json(
      { error: "Owner accounts cannot be deleted" },
      { status: 400 }
    );
  }
  await pool.query(`DELETE FROM users WHERE id=$1`, [id]);
  return NextResponse.json({ ok: true });
}
