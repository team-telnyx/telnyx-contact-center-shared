export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapOutboundFilter, optionalString, requireOutboundSupervisor, requireString, requireUuid, safeJson, usernameFor } from "@/lib/outbound-dialer/api";

const STATUSES = ["draft", "active", "paused"];
const normalizeStatus = (value) => STATUSES.includes(value) ? value : "draft";

export async function PUT(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { filterId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const contactListId = requireUuid(body.contact_list_id, "Target contact list");
    const { rows } = await pool.query(`UPDATE outbound_contact_filters SET name=$1, description=$2, status=$3, contact_list_id=$4, conditions=$5, metadata=$6, updated_by=$7, updated_at=NOW() WHERE id=$8 AND status <> 'archived' RETURNING *`, [
      requireString(body.name, "Filter name"), optionalString(body.description), normalizeStatus(body.status), contactListId, JSON.stringify(safeJson(body.conditions, [])), JSON.stringify(safeJson(body.metadata, {})), usernameFor(user), filterId,
    ]);
    if (!rows[0]) return jsonError("Filter not found", 404);
    return NextResponse.json({ ok: true, filter: mapOutboundFilter(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] update filter error:", err); return jsonError(err.message || "Failed to update filter", 400); }
}

export async function DELETE(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { filterId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`UPDATE outbound_contact_filters SET status='archived', updated_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [usernameFor(user), filterId]);
  if (!rows[0]) return jsonError("Filter not found", 404);
  return NextResponse.json({ ok: true, filter: mapOutboundFilter(rows[0]) });
}
