import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { withPermission } from "@/lib/authz/guard";
function readPaging(searchParams) {
  let days = Number.parseInt(searchParams.get("days") || "1", 10);
  days = days === 7 ? 7 : 1;
  let pageSize = Number.parseInt(searchParams.get("pageSize") || "10", 10);
  pageSize = [10, 25, 50].includes(pageSize) ? pageSize : 10;
  const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1", 10) || 1);
  const offset = (page - 1) * pageSize;
  return { days, page, pageSize, offset };
}

async function GET_handler(request, _context, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("phones:read", GET_handler, { route: "/api/admin/phones-provisioning/logs" });
