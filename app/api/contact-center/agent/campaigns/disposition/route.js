import { withWrapupDevice } from "@/lib/acd/media-device-control.mjs";
import { submitOutboundDisposition } from "@/lib/acd/outbound-disposition.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { applyCampaignDispositionToLedger } from "@/lib/outbound-dialer/campaign-dispositions";
import { readEffectiveAgentStatus } from "@/lib/acd/agent-state.mjs";
import { adminRuntimeLogger, contactCenterRuntimeLogger, platformApiLogger, platformDbLogger, runtimePayload, voiceRuntimeLogger } from "@/lib/runtime-logging.mjs";
import { withPermission } from "@/lib/authz/guard";

function usernameFor(user) {
  return user?.username || user?.email || null;
}

async function GET_handler(request, _context, authz) {
  try {
    const user = authz.user;
    const agentUsername = usernameFor(user);
    if (!agentUsername) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    const campaignId = new URL(request.url).searchParams.get("campaignId");
    const { rows } = await pool.query(
      `SELECT m.*, w.name AS wrapup_code_name, w.description AS wrapup_code_description, w.icon AS wrapup_code_icon, w.color AS wrapup_code_color
       FROM outbound_disposition_code_mappings m
       JOIN cc_wrapup_codes w ON w.id = m.wrapup_code_id AND w.is_active = true
       WHERE m.status = 'active' AND (m.campaign_id IS NULL OR m.campaign_id = $1::uuid)
       ORDER BY CASE WHEN m.campaign_id = $1::uuid THEN 0 ELSE 1 END, w.display_order ASC, w.name ASC`,
      [campaignId || null],
    );
    const seen=new Set();
    const dispositionCodes=rows.filter(row=>{if(seen.has(row.wrapup_code_id)) return false;seen.add(row.wrapup_code_id);return true;});
    return NextResponse.json({ ok: true, dispositionCodes });
  } catch (err) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: err.status || 400 });
  }
}

async function POST_handler(request, _context, authz) {
  try {
    const user = authz.user;
    const agentUsername = usernameFor(user);
    if (!agentUsername) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    const pool = getPostgresPool();
    if (!pool) return NextResponse.json({ ok: false, error: "Server not ready" }, { status: 500 });
    const body = await request.json().catch(() => ({}));
    const attemptId = String(body?.attemptId || "").trim();
    const dispositionCodeId = String(body?.dispositionCodeId || body?.wrapup_code_id || "").trim();
    const callbackAt = body?.callback_at || body?.callbackAt || null;
    const notes = String(body?.notes || "").trim();
    if (!attemptId) return NextResponse.json({ ok: false, error: "Attempt ID is required" }, { status: 400 });
    if (!dispositionCodeId) return NextResponse.json({ ok: false, error: "Disposition code is required" }, { status: 400 });

    const work = (await pool.query('SELECT id FROM acd_work_items WHERE outbound_attempt_id=$1',[attemptId])).rows[0];
    const submit = () => submitOutboundDisposition(pool, { attemptId, agentId: String(user.id), dispositionCodeId, callbackAt, notes });
    const coreResult = work ? await withWrapupDevice(pool,user,request,
      {workItemId:work.id,ownerVersion:body.ownerVersion},submit) : await submit();
    if (coreResult) return NextResponse.json(coreResult);

    const attemptResult = await pool.query(
      `SELECT l.*, c.id AS campaign_id
       FROM outbound_attempt_ledger l
       JOIN outbound_campaigns c ON c.id = l.campaign_id
       WHERE l.id = $1 AND l.metadata->>'assigned_agent' = $2
       LIMIT 1`,
      [attemptId, agentUsername],
    );
    const attempt = attemptResult.rows[0];
    if (!attempt) return NextResponse.json({ ok: false, error: "Assigned campaign record not found" }, { status: 404 });

    if (["claimed", "dialing", "answered"].includes(attempt.status)) return NextResponse.json({ ok: false, error: "Wait for confirmed call completion" }, { status: 409 });
    const mappingResult = await pool.query(
      `SELECT * FROM outbound_disposition_code_mappings
       WHERE wrapup_code_id = $1 AND status = 'active' AND (campaign_id = $2 OR campaign_id IS NULL)
       ORDER BY CASE WHEN campaign_id = $2 THEN 0 ELSE 1 END
       LIMIT 1`,
      [dispositionCodeId, attempt.campaign_id],
    );
    const mapping = mappingResult.rows[0];
    if (!mapping) return NextResponse.json({ ok: false, error: "Disposition mapping not found" }, { status: 404 });
    if (mapping.requires_callback && !callbackAt) return NextResponse.json({ ok: false, error: "Callback date/time is required for this disposition" }, { status: 400 });

    const update = applyCampaignDispositionToLedger(attempt, mapping, { callback_at: callbackAt, notes });
    await pool.query(
      `UPDATE outbound_attempt_ledger
       SET status = $2, metadata = $3::jsonb, next_retry_at = $4, lease_expires_at = NULL, updated_at = NOW()
       WHERE id = $1`,
      [attemptId, update.status, JSON.stringify(update.metadata), update.next_retry_at],
    );
    if (update.contact_validation_status && attempt.contact_record_id) {
      await pool.query(
        `UPDATE outbound_contact_records SET validation_status = $2, updated_at = NOW() WHERE id = $1`,
        [attempt.contact_record_id, update.contact_validation_status],
      );
    }
    const agent_status = await readEffectiveAgentStatus(pool, String(user.id), "Offline");
    return NextResponse.json({ ok: true, attemptId, status: update.status, agent_status });
  } catch (err) {
    contactCenterRuntimeLogger.error("runtime_error", { ...runtimePayload({ error: typeof error !== "undefined" ? error : typeof err !== "undefined" ? err : undefined, status: typeof status !== "undefined" ? status : undefined }) });
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: err.status || 400 });
  }
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/agent/campaigns/disposition" });
export const POST = withPermission("agent:self", POST_handler, { route: "/api/contact-center/agent/campaigns/disposition" });
