import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";

export const dynamic = "force-dynamic";

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

  try {
    const res = await pool.query(`SELECT * FROM domains WHERE id = $1`, [id]);

    if (!res.rows?.[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(res.rows[0]);
  } catch (err) {
    console.error("[Domains] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load domain" },
      { status: 500 }
    );
  }
}

export async function PUT(request, { params }) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const body = await request.json();
    const { domain, active } = body;

    if (!domain || !domain.trim()) {
      return NextResponse.json(
        { error: "Domain is required" },
        { status: 400 }
      );
    }

    // Basic domain validation
    const domainRegex = /^([a-z0-9]+(-[a-z0-9]+)*\.)+[a-z]{2,}$/i;
    if (!domainRegex.test(domain.trim())) {
      return NextResponse.json(
        { error: "Invalid domain format. Example: example.com" },
        { status: 400 }
      );
    }

    await pool.query(
      `UPDATE domains
       SET domain = $1, active = $2, updated_at = NOW()
       WHERE id = $3`,
      [
        domain.trim().toLowerCase(),
        active !== undefined ? Boolean(active) : true,
        id,
      ]
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Domains] PUT error:", err);
    if (err.code === "23505") {
      return NextResponse.json(
        { error: "A domain with this name already exists" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update domain" },
      { status: 500 }
    );
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

  try {
    // Get domain name first
    const domainRes = await pool.query(
      `SELECT domain FROM domains WHERE id = $1`,
      [id]
    );

    if (!domainRes.rows?.[0]) {
      return NextResponse.json({ error: "Domain not found" }, { status: 404 });
    }

    const domainName = domainRes.rows[0].domain;

    // Check if domain is being used by any users
    const userUsageRes = await pool.query(
      `SELECT COUNT(*) as count FROM users WHERE email LIKE '%@' || $1`,
      [domainName]
    );
    const userUsageCount = parseInt(userUsageRes.rows[0]?.count || "0", 10);

    if (userUsageCount > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete domain: it is used by ${userUsageCount} user(s)`,
        },
        { status: 400 }
      );
    }

    await pool.query(`DELETE FROM domains WHERE id = $1`, [id]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Domains] DELETE error:", err);
    return NextResponse.json(
      { error: "Failed to delete domain" },
      { status: 500 }
    );
  }
}
