export const dynamic = "force-dynamic";

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

  try {
    const res = await pool.query(
      `SELECT * FROM cc_wrapup_codes WHERE id = $1`,
      [id]
    );

    if (!res.rows?.[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(res.rows[0]);
  } catch (err) {
    console.error("[WrapupCodes] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load wrapup code" },
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
    const { name, isActive, isDefault, displayOrder, description, icon, color } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    await pool.query(
      `UPDATE cc_wrapup_codes
       SET name = $1, is_active = $2, is_default = $3, display_order = $4, description = $5, icon = $6, color = $7, updated_at = NOW()
       WHERE id = $8`,
      [
        name.trim(),
        isActive !== undefined ? Boolean(isActive) : true,
        isDefault !== undefined ? Boolean(isDefault) : false,
        displayOrder !== undefined ? Number(displayOrder) : 0,
        description || null,
        icon || null,
        color || null,
        id,
      ]
    );

    if (isDefault) {
      await pool.query(
        `UPDATE cc_wrapup_codes SET is_default = false WHERE id <> $1`,
        [id]
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[WrapupCodes] PUT error:", err);
    if (err.code === "23505") {
      return NextResponse.json(
        { error: "A wrapup code with this name already exists" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update wrapup code" },
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
    const codeRes = await pool.query(
      `SELECT is_default FROM cc_wrapup_codes WHERE id = $1`,
      [id]
    );
    const isDefault = Boolean(codeRes.rows?.[0]?.is_default);
    if (isDefault) {
      return NextResponse.json(
        { error: "Cannot delete the default wrapup code" },
        { status: 400 }
      );
    }

    const queueUsageRes = await pool.query(
      `SELECT COUNT(*) as count FROM cc_queue_wrapup_codes WHERE wrapup_code_id = $1`,
      [id]
    );
    const queueUsageCount = parseInt(
      queueUsageRes.rows[0]?.count || "0",
      10
    );
    if (queueUsageCount > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete wrapup code: it is assigned to ${queueUsageCount} queue(s)`,
        },
        { status: 400 }
      );
    }

    const interactionUsageRes = await pool.query(
      `SELECT COUNT(*) as count FROM cc_interactions WHERE wrapup_codes ? $1`,
      [id]
    );
    const interactionUsageCount = parseInt(
      interactionUsageRes.rows[0]?.count || "0",
      10
    );
    if (interactionUsageCount > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete wrapup code: it is used by ${interactionUsageCount} interaction(s)`,
        },
        { status: 400 }
      );
    }

    await pool.query(`DELETE FROM cc_wrapup_codes WHERE id = $1`, [id]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[WrapupCodes] DELETE error:", err);
    return NextResponse.json(
      { error: "Failed to delete wrapup code" },
      { status: 500 }
    );
  }
}

