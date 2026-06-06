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
  const categoryFilter = searchParams.get("category");
  const searchQuery = searchParams.get("q") || "";

  try {
    // Build WHERE clause
    const whereConditions = [];
    const queryParams = [];
    let paramIndex = 1;

    if (activeFilter && activeFilter !== "all") {
      whereConditions.push(`is_active = $${paramIndex}`);
      queryParams.push(activeFilter === "true");
      paramIndex++;
    }

    if (categoryFilter && categoryFilter !== "all") {
      whereConditions.push(`category = $${paramIndex}`);
      queryParams.push(categoryFilter);
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

    // Get total count
    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM skills ${whereClause}`,
      queryParams
    );
    const total = parseInt(countRes.rows[0]?.total || "0", 10);

    // Get items
    queryParams.push(pageSize, offset);
    const itemsRes = await pool.query(
      `SELECT id, name, description, category, is_active, created_at, updated_at
       FROM skills
       ${whereClause}
       ORDER BY name ASC
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
    console.error("[Skills] GET error:", err);
    return NextResponse.json(
      { error: "Failed to load skills" },
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
    const { name, description, category, isActive } = body;

    if (!name) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    const id = randomUUID();
    await pool.query(
      `INSERT INTO skills (id, name, description, category, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      [
        id,
        name.trim(),
        description || null,
        category || null,
        isActive !== undefined ? Boolean(isActive) : true,
      ]
    );

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    console.error("[Skills] POST error:", err);
    if (err.code === "23505") {
      // Unique constraint violation
      return NextResponse.json(
        { error: "A skill with this name already exists" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create skill" },
      { status: 500 }
    );
  }
}

