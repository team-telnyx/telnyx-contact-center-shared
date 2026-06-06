import { NextResponse } from "next/server";
import {
  ensureEnum,
  getOutboundPool,
  jsonError,
  mapOutboundDispositionCode,
  optionalString,
  requireOutboundSupervisor,
  safeJson,
  usernameFor,
} from "@/lib/outbound-dialer/api";

const CLASSIFICATIONS = ["none", "right_party_contact", "number_uncallable", "contact_uncallable", "retry"];
const BUSINESS_CATEGORIES = ["none", "success", "neutral", "failure"];
const STATUSES = ["draft", "active", "paused", "archived"];

function normalizePayload(body = {}) {
  const classification = ensureEnum(body.classification, CLASSIFICATIONS, "none");
  return {
    wrapup_code_id: optionalString(body.wrapup_code_id || body.wrapupCodeId, 120) || "default",
    campaign_id: optionalString(body.campaign_id || body.campaignId, 80),
    classification,
    business_category: classification === "right_party_contact" ? ensureEnum(body.business_category, BUSINESS_CATEGORIES, "none") : "none",
    retry_eligible: classification === "retry" ? body.retry_eligible !== false : false,
    requires_callback: classification === "retry" ? body.requires_callback === true : false,
    status: ensureEnum(body.status, STATUSES, "active"),
    metadata: safeJson(body.metadata, {}),
  };
}

const SELECT_SQL = `
  SELECT m.*, w.name AS wrapup_code_name, w.description AS wrapup_code_description,
         w.icon AS wrapup_code_icon, w.color AS wrapup_code_color, c.name AS campaign_name
  FROM outbound_disposition_code_mappings m
  JOIN cc_wrapup_codes w ON w.id = m.wrapup_code_id
  LEFT JOIN outbound_campaigns c ON c.id = m.campaign_id
`;

export async function PUT(request, { params }) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const draft = normalizePayload(body);
    const username = usernameFor(user);
    const { rows } = await pool.query(
      `UPDATE outbound_disposition_code_mappings
       SET wrapup_code_id = $2, campaign_id = $3, classification = $4, business_category = $5,
           retry_eligible = $6, requires_callback = $7, status = $8, metadata = $9, updated_by = $10, updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [params.id, draft.wrapup_code_id, draft.campaign_id, draft.classification, draft.business_category, draft.retry_eligible, draft.requires_callback, draft.status, JSON.stringify(draft.metadata), username],
    );
    if (!rows[0]) return jsonError("Disposition code not found", 404);
    const enriched = await pool.query(`${SELECT_SQL} WHERE m.id = $1`, [rows[0].id]);
    return NextResponse.json({ ok: true, dispositionCode: mapOutboundDispositionCode(enriched.rows[0]) });
  } catch (err) {
    console.error("[Outbound Dialer] update disposition code error:", err);
    return jsonError(err.message || "Failed to update disposition code", 400);
  }
}

export async function DELETE(_request, { params }) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  await pool.query(`UPDATE outbound_disposition_code_mappings SET status = 'archived', updated_by = $2, updated_at = NOW() WHERE id = $1`, [params.id, usernameFor(user)]);
  return NextResponse.json({ ok: true });
}
