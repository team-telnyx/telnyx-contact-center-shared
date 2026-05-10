import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapOutboundTimeSet, optionalString, requireOutboundSupervisor, requireString, safeJson, usernameFor } from "@/lib/outbound-dialer/api";

const STATUSES = ["draft", "active", "paused"];
const normalizeStatus = (value) => STATUSES.includes(value) ? value : "draft";

export async function PUT(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { timeSetId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const { rows } = await pool.query(`UPDATE outbound_time_sets SET name=$1, description=$2, status=$3, timezone=$4, windows=$5, metadata=$6, updated_by=$7, updated_at=NOW() WHERE id=$8 AND status <> 'archived' RETURNING *`, [
      requireString(body.name, "Time set name"), optionalString(body.description), normalizeStatus(body.status), optionalString(body.timezone, 80) || "Europe/Warsaw", JSON.stringify(safeJson(body.windows, [])), JSON.stringify(safeJson(body.metadata, {})), usernameFor(user), timeSetId,
    ]);
    if (!rows[0]) return jsonError("Time set not found", 404);
    return NextResponse.json({ ok: true, timeSet: mapOutboundTimeSet(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] update time set error:", err); return jsonError(err.message || "Failed to update time set", 400); }
}

export async function DELETE(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { timeSetId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`UPDATE outbound_time_sets SET status='archived', updated_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [usernameFor(user), timeSetId]);
  if (!rows[0]) return jsonError("Time set not found", 404);
  return NextResponse.json({ ok: true, timeSet: mapOutboundTimeSet(rows[0]) });
}
