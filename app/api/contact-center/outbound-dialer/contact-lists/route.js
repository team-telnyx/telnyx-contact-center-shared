import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapContactList, normalizeFieldSchema, optionalString, requireOutboundSupervisor, requireString, safeJson, usernameFor } from "@/lib/outbound-dialer/api";

export async function GET() {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`SELECT * FROM outbound_contact_lists WHERE status <> 'archived' ORDER BY updated_at DESC LIMIT 200`);
  return NextResponse.json({ ok: true, contactLists: rows.map(mapContactList) });
}

export async function POST(request) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const username = usernameFor(user);
    const schema = normalizeFieldSchema(body.custom_field_schema || []);
    const { rows } = await pool.query(`INSERT INTO outbound_contact_lists (name, description, status, source_type, custom_field_schema, metadata, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [requireString(body.name, "List name"), optionalString(body.description), ["draft", "validating", "validated"].includes(body.status) ? body.status : "draft", ["csv", "api", "crm", "manual"].includes(body.source_type) ? body.source_type : "csv", JSON.stringify(schema), JSON.stringify(safeJson(body.metadata, {})), username]);
    return NextResponse.json({ ok: true, contactList: mapContactList(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] create contact list error:", err); return jsonError(err.message || "Failed to create contact list", 400); }
}
