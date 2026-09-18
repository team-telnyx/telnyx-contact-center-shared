import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapDncList, optionalString, requireString, usernameFor } from "@/lib/outbound-dialer/api";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { withPermission } from "@/lib/authz/guard";

const statuses = ["draft", "active", "paused"];
const sourceTypes = ["csv", "api", "manual"];
const matchStrategies = ["phone", "email", "phone_or_email"];

async function PUT_handler(request, context, authz) {
  const user = authz.user;
  const { dncListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const { rows } = await pool.query(`UPDATE outbound_dnc_lists SET name=$1, description=$2, status=$3, source_type=$4, match_strategy=$5, updated_by=$6, updated_at=NOW() WHERE id=$7 AND status <> 'archived' RETURNING *`, [requireString(body.name, "DNC list name"), optionalString(body.description), statuses.includes(body.status) ? body.status : "draft", sourceTypes.includes(body.source_type) ? body.source_type : "csv", matchStrategies.includes(body.match_strategy) ? body.match_strategy : "phone", usernameFor(user), dncListId]);
    if (!rows[0]) return jsonError("DNC list not found", 404);
    return NextResponse.json({ ok: true, dncList: mapDncList(rows[0]) });
  } catch (err) { campaignsLogger.error("dnc_list_update_failed", { dncListId, ...outboundErrorPayload(err) }); return jsonError(err.message || "Failed to update DNC list", 400); }
}

async function DELETE_handler(request, context, authz) {
  const user = authz.user;
  const { dncListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`UPDATE outbound_dnc_lists SET status='archived', updated_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [usernameFor(user), dncListId]);
  if (!rows[0]) return jsonError("DNC list not found", 404);
  return NextResponse.json({ ok: true, dncList: mapDncList(rows[0]) });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const PUT = withPermission("dnc_lists:update", PUT_handler, { route: "/api/contact-center/outbound-dialer/dnc-lists/[dncListId]" });
export const DELETE = withPermission("dnc_lists:delete", DELETE_handler, { route: "/api/contact-center/outbound-dialer/dnc-lists/[dncListId]" });
