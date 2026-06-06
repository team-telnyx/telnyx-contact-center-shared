export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, mapContactList, normalizeFieldSchema, optionalString, requireOutboundSupervisor, requireString, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { normalizeContactListStatus } from "@/lib/outbound-dialer/contact-list-validation";

export async function PUT(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { contactListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const schema = normalizeFieldSchema(body.custom_field_schema || []);
    const metadata = safeJson(body.metadata, {});
    const { rows: currentRows } = await pool.query(`SELECT record_count FROM outbound_contact_lists WHERE id=$1 AND status <> 'archived'`, [contactListId]);
    if (!currentRows[0]) return jsonError("Contact list not found", 404);
    const status = normalizeContactListStatus({ ...body, record_count: currentRows[0].record_count, metadata, custom_field_schema: schema });
    const { rows } = await pool.query(`UPDATE outbound_contact_lists SET name=$1, description=$2, status=$3, source_type=$4, custom_field_schema=$5, metadata=$6, updated_by=$7, updated_at=NOW() WHERE id=$8 AND status <> 'archived' RETURNING *`, [requireString(body.name, "List name"), optionalString(body.description), status, ["csv", "api", "crm", "manual"].includes(body.source_type) ? body.source_type : "csv", JSON.stringify(schema), JSON.stringify(metadata), usernameFor(user), contactListId]);
    if (!rows[0]) return jsonError("Contact list not found", 404);
    return NextResponse.json({ ok: true, contactList: mapContactList(rows[0]) });
  } catch (err) { console.error("[Outbound Dialer] update contact list error:", err); return jsonError(err.message || "Failed to update contact list", 400); }
}

export async function DELETE(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { contactListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await pool.query(`UPDATE outbound_contact_lists SET status='archived', updated_by=$1, updated_at=NOW() WHERE id=$2 RETURNING *`, [usernameFor(user), contactListId]);
  if (!rows[0]) return jsonError("Contact list not found", 404);
  return NextResponse.json({ ok: true, contactList: mapContactList(rows[0]) });
}
