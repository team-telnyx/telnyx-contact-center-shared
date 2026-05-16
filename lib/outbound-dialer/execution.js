import crypto from "crypto";
import { buildTelnyxV2Url } from "../telnyx.js";

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export async function startCampaignRun(pool, campaignId, username = "system") {
  const { rows } = await pool.query(
    `INSERT INTO outbound_campaign_runs (campaign_id, status, started_by)
     VALUES ($1, 'running', $2)
     RETURNING *`,
    [campaignId, username],
  );
  return rows[0] || null;
}

export async function updateCampaignExecutionControl(pool, campaignId, action, username = "system") {
  const { rows } = await pool.query(
    `SELECT id, metadata, status FROM outbound_campaigns WHERE id = $1 LIMIT 1`,
    [campaignId],
  );
  const campaign = rows[0];
  if (!campaign) return null;

  const metadata = parseJson(campaign.metadata, {});
  metadata.execution_control = {
    ...(metadata.execution_control || {}),
    lastAction: action,
    lastActionBy: username,
    lastActionAt: new Date().toISOString(),
  };

  const nextStatus =
    action === "start" || action === "resume"
      ? "running"
      : action === "pause"
        ? "paused"
        : action === "stop"
          ? "completed"
          : campaign.status;

  const update = await pool.query(
    `UPDATE outbound_campaigns
     SET status = $1,
         metadata = $2::jsonb,
         updated_by = $3,
         updated_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [nextStatus, JSON.stringify(metadata), username, campaignId],
  );

  return update.rows[0] || null;
}

export async function claimOneAgentlessRecord(pool, campaignRow, runId = null) {
  if (!campaignRow?.contact_list_id || !campaignRow?.id) return null;

  const retryPolicy = parseJson(campaignRow.retry_policy, {});
  const defaultMaxAttempts = Number.isFinite(Number(retryPolicy?.maxAttempts))
    ? Math.max(1, Number(retryPolicy.maxAttempts))
    : 4;

  let maxAttemptsPerContact = defaultMaxAttempts;
  if (campaignRow?.attempt_control_id) {
    const attemptControlResult = await pool.query(
      `SELECT max_attempts_per_contact
       FROM outbound_attempt_controls
       WHERE id = $1 AND status <> 'archived'
       LIMIT 1`,
      [campaignRow.attempt_control_id],
    );
    const configured = Number(
      attemptControlResult.rows?.[0]?.max_attempts_per_contact,
    );
    if (Number.isFinite(configured) && configured > 0) {
      maxAttemptsPerContact = configured;
    }
  }

  const claimKey = crypto.randomUUID();
  const claimResult = await pool.query(
    `WITH candidate AS (
      SELECT r.id
      FROM outbound_contact_records r
      WHERE r.contact_list_id = $1
        AND r.validation_status = 'valid'
        AND (
          SELECT COUNT(*)
          FROM outbound_attempt_ledger la
          WHERE la.campaign_id = $2
            AND la.contact_record_id = r.id
            AND la.status IN ('claimed', 'dialing', 'answered', 'completed', 'failed')
        ) < $8
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
        )
      ORDER BY COALESCE(r.last_attempt_at, 'epoch'::timestamptz) ASC, r.created_at ASC, r.id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    INSERT INTO outbound_attempt_ledger (
      campaign_id,
      run_id,
      contact_record_id,
      status,
      channel,
      handler_type,
      handler_ref,
      claim_key,
      lease_expires_at,
      attempt_reason,
      metadata
    )
    SELECT
      $2,
      $3,
      candidate.id,
      'claimed',
      $4,
      $5,
      $6,
      $7,
      NOW() + INTERVAL '90 seconds',
      'agentless_claim',
      jsonb_build_object('max_attempts_per_contact', $8)
    FROM candidate
    RETURNING *`,
    [
      campaignRow.contact_list_id,
      campaignRow.id,
      runId,
      campaignRow.channel || "voice",
      campaignRow.handler_type || null,
      campaignRow.handler_ref || null,
      claimKey,
      maxAttemptsPerContact,
    ],
  );

  const claim = claimResult.rows?.[0] || null;
  if (!claim) return null;

  await pool.query(
    `UPDATE outbound_contact_records
     SET last_attempt_at = NOW(),
         updated_at = NOW()
     WHERE id = $1`,
    [claim.contact_record_id],
  );

  return claim;
}

export async function completeAttemptClaim(pool, ledgerId, status = "completed", metadata = {}) {
  const terminalStatus = ["completed", "failed", "suppressed", "skipped", "cancelled"].includes(status)
    ? status
    : "completed";

  const { rows } = await pool.query(
    `UPDATE outbound_attempt_ledger
     SET status = $1,
         lease_expires_at = NULL,
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [terminalStatus, JSON.stringify(metadata || {}), ledgerId],
  );

  return rows[0] || null;
}

