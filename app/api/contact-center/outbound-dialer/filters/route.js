import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapOutboundFilter, optionalString, requireOutboundSupervisor, requireString, requireUuid, safeJson, usernameFor } from "@/lib/outbound-dialer/api";

const STATUSES = ["draft", "active", "paused"];
const normalizeStatus = (value) => STATUSES.includes(value) ? value : "draft";

export async function GET() {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`SELECT f.*, l.name AS contact_list_name FROM outbound_contact_filters f LEFT JOIN outbound_contact_lists l ON l.id = f.contact_list_id WHERE f.status <> 'archived' ORDER BY f.updated_at DESC LIMIT 200`);
  return NextResponse.json({ ok: true, filters: rows.map(mapOutboundFilter) });
}

export async function POST(request) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const username = usernameFor(user);
    const contactListId = requireUuid(body.contact_list_id, "Target contact list");
    const { rows } = await pool.query(`INSERT INTO outbound_contact_filters (name, description, status, contact_list_id, conditions, metadata, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [
      requireString(body.name, "Filter name"), optionalString(body.description), normalizeStatus(body.status), contactListId, JSON.stringify(safeJson(body.conditions, [])), JSON.stringify(safeJson(body.metadata, {})), username,
    ]);
    return NextResponse.json({ ok: true, filter: mapOutboundFilter(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] create filter error:", err); return jsonError(err.message || "Failed to create filter", 400); }
}
