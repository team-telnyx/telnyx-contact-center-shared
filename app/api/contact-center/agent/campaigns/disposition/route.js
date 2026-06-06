import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { applyCampaignDispositionToLedger } from "@/lib/outbound-dialer/campaign-dispositions";
import { setUserStatus } from "@/lib/contact-center/user-status";

function usernameFor(user) {
  return user?.username || user?.email || null;
}

async function restoreAgentAfterCampaignDisposition(pool, agentUsername, ledgerMetadata = {}) {
  const previous = ledgerMetadata.previous_agent_status;
  const nextStatus = previous && !["On Outbound Call", "On Campaign Call", "Agent Not Answering"].includes(previous) ? previous : "Available";
  const { rows } = await pool.query(
    `SELECT u.id, s.agent_status AS current_agent_status
       FROM users u
       LEFT JOIN cc_agent_state s ON s.user_id = u.id
      WHERE u.email = $1 OR u.username = $1
      LIMIT 1`,
    [agentUsername],
  );
  const user = rows[0];
  if (!user?.id) return nextStatus;
  await setUserStatus({
    userId: String(user.id),
    username: agentUsername,
    status: nextStatus,
    previousStatus: user.current_agent_status || "Unknown",
  });
  return nextStatus;
}

export async function GET(request) {
  try {
    const user = await getAuthenticatedUser();
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
    return NextResponse.json({ ok: true, dispositionCodes: rows });
  } catch (err) {
    console.error("[Agent Campaigns] disposition codes failed:", err);
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: 400 });
  }
}

export async function POST(request) {
  try {
    const user = await getAuthenticatedUser();
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
    const agent_status = await restoreAgentAfterCampaignDisposition(pool, agentUsername, attempt.metadata || {});
    return NextResponse.json({ ok: true, attemptId, status: update.status, agent_status });
  } catch (err) {
    console.error("[Agent Campaigns] disposition submit failed:", err);
    return NextResponse.json({ ok: false, error: err.message || "Server error" }, { status: 400 });
  }
}
