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

function readPaging(searchParams) {
  let days = Number.parseInt(searchParams.get("days") || "1", 10);
  days = days === 7 ? 7 : 1;
  let pageSize = Number.parseInt(searchParams.get("pageSize") || "10", 10);
  pageSize = [10, 25, 50].includes(pageSize) ? pageSize : 10;
  const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);
  const offset = (page - 1) * pageSize;
  return { days, page, pageSize, offset };
}

export async function GET(request) {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });

  const { searchParams } = new URL(request.url);
  const { days, page, pageSize, offset } = readPaging(searchParams);

  try {
    const [{ rows: countRows }, { rows: events }] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total
         FROM hp_provisioning_events e
         WHERE e.created_at >= NOW() - ($1::int * INTERVAL '1 day')`,
        [days],
      ),
      pool.query(
        `SELECT e.id,
                COALESCE(e.mac, p.mac) AS mac,
                e.event_type,
                e.detail,
                e.created_at,
                p.phone_name,
                p.label,
                p.vendor
         FROM hp_provisioning_events e
         LEFT JOIN hp_phones p ON p.id = e.phone_id
         WHERE e.created_at >= NOW() - ($1::int * INTERVAL '1 day')
         ORDER BY e.created_at DESC
         LIMIT $2 OFFSET $3`,
        [days, pageSize, offset],
      ),
    ]);
    const total = countRows[0]?.total || 0;
    return NextResponse.json({
      events,
      total,
      page,
      pageSize,
      days,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ error: "Failed to load provisioning logs" }, { status: 500 });
  }
}
