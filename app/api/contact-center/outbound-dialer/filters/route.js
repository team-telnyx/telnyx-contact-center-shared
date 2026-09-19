import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapOutboundFilter, optionalString, requireString, requireUuid, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { withPermission } from "@/lib/authz/guard";

const STATUSES = ["draft", "active", "paused"];
const normalizeStatus = (value) => STATUSES.includes(value) ? value : "draft";

async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`SELECT f.*, l.name AS contact_list_name FROM outbound_contact_filters f LEFT JOIN outbound_contact_lists l ON l.id = f.contact_list_id WHERE f.status <> 'archived' ORDER BY f.updated_at DESC LIMIT 200`);
  return NextResponse.json({ ok: true, filters: rows.map(mapOutboundFilter) });
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const username = usernameFor(user);
    const status = normalizeStatus(body.status);
    const contactListId = body.contact_list_id ? requireUuid(body.contact_list_id, "Target contact list") : null;
    if (!contactListId && status !== "draft") throw new Error("Target contact list is required before activating this filter");
    const { rows } = await pool.query(`INSERT INTO outbound_contact_filters (name, description, status, contact_list_id, conditions, metadata, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [
      requireString(body.name, "Filter name"), optionalString(body.description), status, contactListId, JSON.stringify(safeJson(body.conditions, [])), JSON.stringify(safeJson(body.metadata, {})), username,
    ]);
    return NextResponse.json({ ok: true, filter: mapOutboundFilter(rows[0]) });
  } catch (err) { campaignsLogger.error("filter_create_failed", { ...outboundErrorPayload(err) }); return jsonError(err.message || "Failed to create filter", 400); }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("dialer_filters:read", GET_handler, { route: "/api/contact-center/outbound-dialer/filters" });
export const POST = withPermission("dialer_filters:create", POST_handler, { route: "/api/contact-center/outbound-dialer/filters" });
