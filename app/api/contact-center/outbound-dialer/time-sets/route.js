import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapOutboundTimeSet, optionalString, requireString, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { withPermission } from "@/lib/authz/guard";

const STATUSES = ["draft", "active", "paused"];
const normalizeStatus = (value) => STATUSES.includes(value) ? value : "draft";

async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`SELECT * FROM outbound_time_sets WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 200`);
  return NextResponse.json({ ok: true, timeSets: rows.map(mapOutboundTimeSet) });
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const username = usernameFor(user);
    const { rows } = await pool.query(`INSERT INTO outbound_time_sets (name, description, status, timezone, windows, metadata, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [
      requireString(body.name, "Time set name"), optionalString(body.description), normalizeStatus(body.status), optionalString(body.timezone, 80) || "Europe/Warsaw", JSON.stringify(safeJson(body.windows, [])), JSON.stringify(safeJson(body.metadata, {})), username,
    ]);
    return NextResponse.json({ ok: true, timeSet: mapOutboundTimeSet(rows[0]) });
  } catch (err) { campaignsLogger.error("time_set_create_failed", { ...outboundErrorPayload(err) }); return jsonError(err.message || "Failed to create time set", 400); }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("dialer_time_sets:read", GET_handler, { route: "/api/contact-center/outbound-dialer/time-sets" });
export const POST = withPermission("dialer_time_sets:create", POST_handler, { route: "/api/contact-center/outbound-dialer/time-sets" });
