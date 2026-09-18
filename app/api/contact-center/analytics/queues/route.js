import { NextResponse } from 'next/server';
import { getPostgresPool } from '@/lib/postgres.mjs';
import { getAuthenticatedUser } from '@/lib/auth-server';
import { withPermission } from "@/lib/authz/guard";
import { queueScopeSql } from "@/lib/authz/scope.mjs";

export const dynamic = 'force-dynamic';

async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  const pool = getPostgresPool();
  if (!pool) return NextResponse.json({error:'Service unavailable'}, {status:503});
  try {
    // Reports include configured skill requirements and active handoffs, not
    // just completed interactions. Retain disabled queues for historical reports.
    const vals = [];
    const where = queueScopeSql(authz.scope, 'id', vals);
    const {rows} = await pool.query(`SELECT DISTINCT name FROM cc_queues${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name`, vals);
    return NextResponse.json({queues:rows.map(row=>row.name)}, {headers:{'Cache-Control':'private, no-store'}});
  } catch {
    return NextResponse.json({error:'Queue options unavailable'}, {status:500});
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("reports:read", GET_handler, { route: "/api/contact-center/analytics/queues" });
