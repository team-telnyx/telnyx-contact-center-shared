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
const STATUSES = ["draft", "active", "paused"];

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

export async function GET() {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  const [mappingsResult, wrapupsResult] = await Promise.all([
    pool.query(`${SELECT_SQL} WHERE m.status <> 'archived' ORDER BY COALESCE(c.name, 'Global'), w.display_order, w.name LIMIT 300`),
    pool.query(`SELECT id, name, description, icon, color, display_order, is_active FROM cc_wrapup_codes WHERE is_active = true ORDER BY display_order ASC, name ASC`),
  ]);
  return NextResponse.json({
    ok: true,
    dispositionCodes: mappingsResult.rows.map(mapOutboundDispositionCode),
    wrapupCodes: wrapupsResult.rows,
  });
}

export async function POST(request) {
  const user = await requireOutboundSupervisor(); if (!user) return jsonError("Forbidden", 403);
  const pool = getOutboundPool(); if (!pool) return jsonError("Server not ready", 500);
  try {
    const body = await request.json();
    const draft = normalizePayload(body);
    const username = usernameFor(user);
    const { rows } = await pool.query(
      `INSERT INTO outbound_disposition_code_mappings (
        wrapup_code_id, campaign_id, classification, business_category, retry_eligible, requires_callback, status, metadata, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)
       ON CONFLICT (wrapup_code_id, (COALESCE(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid))) DO UPDATE SET
        classification = EXCLUDED.classification,
        business_category = EXCLUDED.business_category,
        retry_eligible = EXCLUDED.retry_eligible,
        requires_callback = EXCLUDED.requires_callback,
        status = EXCLUDED.status,
        metadata = EXCLUDED.metadata,
        updated_by = EXCLUDED.updated_by,
        updated_at = NOW()
       RETURNING *`,
      [draft.wrapup_code_id, draft.campaign_id, draft.classification, draft.business_category, draft.retry_eligible, draft.requires_callback, draft.status, JSON.stringify(draft.metadata), username],
    );
    const enriched = await pool.query(`${SELECT_SQL} WHERE m.id = $1`, [rows[0].id]);
    return NextResponse.json({ ok: true, dispositionCode: mapOutboundDispositionCode(enriched.rows[0]) });
  } catch (err) {
    console.error("[Outbound Dialer] create disposition code error:", err);
    return jsonError(err.message || "Failed to create disposition code", 400);
  }
}
