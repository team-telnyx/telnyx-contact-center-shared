import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { randomUUID } from "crypto";

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

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
    console.error("[WrapupCodes] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load wrapup codes" },
      { status: 500 }
    );
  }
}

export async function POST(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
    console.error("[WrapupCodes] POST error:", err);
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

