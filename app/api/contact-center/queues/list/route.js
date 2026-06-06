import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";

/**
 * GET /api/contact-center/queues/list
 * Returns a list of enabled and active queues for use in call flows
 */
export async function GET(request) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPostgresPool();
  if (!pool) {
    return NextResponse.json({ error: "Server not ready" }, { status: 500 });
  }

  try {
    // Fetch only enabled and active queues, ordered by priority and name
    const result = await pool.query(
      `SELECT id, name, display_name, routing_strategy 
       FROM cc_queues 
       WHERE enabled = true AND active = true 
       ORDER BY priority DESC, name ASC`
    );

    return NextResponse.json({
      queues: result.rows || [],
    });
  } catch (error) {
    console.error("[Queues List] Error fetching queues:", error);
    return NextResponse.json(
      { error: "Failed to fetch queues" },
      { status: 500 }
    );
  }
}
