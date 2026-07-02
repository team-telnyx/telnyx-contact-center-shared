import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { PgDb } from "@/lib/pgdb";
import { isAdmin } from "@/lib/role-utils";
import { randomUUID } from "crypto";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";

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
      whereConditions.push(`active = $${paramIndex}`);
      queryParams.push(activeFilter === "true");
      paramIndex++;
    }

    if (searchQuery.trim()) {
      whereConditions.push(`domain ILIKE $${paramIndex}`);
      queryParams.push(`%${searchQuery.trim()}%`);
      paramIndex++;
    }

    const whereClause =
      whereConditions.length > 0
        ? `WHERE ${whereConditions.join(" AND ")}`
        : "";

    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM domains ${whereClause}`,
      queryParams
    );
    const total = parseInt(countRes.rows[0]?.total || "0", 10);

    queryParams.push(pageSize, offset);
    const itemsRes = await pool.query(
      `SELECT id, domain, active, created_at, updated_at
       FROM domains
       ${whereClause}
       ORDER BY domain ASC
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
      { error: "Failed to load domains" },
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

    const id = randomUUID();
    await pool.query(
      `INSERT INTO domains (id, domain, active, created_at, updated_at)
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [
        id,
        domain.trim().toLowerCase(),
        active !== undefined ? Boolean(active) : true,
      ]
    );

    return NextResponse.json({ ok: true, id });
  } catch (err) {
    adminRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    if (err.code === "23505") {
      return NextResponse.json(
        { error: "A domain with this name already exists" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create domain" },
      { status: 500 }
    );
  }
}
