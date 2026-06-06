export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapDncList, optionalString, requireOutboundSupervisor, requireString, safeJson, usernameFor } from "@/lib/outbound-dialer/api";

const statuses = ["draft", "active", "paused"];
const sourceTypes = ["csv", "api", "manual"];
const matchStrategies = ["phone", "email", "phone_or_email"];

export async function GET() {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`SELECT * FROM outbound_dnc_lists WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 200`);
  return NextResponse.json({ ok: true, dncLists: rows.map(mapDncList) });
}

export async function POST(request) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const username = usernameFor(user);
    const { rows } = await pool.query(`INSERT INTO outbound_dnc_lists (name, description, status, source_type, match_strategy, record_count, metadata, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [requireString(body.name, "DNC list name"), optionalString(body.description), statuses.includes(body.status) ? body.status : "draft", sourceTypes.includes(body.source_type) ? body.source_type : "csv", matchStrategies.includes(body.match_strategy) ? body.match_strategy : "phone", Number(body.record_count || 0) || 0, JSON.stringify(safeJson(body.metadata, {})), username]);
    return NextResponse.json({ ok: true, dncList: mapDncList(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] create DNC list error:", err); return jsonError(err.message || "Failed to create DNC list", 400); }
}