export function normalizeE164Like(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const normalized = raw.startsWith("+")
    ? `+${raw.slice(1).replace(/\D/g, "")}`
    : raw.replace(/\D/g, "");
  if (!/^\+?[1-9]\d{6,15}$/.test(normalized)) return null;
  return normalized.startsWith("+") ? normalized : `+${normalized}`;
}

export function pickContactPhoneNumber(contactRecord) {
  const methods = parseJson(contactRecord?.contact_methods, {});
  const rowData = parseJson(contactRecord?.row_data, {});

  const methodNumbers = [
    ...Object.values(methods?.number || {}),
    ...Object.values(methods?.voice || {}),
    ...Object.values(methods?.whatsapp || {}),
  ];

  const rowCandidates = [
    rowData?.phone_number,
    rowData?.phone,
    rowData?.mobile,
    rowData?.msisdn,
    rowData?.tel,
  ];

  for (const candidate of [...methodNumbers, ...rowCandidates]) {
    const normalized = normalizeE164Like(candidate);
    if (normalized) return normalized;
  }
  return null;
}

async function markAttemptStatus(pool, ledgerId, status, patchMetadata = {}) {
  const { rows } = await pool.query(
    `UPDATE outbound_attempt_ledger
     SET status = $1,
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [status, JSON.stringify(patchMetadata || {}), ledgerId],
  );
  return rows[0] || null;
}

export async function executeAgentlessAttempt(pool, campaignRow, ledgerRow) {
  if (!pool || !campaignRow?.id || !ledgerRow?.id) {
    return { ok: false, reason: "invalid_execution_context" };
  }

  const { rows: contactRows } = await pool.query(
    `SELECT id, row_data, contact_methods
     FROM outbound_contact_records
     WHERE id = $1
     LIMIT 1`,
    [ledgerRow.contact_record_id],
  );
  const contact = contactRows[0] || null;
  if (!contact) {
    await completeAttemptClaim(pool, ledgerRow.id, "failed", {
      failure_reason: "contact_not_found",
    });
    return { ok: false, reason: "contact_not_found" };
  }

  const toNumber = pickContactPhoneNumber(contact);
  if (!toNumber) {
    await completeAttemptClaim(pool, ledgerRow.id, "suppressed", {
      suppression_reason: "missing_callable_number",
    });
    return { ok: false, reason: "missing_callable_number" };
  }

  const fromNumber = normalizeE164Like(process.env.TELNYX_MAIN_FROM_NUMBER || "");
  if (!fromNumber) {
    await completeAttemptClaim(pool, ledgerRow.id, "failed", {
      failure_reason: "missing_telnyx_main_from_number",
    });
    return { ok: false, reason: "missing_telnyx_main_from_number" };
  }

  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) {
    await completeAttemptClaim(pool, ledgerRow.id, "failed", {
      failure_reason: "missing_telnyx_api_key",
    });
    return { ok: false, reason: "missing_telnyx_api_key" };
  }

  await markAttemptStatus(pool, ledgerRow.id, "dialing", {
    to_number: toNumber,
    from_number: fromNumber,
    dial_started_at: new Date().toISOString(),
  });

  const response = await fetch(buildTelnyxV2Url("/calls"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: toNumber,
      from: fromNumber,
      connection_id: process.env.TELNYX_CALL_CONTROL_ID || undefined,
      metadata: {
        outbound_campaign_id: campaignRow.id,
        outbound_run_id: ledgerRow.run_id,
        outbound_ledger_id: ledgerRow.id,
        outbound_handler_type: campaignRow.handler_type || null,
        outbound_handler_ref: campaignRow.handler_ref || null,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    await completeAttemptClaim(pool, ledgerRow.id, "failed", {
      failure_reason: "telnyx_dial_failed",
      telnyx_status: response.status,
      telnyx_error: String(errorText || "").slice(0, 1200),
    });
    return { ok: false, reason: "telnyx_dial_failed", status: response.status };
  }

  const dialResult = await response.json();
  const dialData = dialResult?.data || {};
  const { rows: boundRows } = await pool.query(
    `UPDATE outbound_attempt_ledger
     SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
         updated_at = NOW()
     WHERE id = $2
     RETURNING *`,
    [
      JSON.stringify({
        call_control_id: dialData.call_control_id || null,
        call_session_id: dialData.call_session_id || null,
        telnyx_call_status: dialData.call_status || null,
        dial_completed_at: new Date().toISOString(),
        execution_mode: "webhook_finalized",
      }),
      ledgerRow.id,
    ],
  );

  return {
    ok: true,
    ledger: boundRows?.[0] || null,
    telnyx: {
      call_control_id: dialData.call_control_id || null,
      call_session_id: dialData.call_session_id || null,
      call_status: dialData.call_status || null,
    },
  };
}

function deriveRetryPolicyTiming(retryPolicy) {
  const minDelayHours = Number(retryPolicy?.minDelayHours);
  if (Number.isFinite(minDelayHours) && minDelayHours > 0) {
    return Math.round(minDelayHours * 3600);
  }
  return 6 * 3600;
}

const TERMINAL_LEDGER_STATUSES = new Set(["completed", "failed", "suppressed", "skipped", "cancelled"]);

function classifyHangupOutcome(hangupCauseRaw) {
  const cause = String(hangupCauseRaw || "").trim().toLowerCase();
  if (["user_busy", "busy", "no_answer", "timeout", "temporarily_unavailable"].includes(cause)) {
    return { status: "failed", retryEligible: true, reasonCode: cause || "retryable_hangup" };
  }
  if (["call_rejected", "rejected", "cancelled", "canceled"].includes(cause)) {
    return { status: "cancelled", retryEligible: false, reasonCode: cause || "cancelled" };
  }
  return { status: "completed", retryEligible: false, reasonCode: cause || "normal_clearing" };
}

export async function finalizeAgentlessAttemptByWebhook(
  pool,
  { callControlId, eventType, hangupCause = null },
) {
  if (!pool || !callControlId || !eventType) return null;

  const { rows } = await pool.query(
    `SELECT *
     FROM outbound_attempt_ledger
     WHERE metadata->>'call_control_id' = $1
       AND status IN ('dialing', 'answered', 'claimed')
     ORDER BY created_at DESC
     LIMIT 1`,
    [callControlId],
  );
  let ledger = rows[0] || null;

  if (!ledger) {
    const { rows: anyRows } = await pool.query(
      `SELECT *
       FROM outbound_attempt_ledger
       WHERE metadata->>'call_control_id' = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [callControlId],
    );
    ledger = anyRows[0] || null;
    if (!ledger) return null;

    if (TERMINAL_LEDGER_STATUSES.has(String(ledger.status || "").toLowerCase())) {
      return {
        ...ledger,
        metadata: {
          ...parseJson(ledger.metadata, {}),
          ignored_webhook_event: eventType,
          ignored_reason: "already_terminal",
          ignored_at: new Date().toISOString(),
        },
      };
    }
  }

  if (eventType === "call.answered" || eventType === "call.bridged") {
    const { rows: answeredRows } = await pool.query(
      `UPDATE outbound_attempt_ledger
       SET status = 'answered',
           metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
           updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [
        JSON.stringify({
          answered_at: new Date().toISOString(),
          telnyx_event_type: eventType,
        }),
        ledger.id,
      ],
    );
    return answeredRows[0] || null;
  }

  if (eventType === "call.hangup") {
    const { rows: campaignRows } = await pool.query(
      `SELECT retry_policy
       FROM outbound_campaigns
       WHERE id = $1
       LIMIT 1`,
      [ledger.campaign_id],
    );
    const retryPolicy = parseJson(campaignRows?.[0]?.retry_policy, {});
    const retryAfterSeconds = deriveRetryPolicyTiming(retryPolicy);
    const outcome = classifyHangupOutcome(hangupCause);

    const now = Date.now();
    const nextRetryAt = outcome.retryEligible
      ? new Date(now + retryAfterSeconds * 1000).toISOString()
      : null;

    return completeAttemptClaim(pool, ledger.id, outcome.status, {
      completed_at: new Date(now).toISOString(),
      telnyx_event_type: eventType,
      hangup_cause: hangupCause || null,
      reason_code: outcome.reasonCode,
      retry_eligible: outcome.retryEligible,
      retry_after_seconds: outcome.retryEligible ? retryAfterSeconds : null,
      next_retry_at: nextRetryAt,
    });
  }

  return null;
}
