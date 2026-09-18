import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readLiveInteractions } from "@/lib/acd/live-interactions.mjs";
import { contactCenterRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";
import { interactionInScope } from "@/lib/authz/scope.mjs";

async function GET_handler(request, _context, authz) {
  const user = authz.user;
  let db;
  try {
    db = await getPostgresPool().connect();
    await db.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const result = await readLiveInteractions(db, { channel: new URL(request.url).searchParams.get("channel") || "all" });
    await db.query("COMMIT");
    if (authz.scope.restricted) restrictLiveInteractions(result, authz.scope);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (db) await db.query("ROLLBACK");
    if (error.status !== 400) contactCenterRuntimeLogger.error("live_interactions_read_failed", { error: error.message });
    return NextResponse.json({ error: error.status === 400 ? error.message : "Unable to load live interactions" }, { status: error.status === 400 ? 400 : 500 });
  } finally {
    db?.release();
  }
}

// Live rows are keyed by work item; queue and agent attribution come from the row itself (Phase 3a).
function restrictLiveInteractions(result, scope) {
  const keep = (row) => interactionInScope(scope, {
    channel: row.channel,
    queueIds: [row.queueId, row.queue_id],
    agentIds: [row.agentUserId, row.agent_id, row.text_agent_id],
  });
  for (const key of ["interactions", "rows", "inboundFlows"]) {
    if (Array.isArray(result[key])) result[key] = result[key].filter(keep);
  }
  if (result.summary && typeof result.summary === "object") result.summary.scoped = true;
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("monitor:read", GET_handler, { route: "/api/contact-center/monitor/interactions" });
