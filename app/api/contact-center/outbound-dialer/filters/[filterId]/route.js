import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapOutboundFilter, optionalString, requireString, requireUuid, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { withPermission } from "@/lib/authz/guard";

const STATUSES = ["draft", "active", "paused"];
const normalizeStatus = (value) => STATUSES.includes(value) ? value : "draft";

async function PUT_handler(request, context, authz) {
  const user = authz.user;
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
  } catch (err) { campaignsLogger.error("filter_update_failed", { filterId, ...outboundErrorPayload(err) }); return jsonError(err.message || "Failed to update filter", 400); }
}

async function DELETE_handler(request, context, authz) {
  const user = authz.user;
  const { filterId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`UPDATE outbound_contact_filters SET status='archived', updated_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [usernameFor(user), filterId]);
  if (!rows[0]) return jsonError("Filter not found", 404);
  return NextResponse.json({ ok: true, filter: mapOutboundFilter(rows[0]) });
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const PUT = withPermission("dialer_filters:update", PUT_handler, { route: "/api/contact-center/outbound-dialer/filters/[filterId]" });
export const DELETE = withPermission("dialer_filters:delete", DELETE_handler, { route: "/api/contact-center/outbound-dialer/filters/[filterId]" });
