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
  if (!isAdmin(user) || user.experimental_features !== true) return null;
  return user;
}

// Dashboard snapshot: fleet totals and inventory split.
export async function GET() {
  const user = await requireAdmin();
  if (!user) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
