import { NextResponse } from "next/server";
import { getOutboundPool, isLikelyPhone, jsonError, normalizeFieldSchema, parseCsv, requireOutboundSupervisor, safeJson, usernameFor } from "@/lib/outbound-dialer/api";
import { OUTBOUND_STANDARD_CONTACT_COLUMNS } from "@/lib/outbound-dialer/schema";

const standardNames = new Set(OUTBOUND_STANDARD_CONTACT_COLUMNS.map((f) => f.name));

export async function POST(request, context) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const { contactListId } = await context.params;
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    let csv = "";
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      csv = file && typeof file.text === "function" ? await file.text() : String(form.get("csv") || "");
    } else {
      const body = await request.json();
      csv = body.csv || body.text || "";
    }
    const { headers, records, truncated } = parseCsv(csv, 5000);
    if (!headers.length) return jsonError("CSV header row is required", 400);
    if (!records.length) return jsonError("CSV contains no records", 400);
    const customHeaders = headers.filter((h) => h && !standardNames.has(h));
    const inferredSchema = normalizeFieldSchema(customHeaders.map((name) => ({ name, type: name.toLowerCase().includes("email") ? "email" : name.toLowerCase().includes("phone") ? "phone" : "text" })));
    const standardColumns = Object.fromEntries(headers.filter((h) => standardNames.has(h)).map((h) => [h, h]));
    const validPhones = records.filter((r) => isLikelyPhone(r.phone_number || r.phone || r.mobile || r.Phone)).length;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM outbound_contact_records WHERE contact_list_id=$1`, [contactListId]);
      for (const record of records) {
        const standard = {}; const custom = {};
        for (const [key, value] of Object.entries(record)) {
          if (standardNames.has(key)) standard[key] = value;
          else custom[key] = value;
        }
        await client.query(`INSERT INTO outbound_contact_records (contact_list_id, phone_number, standard_fields, custom_fields, validation_status) VALUES ($1,$2,$3,$4,$5)`, [contactListId, standard.phone_number || record.phone || record.mobile || null, JSON.stringify(standard), JSON.stringify(custom), isLikelyPhone(standard.phone_number || record.phone || record.mobile) ? "valid" : "needs_review"]);
      }
      const { rows } = await client.query(`UPDATE outbound_contact_lists SET status='validated', standard_columns=$1, custom_field_schema=$2, record_count=$3, valid_phone_count=$4, updated_by=$5, updated_at=NOW() WHERE id=$6 RETURNING *`, [JSON.stringify(standardColumns), JSON.stringify(inferredSchema), records.length, validPhones, usernameFor(user), contactListId]);
      await client.query("COMMIT");
      if (!rows[0]) return jsonError("Contact list not found", 404);
      return NextResponse.json({ ok: true, contactList: rows[0], preview: records.slice(0, 10), headers, inferredSchema, validPhones, totalRows: records.length, truncated });
    } catch (err) { await client.query("ROLLBACK"); throw err; }
    finally { client.release(); }
  } catch (err) { console.error("[Outbound Dialer] CSV import error:", err); return jsonError(err.message || "Failed to import CSV", 400); }
}
