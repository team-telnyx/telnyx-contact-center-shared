import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapDncList, optionalString, requireString, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { withPermission } from "@/lib/authz/guard";

const statuses = ["draft", "active", "paused"];
const sourceTypes = ["csv", "api", "manual"];
const matchStrategies = ["phone", "email", "phone_or_email"];

async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`SELECT * FROM outbound_dnc_lists WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 200`);
  return NextResponse.json({ ok: true, dncLists: rows.map(mapDncList) });
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const username = usernameFor(user);
    const { rows } = await pool.query(`INSERT INTO outbound_dnc_lists (name, description, status, source_type, match_strategy, record_count, metadata, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [requireString(body.name, "DNC list name"), optionalString(body.description), statuses.includes(body.status) ? body.status : "draft", sourceTypes.includes(body.source_type) ? body.source_type : "csv", matchStrategies.includes(body.match_strategy) ? body.match_strategy : "phone", Number(body.record_count || 0) || 0, JSON.stringify(safeJson(body.metadata, {})), username]);
    return NextResponse.json({ ok: true, dncList: mapDncList(rows[0]) });
  } catch (err) { campaignsLogger.error("dnc_list_create_failed", { ...outboundErrorPayload(err) }); return jsonError(err.message || "Failed to create DNC list", 400); }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("dnc_lists:read", GET_handler, { route: "/api/contact-center/outbound-dialer/dnc-lists" });
export const POST = withPermission("dnc_lists:create", POST_handler, { route: "/api/contact-center/outbound-dialer/dnc-lists" });
