import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { contactCenterErrorPayload, queuesLogger } from "@/lib/contact-center/logging.mjs";

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
    queuesLogger.error("queues_list", { ...contactCenterErrorPayload(typeof err !== "undefined" ? err : typeof error !== "undefined" ? error : typeof stateError !== "undefined" ? stateError : typeof activityError !== "undefined" ? activityError : typeof sseError !== "undefined" ? sseError : typeof reEvalError !== "undefined" ? reEvalError : undefined), interactionId: typeof interactionId !== "undefined" ? interactionId : typeof interaction !== "undefined" ? interaction?.id : undefined, callControlId: typeof callControlId !== "undefined" ? callControlId : typeof legId !== "undefined" ? legId : undefined, queueId: typeof queueId !== "undefined" ? queueId : undefined, agentUserId: typeof targetUserIdFinal !== "undefined" ? targetUserIdFinal : typeof userId !== "undefined" ? userId : typeof user !== "undefined" ? user?.id : undefined, reason: typeof reason !== "undefined" ? reason : undefined });
    return NextResponse.json(
      { error: "Failed to fetch queues" },
      { status: 500 }
    );
  }
}
