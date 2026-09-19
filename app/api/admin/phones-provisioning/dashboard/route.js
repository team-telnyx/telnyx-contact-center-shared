import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { withPermission } from "@/lib/authz/guard";
// Dashboard snapshot: fleet totals and inventory split.
async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  // Hardphone provisioning is an experimental feature enabled per user.
  if (user.experimental_features !== true) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  try {
    const [{ rows: totalsRows }, { rows: vendorRows }] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE provisioning_state = 'provisioned')::int AS provisioned,
                COUNT(*) FILTER (WHERE provisioning_state = 'pending')::int AS pending,
                COUNT(*) FILTER (WHERE provisioning_state = 'disabled')::int AS disabled,
                COUNT(*) FILTER (WHERE last_seen_at > NOW() - INTERVAL '2 hours')::int AS recently_seen
         FROM hp_phones`,
      ),
      pool.query(`SELECT vendor, COUNT(*)::int AS count FROM hp_phones GROUP BY vendor ORDER BY count DESC`),
    ]);
    return NextResponse.json({
      totals: totalsRows[0] || { total: 0, provisioned: 0, pending: 0, disabled: 0, recently_seen: 0 },
      byVendor: vendorRows,
      timestamp: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ error: "Failed to load dashboard" }, { status: 500 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("phones:read", GET_handler, { route: "/api/admin/phones-provisioning/dashboard" });
