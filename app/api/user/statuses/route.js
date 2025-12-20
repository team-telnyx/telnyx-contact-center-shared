import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";

/**
 * GET /api/user/statuses
 * Get all active user statuses from the database
 * Public endpoint - no authentication required (statuses are public info)
 */
export async function GET(request) {
  try {
    const pool = getPostgresPool();
    if (!pool) {
      return NextResponse.json(
        { ok: false, error: "Server not ready" },
        { status: 500 }
      );
    }

    // Get all active statuses, ordered by display_order and name
    const result = await pool.query(
      `SELECT id, name, type, is_active, display_order, description
       FROM cc_user_statuses
       WHERE is_active = true
       ORDER BY display_order ASC, name ASC`
    );

    return NextResponse.json({
      ok: true,
      statuses: result.rows || [],
    });
  } catch (err) {
    console.error("[Statuses] Error fetching statuses:", err);
    return NextResponse.json(
      { ok: false, error: "Failed to fetch statuses" },
      { status: 500 }
    );
  }
}
