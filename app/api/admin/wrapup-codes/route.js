import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { randomUUID } from "crypto";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";


async function GET_handler(request, _context, authz) {
  const user = authz.user;

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
  const pageSize = Math.max(
    1,
    parseInt(searchParams.get("pageSize") || "10", 10)
  );
  const offset = (page - 1) * pageSize;
  const activeFilter = searchParams.get("active");
  const searchQuery = searchParams.get("q") || "";

  try {
    const whereConditions = [];
    const queryParams = [];
    let paramIndex = 1;

    if (activeFilter && activeFilter !== "all") {
      whereConditions.push(`is_active = $${paramIndex}`);
      queryParams.push(activeFilter === "true");
      paramIndex++;
    }

    if (searchQuery.trim()) {
      whereConditions.push(
        `(name ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`
      );
      queryParams.push(`%${searchQuery.trim()}%`);
      paramIndex++;
    }

    const whereClause =
      whereConditions.length > 0
        ? `WHERE ${whereConditions.join(" AND ")}`
        : "";

    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM cc_wrapup_codes ${whereClause}`,
      queryParams
    );
    const total = parseInt(countRes.rows[0]?.total || "0", 10);

    queryParams.push(pageSize, offset);
    const itemsRes = await pool.query(
      `SELECT id, name, is_active, is_default, display_order, description, icon, color, created_at, updated_at
       FROM cc_wrapup_codes
       ${whereClause}
       ORDER BY display_order ASC, name ASC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      queryParams
    );

    return NextResponse.json({
      items: itemsRes.rows || [],
      total,
      page,
      pageSize,
    });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json(
      { error: "Failed to load wrapup codes" },
      { status: 500 }
    );
  }
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;

  const pool = getPostgresPool();
  if (!pool)
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  try {
    const body = await request.json();
    const { name, isActive, isDefault, displayOrder, description, icon, color } = body;

    if (!name) {
      return NextResponse.json({ error: "Name is required" }, { status: 400 });
    }

    const id = randomUUID();
    await pool.query(
      `INSERT INTO cc_wrapup_codes (id, name, is_active, is_default, display_order, description, icon, color, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
      [
        id,
        name.trim(),
        isActive !== undefined ? Boolean(isActive) : true,
        isDefault !== undefined ? Boolean(isDefault) : false,
        displayOrder !== undefined ? Number(displayOrder) : 0,
        description || null,
        icon || null,
        color || null,
      ]
    );

    if (isDefault) {
      await pool.query(
        `UPDATE cc_wrapup_codes SET is_default = false WHERE id <> $1`,
        [id]
      );
    }

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    if (err.code === "23505") {
      return NextResponse.json(
        { error: "A wrapup code with this name already exists" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create wrapup code" },
      { status: 500 }
    );
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("wrapup_codes:read", GET_handler, { route: "/api/admin/wrapup-codes" });
export const POST = withPermission("wrapup_codes:create", POST_handler, { route: "/api/admin/wrapup-codes" });
