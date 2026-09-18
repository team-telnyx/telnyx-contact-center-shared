import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { isProtectedSystemAgentStatus } from "@/lib/acd/system-agent-statuses.mjs";
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
      `SELECT * FROM cc_user_statuses WHERE id = $1`,
      [id]
    );

    if (!res.rows?.[0]) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json(res.rows[0]);
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to load status" },
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
    const current = (
      await pool.query("SELECT id, name FROM cc_user_statuses WHERE id = $1", [id])
    ).rows[0];
    if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (isProtectedSystemAgentStatus(current)) {
      return NextResponse.json(
        { error: "This status is managed by Agent lifecycle settings and cannot be edited" },
        { status: 409 },
      );
    }
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
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
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

async function DELETE_handler(request, { params }, authz) {
  const user = authz.user;

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const resolvedParams = await params;
  const id = resolvedParams?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  try {
    const current = (
      await pool.query("SELECT id, name FROM cc_user_statuses WHERE id = $1", [id])
    ).rows[0];
    if (!current) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if (isProtectedSystemAgentStatus(current)) {
      return NextResponse.json(
        { error: "This status is managed by Agent lifecycle settings and cannot be deleted" },
        { status: 409 },
      );
    }
    // Manual status selection is owned by ACD Core. Busy/wrap-up/offline are
    // workflow projections and never make a configurable status deletable.
    const usageRes = await pool.query(
      `SELECT COUNT(*) as count
       FROM acd_agent_state ast
       WHERE ast.status_id = $1`,
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
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to delete status" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("statuses:read", GET_handler, { route: "/api/admin/statuses/[id]" });
export const PUT = withPermission("statuses:update", PUT_handler, { route: "/api/admin/statuses/[id]" });
export const DELETE = withPermission("statuses:delete", DELETE_handler, { route: "/api/admin/statuses/[id]" });
