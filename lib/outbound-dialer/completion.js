import { normalizeCampaignMaxAttempts, normalizeGlobalMaxAttempts } from "./attempt-limits.js";

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function deriveFailureReasonFromHangupOutcome(outcome = {}) {
  return String(outcome.reasonCode || outcome.reason_code || outcome.hangupCause || outcome.hangup_cause || "failed").trim() || "failed";
}

export async function loadCampaignMaxAttempts(pool, campaignRow) {
  const retryPolicy = parseJson(campaignRow?.retry_policy, {});
  const settingsResult = await pool.query(`SELECT settings FROM outbound_settings WHERE id='default' LIMIT 1`);
  const settings = settingsResult.rows?.[0]?.settings || {};
  const globalMaxAttempts = normalizeGlobalMaxAttempts(settings.global_max_attempts ?? settings.globalMaxAttempts);
  const campaignMaxAttempts = normalizeCampaignMaxAttempts(retryPolicy?.maxAttempts, 4, globalMaxAttempts);

  let maxAttemptsPerContact = campaignMaxAttempts;
  if (campaignRow?.attempt_control_id) {
    const attemptControlResult = await pool.query(
      `SELECT max_attempts_per_contact
       FROM outbound_attempt_controls
       WHERE id = $1 AND status <> 'archived'
       LIMIT 1`,
      [campaignRow.attempt_control_id],
    );
    const configured = Number(attemptControlResult.rows?.[0]?.max_attempts_per_contact);
    if (Number.isFinite(configured) && configured > 0) {
      maxAttemptsPerContact = Math.min(campaignMaxAttempts, Math.min(globalMaxAttempts, configured));
    }
  }

  return { globalMaxAttempts, campaignMaxAttempts, maxAttemptsPerContact };
}

export async function countRemainingCallableRecords(pool, campaignRow) {
  if (!pool || !campaignRow?.id || !campaignRow?.contact_list_id) return 0;
  const { maxAttemptsPerContact } = await loadCampaignMaxAttempts(pool, campaignRow);
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS remaining
     FROM outbound_contact_records r
     WHERE r.contact_list_id = $1
       AND r.validation_status = 'valid'
       AND (
         SELECT COUNT(*)
         FROM outbound_attempt_ledger la
         WHERE la.campaign_id = $2
           AND la.contact_record_id = r.id
           AND la.status IN ('claimed', 'dialing', 'answered', 'completed', 'failed')
       ) < $3
       AND NOT EXISTS (
         SELECT 1
         FROM outbound_attempt_ledger l
         WHERE l.campaign_id = $2
           AND l.contact_record_id = r.id
           AND l.status IN ('claimed', 'dialing', 'answered', 'completed')
           AND COALESCE(l.lease_expires_at, NOW() + INTERVAL '1 second') > NOW() - INTERVAL '5 seconds'
       )
       AND NOT EXISTS (
         SELECT 1
         FROM outbound_attempt_ledger lr
         WHERE lr.campaign_id = $2
           AND lr.contact_record_id = r.id
           AND NULLIF(lr.metadata->>'next_retry_at', '') IS NOT NULL
           AND (lr.metadata->>'next_retry_at')::timestamptz > NOW()
       )`,
    [campaignRow.contact_list_id, campaignRow.id, maxAttemptsPerContact],
  );
  return Number(rows?.[0]?.remaining || 0);
}

export async function completeCampaignIfExhausted(pool, campaignRow, username = "system") {
  if (!pool || !campaignRow?.id || campaignRow.status !== "running") return { completed: false, remaining: null };
  const activeResult = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status IN ('claimed', 'dialing', 'answered'))::int AS active,
       COUNT(*) FILTER (
         WHERE NULLIF(metadata->>'next_retry_at', '') IS NOT NULL
           AND (metadata->>'next_retry_at')::timestamptz > NOW()
       )::int AS future_retry
     FROM outbound_attempt_ledger
     WHERE campaign_id = $1`,
    [campaignRow.id],
  );
  const active = Number(activeResult.rows?.[0]?.active || 0);
  const futureRetry = Number(activeResult.rows?.[0]?.future_retry || 0);
  if (active > 0 || futureRetry > 0) return { completed: false, remaining: null, active, futureRetry };

  const remaining = await countRemainingCallableRecords(pool, campaignRow);
  if (remaining > 0) return { completed: false, remaining, active, futureRetry };

  const completionMetadata = {
    execution_state: "stopped",
    auto_completed_at: new Date().toISOString(),
    auto_completed_reason: "all_callable_records_exhausted",
    execution_control: {
      lastAction: "auto_complete",
      last_action: "auto_complete",
      updatedAt: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      updatedBy: username,
      updated_by: username,
    },
  };

  const { rows } = await pool.query(
    `UPDATE outbound_campaigns
     SET status = 'stopped',
         metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
         updated_by = $2,
         updated_at = NOW()
     WHERE id = $3 AND status = 'running'
     RETURNING *`,
    [JSON.stringify(completionMetadata), username, campaignRow.id],
  );

  await pool.query(
    `UPDATE outbound_campaign_runs
     SET status = 'completed',
         ended_at = COALESCE(ended_at, NOW()),
         ended_by = $2,
         stop_reason = COALESCE(stop_reason, 'all_callable_records_exhausted'),
         metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE campaign_id = $1 AND status = 'running'`,
    [campaignRow.id, username, JSON.stringify({ auto_completed: true, reason: "all_callable_records_exhausted" })],
  );

  return { completed: Boolean(rows[0]), remaining: 0, active: 0, campaign: rows[0] || null };
}
