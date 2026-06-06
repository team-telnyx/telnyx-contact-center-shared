export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapOutboundTimeSet, optionalString, requireOutboundSupervisor, requireString, safeJson, usernameFor } from "@/lib/outbound-dialer/api";

const STATUSES = ["draft", "active", "paused"];
const normalizeStatus = (value) => STATUSES.includes(value) ? value : "draft";

export async function GET() {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`SELECT * FROM outbound_time_sets WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 200`);
  return NextResponse.json({ ok: true, timeSets: rows.map(mapOutboundTimeSet) });
}

export async function POST(request) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const username = usernameFor(user);
    const { rows } = await pool.query(`INSERT INTO outbound_time_sets (name, description, status, timezone, windows, metadata, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [
      requireString(body.name, "Time set name"), optionalString(body.description), normalizeStatus(body.status), optionalString(body.timezone, 80) || "Europe/Warsaw", JSON.stringify(safeJson(body.windows, [])), JSON.stringify(safeJson(body.metadata, {})), username,
    ]);
    return NextResponse.json({ ok: true, timeSet: mapOutboundTimeSet(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] create time set error:", err); return jsonError(err.message || "Failed to create time set", 400); }
}
