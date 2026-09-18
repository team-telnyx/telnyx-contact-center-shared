import { NextResponse } from "next/server";
import { getOutboundPool, jsonError, loadOutboundContactLists, mapContactList, normalizeFieldSchema, optionalString, requireString, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { normalizeContactListStatus } from "@/lib/outbound-dialer/contact-list-validation";
import { campaignsLogger, outboundErrorPayload } from "@/lib/outbound-dialer/logging.mjs";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(_request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const { rows } = await loadOutboundContactLists(pool, 200);
  return NextResponse.json({ ok: true, contactLists: rows.map(mapContactList) });
}

async function POST_handler(request, _context, authz) {
  const user = authz.user;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const username = usernameFor(user);
    const schema = normalizeFieldSchema(body.custom_field_schema || []);
    const metadata = safeJson(body.metadata, {});
    const status = normalizeContactListStatus({ ...body, metadata, custom_field_schema: schema });
    const { rows } = await pool.query(`INSERT INTO outbound_contact_lists (name, description, status, source_type, custom_field_schema, metadata, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`, [requireString(body.name, "List name"), optionalString(body.description), status, ["csv", "api", "crm", "manual"].includes(body.source_type) ? body.source_type : "csv", JSON.stringify(schema), JSON.stringify(metadata), username]);
    return NextResponse.json({ ok: true, contactList: mapContactList(rows[0]) });
  } catch (err) { campaignsLogger.error("contact_list_create_failed", { ...outboundErrorPayload(err) }); return jsonError(err.message || "Failed to create contact list", 400); }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("contact_lists:read", GET_handler, { route: "/api/contact-center/outbound-dialer/contact-lists" });
export const POST = withPermission("contact_lists:create", POST_handler, { route: "/api/contact-center/outbound-dialer/contact-lists" });
