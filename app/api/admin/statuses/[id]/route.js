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
    const res = await pool.query(
      `SELECT * FROM cc_user_statuses WHERE id = $1`,
      [id]
    );

    if (!res.rows?.[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(res.rows[0]);
  } catch (err) {
    console.error("[Statuses] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load status" },
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
    const {
      name,
      type,
      isActive,
      userSelectable,
      icon,
      color,
      displayOrder,
      description,
    } = body;

    if (!name || !type) {
      return NextResponse.json(
        { error: "Name and type are required" },
        { status: 400 }
      );
    }

    if (!["active", "break"].includes(type)) {
      return NextResponse.json(
        { error: "Type must be 'active' or 'break'" },
        { status: 400 }
      );
    }

    await pool.query(
      `UPDATE cc_user_statuses
       SET name = $1, type = $2, is_active = $3, user_selectable = $4, icon = $5, color = $6, display_order = $7, description = $8, updated_at = NOW()
       WHERE id = $9`,
      [
        name.trim(),
        type,
        isActive !== undefined ? Boolean(isActive) : true,
        userSelectable !== undefined ? Boolean(userSelectable) : true,
        icon || null,
        color || null,
        displayOrder !== undefined ? Number(displayOrder) : 0,
        description || null,
        id,
      ]
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Statuses] PUT error:", err);
    if (err.code === "23505") {
      return NextResponse.json(
        { error: "A status with this name already exists" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update status" },
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
    // Check if status is in use. Runtime agent status is stored in cc_agent_state;
    // users.agent_status is a removed legacy column.
    const usageRes = await pool.query(
      `SELECT COUNT(*) as count
       FROM cc_agent_state ast
       JOIN cc_user_statuses status ON status.name = ast.agent_status
       WHERE status.id = $1`,
      [id]
    );
    const usageCount = parseInt(usageRes.rows[0]?.count || "0", 10);

    if (usageCount > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete status: it is currently used by ${usageCount} user(s)`,
        },
        { status: 400 }
      );
    }

    await pool.query(`DELETE FROM cc_user_statuses WHERE id = $1`, [id]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[Statuses] DELETE error:", err);
    return NextResponse.json(
      { error: "Failed to delete status" },
      { status: 500 }
    );
  }
}
