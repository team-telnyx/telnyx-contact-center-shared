import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


async function GET_handler(request, { params }, authz) {
  const user = authz.user;

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const res = await pool.query(
      `SELECT id, name, description, category, is_active, created_at, updated_at
       FROM skills
       WHERE id = $1`,
      [id]
    );

    if (!res.rows || res.rows.length === 0) {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }

    return NextResponse.json({ skill: res.rows[0] });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to load skill" },
      { status: 500 }
    );
  }
}

async function PUT_handler(request, { params }, authz) {
  const user = authz.user;

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const body = await request.json();
    const { name, description, category, isActive } = body;

    if (!name) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    await pool.query(
      `UPDATE skills
       SET name = $1, description = $2, category = $3, is_active = $4, updated_at = NOW()
       WHERE id = $5`,
      [
        name.trim(),
        description || null,
        category || null,
        isActive !== undefined ? Boolean(isActive) : true,
        id,
      ]
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    if (err.code === "23505") {
      return NextResponse.json(
        { error: "A skill with this name already exists" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to update skill" },
      { status: 500 }
    );
  }
}

async function DELETE_handler(request, { params }, authz) {
  const user = authz.user;

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    // Check if skill is being used by any users
    const usageCheck = await pool.query(
      `SELECT COUNT(*) as count FROM users WHERE skills ? $1`,
      [id]
    );
    const usageCount = parseInt(usageCheck.rows[0]?.count || "0", 10);

    if (usageCount > 0) {
      return NextResponse.json(
        {
          error: `Cannot delete skill: it is assigned to ${usageCount} user(s)`,
        },
        { status: 400 }
      );
    }

    await pool.query(`DELETE FROM skills WHERE id = $1`, [id]);

    return NextResponse.json({ ok: true });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to delete skill" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("skills:read", GET_handler, { route: "/api/admin/skills/[id]" });
export const PUT = withPermission("skills:update", PUT_handler, { route: "/api/admin/skills/[id]" });
export const DELETE = withPermission("skills:delete", DELETE_handler, { route: "/api/admin/skills/[id]" });
