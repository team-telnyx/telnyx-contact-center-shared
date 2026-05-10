import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapDncList, optionalString, requireOutboundSupervisor, requireString, safeJson, usernameFor } from "@/lib/outbound-dialer/api";

const statuses = ["draft", "active", "paused"];
const sourceTypes = ["csv", "api", "manual"];
const matchStrategies = ["phone", "email", "phone_or_email"];

export async function PUT(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { dncListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const { rows } = await pool.query(`UPDATE outbound_dnc_lists SET name=$1, description=$2, status=$3, source_type=$4, match_strategy=$5, record_count=$6, metadata=$7, updated_by=$8, updated_at=NOW() WHERE id=$9 AND status <> 'archived' RETURNING *`, [requireString(body.name, "DNC list name"), optionalString(body.description), statuses.includes(body.status) ? body.status : "draft", sourceTypes.includes(body.source_type) ? body.source_type : "csv", matchStrategies.includes(body.match_strategy) ? body.match_strategy : "phone", Number(body.record_count || 0) || 0, JSON.stringify(safeJson(body.metadata, {})), usernameFor(user), dncListId]);
    if (!rows[0]) return jsonError("DNC list not found", 404);
    return NextResponse.json({ ok: true, dncList: mapDncList(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] update DNC list error:", err); return jsonError(err.message || "Failed to update DNC list", 400); }
}

export async function DELETE(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { dncListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`UPDATE outbound_dnc_lists SET status='archived', updated_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [usernameFor(user), dncListId]);
  if (!rows[0]) return jsonError("DNC list not found", 404);
  return NextResponse.json({ ok: true, dncList: mapDncList(rows[0]) });
}
