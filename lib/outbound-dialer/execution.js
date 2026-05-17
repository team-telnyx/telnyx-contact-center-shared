import crypto from "crypto";
import { buildTelnyxV2Url } from "../telnyx.js";

function normalizeComparable(value) {
  if (value == null) return "";
  return String(value).trim();
}

function conditionMatches(rowData = {}, condition = {}) {
  const field = String(condition?.field || "").trim();
  if (!field) return true;
  const operator = String(condition?.operator || "is present").toLowerCase();
  const actual = normalizeComparable(rowData?.[field]);
  const expected = normalizeComparable(condition?.value);
  const actualNum = Number(actual);
  const expectedNum = Number(expected);

  if (operator === "is present") return actual.length > 0;
  if (operator === "equals") return actual === expected;
  if (operator === "does not equal") return actual !== expected;
  if (operator === "contains") return actual.toLowerCase().includes(expected.toLowerCase());
  if (operator === "greater than") return Number.isFinite(actualNum) && Number.isFinite(expectedNum) && actualNum > expectedNum;
  if (operator === "less than") return Number.isFinite(actualNum) && Number.isFinite(expectedNum) && actualNum < expectedNum;
  if (operator === "before") return actual < expected;
  if (operator === "after") return actual > expected;
  return true;
}

function recordMatchesFilter(rowData = {}, conditions = []) {
  return (Array.isArray(conditions) ? conditions : []).every((condition) => conditionMatches(rowData, condition));
}

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
  if (!pool || !campaignId) return null;
  const { rows } = await pool.query(
    `INSERT INTO outbound_campaign_runs (campaign_id, status, started_by)
     VALUES ($1, 'running', $2)
     RETURNING *`,
    [campaignId, username],
  );
  return rows[0] || null;
}

export async function closeCampaignRun(pool, campaignId, status = "stopped", username = "system", reason = null, metadata = {}) {
  if (!pool || !campaignId) return null;
  const normalizedStatus = ["running", "paused", "stopped", "completed", "failed"].includes(status) ? status : "stopped";
  const { rows } = await pool.query(
    `UPDATE outbound_campaign_runs
     SET status = $1,
         stopped_by = $2,
         stop_reason = COALESCE($3, stop_reason),
         stopped_at = COALESCE(stopped_at, NOW()),
         metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
         updated_at = NOW()
     WHERE id = (
       SELECT id FROM outbound_campaign_runs
       WHERE campaign_id = $5 AND status IN ('running','paused')
       ORDER BY started_at DESC
       LIMIT 1
     )
     RETURNING *`,
    [normalizedStatus, username, reason, JSON.stringify(metadata || {}), campaignId],
  );
  return rows[0] || null;
}

export async function recycleCampaignRecords(pool, campaignId, username = "system") {
  if (!pool || !campaignId) return { updatedCampaign: null, recycledAttempts: 0 };

  const recycled = await pool.query(
    `UPDATE outbound_attempt_ledger
     SET status = CASE
           WHEN status IN ('claimed','dialing','answered') THEN 'cancelled'
           ELSE status
         END,
         lease_expires_at = NULL,
         metadata = (COALESCE(metadata, '{}'::jsonb) - 'next_retry_at') || jsonb_build_object('recycled_at', NOW()::text, 'recycled_by', $2::text),
         updated_at = NOW()
     WHERE campaign_id = $1
       AND status IN ('claimed','dialing','answered','suppressed','skipped','cancelled')
     RETURNING id`,
    [campaignId, username],
  );

  const updatedCampaign = await updateCampaignExecutionControl(pool, campaignId, "recycle", username);
  return { updatedCampaign, recycledAttempts: recycled.rowCount || 0 };
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
  metadata.execution_state =
    action === "start" || action === "resume"
      ? "running"
      : action === "pause"
        ? "paused"
        : action === "stop"
          ? "stopped"
          : action === "recycle"
            ? "recycled"
            : metadata.execution_state || campaign.status;

  const nextStatus =
    action === "start" || action === "resume"
      ? "running"
      : action === "pause"
        ? "paused"
        : action === "stop"
          ? "completed"
          : action === "recycle"
            ? "ready"
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
  const campaignMaxAttempts = Number.isFinite(Number(retryPolicy?.maxAttempts))
    ? Math.max(1, Math.min(5, Number(retryPolicy.maxAttempts)))
    : 4;

  let maxAttemptsPerContact = campaignMaxAttempts;
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
      maxAttemptsPerContact = Math.min(campaignMaxAttempts, Math.min(5, configured));
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
         failure_reason = COALESCE($4, failure_reason),
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [terminalStatus, JSON.stringify(metadata || {}), ledgerId, metadata?.failure_reason || null],
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

function pickCampaignPhoneNumber(contactRecord, campaignRow) {
  const metadata = parseJson(campaignRow?.metadata, {});
  const preferredFields = Array.isArray(metadata?.contact_list_numbers)
    ? metadata.contact_list_numbers.filter((x) => typeof x === "string" && x.trim())
    : [];
  if (!preferredFields.length) return pickContactPhoneNumber(contactRecord);
  const rowData = parseJson(contactRecord?.row_data, {});
  for (const field of preferredFields) {
    const normalized = normalizeE164Like(rowData?.[field]);
    if (normalized) return normalized;
  }
  return pickContactPhoneNumber(contactRecord);
}

function normalizePhoneForDnc(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || null;
}

function resolveOutboundWebhookBaseUrl() {
  const candidates = [
    process.env.TELNYX_WEBHOOK_BASE_URL,
    process.env.NEXTAUTH_URL,
    process.env.APP_BASE_URL,
    process.env.NEXT_PUBLIC_BASE_URL,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    if (value) return value.replace(/\/$/, "");
  }
  return null;
}

function resolveWebhookUrlForCampaign(campaignRow) {
  const base = resolveOutboundWebhookBaseUrl();
  if (!base) return null;
  if (campaignRow?.handler_type === "call_flow" && campaignRow?.handler_ref) {
    return `${base}/api/voice/webhook/incoming/${campaignRow.handler_ref}`;
  }
  return `${base}/api/voice/webhook`;
}

async function isSuppressedByDnc(pool, campaignRow, toNumber) {
  const metadata = parseJson(campaignRow?.metadata, {});
  const dncListId = metadata?.dnc_list_id || null;
  if (!dncListId) return false;
  const normalized = normalizePhoneForDnc(toNumber);
  if (!normalized) return false;
  const { rows } = await pool.query(
    `SELECT 1 FROM outbound_dnc_entries
     WHERE dnc_list_id = $1
       AND value_type = 'phone'
       AND normalized_value = $2
     LIMIT 1`,
    [dncListId, normalized],
  );
  return !!rows[0];
}

async function passesCampaignFilter(pool, campaignRow, contactRecord) {
  const metadata = parseJson(campaignRow?.metadata, {});
  const filterId =
    metadata?.contact_list_filter_id ||
    metadata?.filter_id ||
    null;
  if (!filterId) return true;
  const { rows } = await pool.query(
    `SELECT conditions FROM outbound_contact_filters
     WHERE id = $1 AND status <> 'archived'
     LIMIT 1`,
    [filterId],
  );
  const conditions = Array.isArray(rows?.[0]?.conditions) ? rows[0].conditions : [];
  return recordMatchesFilter(parseJson(contactRecord?.row_data, {}), conditions);
}

function currentTimeParts(timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const weekdayMap = { mon: "mon", tue: "tue", wed: "wed", thu: "thu", fri: "fri", sat: "sat", sun: "sun" };
  const weekday = weekdayMap[String(parts.weekday || "").slice(0, 3).toLowerCase()] || null;
  const minutes = (Number(parts.hour || 0) * 60) + Number(parts.minute || 0);
  return { weekday, minutes };
}

function parseHm(value, fallbackMinutes) {
  const m = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return fallbackMinutes;
  const hh = Math.max(0, Math.min(23, Number(m[1])));
  const mm = Math.max(0, Math.min(59, Number(m[2])));
  return (hh * 60) + mm;
}

async function passesTimeSet(pool, campaignRow) {
  const metadata = parseJson(campaignRow?.metadata, {});
  const timeSetId =
    metadata?.contactable_time_set_id ||
    metadata?.time_set_id ||
    null;
  if (!timeSetId) return true;
  const { rows } = await pool.query(
    `SELECT timezone, windows FROM outbound_time_sets
     WHERE id = $1 AND status <> 'archived'
     LIMIT 1`,
    [timeSetId],
  );
  const timeSet = rows?.[0];
  if (!timeSet) return true;
  const windows = Array.isArray(timeSet.windows) ? timeSet.windows : [];
  if (!windows.length) return true;
  const now = currentTimeParts(timeSet.timezone || "UTC");
  const active = windows.find((w) => String(w?.day || "").toLowerCase() === now.weekday && w?.enabled !== false);
  if (!active) return false;
  const start = parseHm(active.start, 0);
  const end = parseHm(active.end, 24 * 60);
  return now.minutes >= start && now.minutes <= end;
}

async function withinAttemptControlPerNumber(pool, campaignRow, contactRecordId, toNumber) {
  if (!campaignRow?.attempt_control_id) return true;
  const retryPolicy = parseJson(campaignRow.retry_policy, {});
  const campaignMaxAttempts = Number.isFinite(Number(retryPolicy?.maxAttempts))
    ? Math.max(1, Math.min(5, Number(retryPolicy.maxAttempts)))
    : 4;
  const cfg = await pool.query(
    `SELECT max_attempts_per_number FROM outbound_attempt_controls
     WHERE id = $1 AND status <> 'archived'
     LIMIT 1`,
    [campaignRow.attempt_control_id],
  );
  const configuredMaxAttempts = Number(cfg.rows?.[0]?.max_attempts_per_number || 0);
  if (!Number.isFinite(configuredMaxAttempts) || configuredMaxAttempts <= 0) return true;
  const maxAttempts = Math.min(campaignMaxAttempts, Math.min(5, configuredMaxAttempts));
  const count = await pool.query(
    `SELECT COUNT(*)::int AS attempts
     FROM outbound_attempt_ledger
     WHERE campaign_id = $1
       AND contact_record_id = $2
       AND status IN ('dialing','answered','completed','failed')
       AND metadata->>'to_number' = $3`,
    [campaignRow.id, contactRecordId, toNumber],
  );
  return Number(count.rows?.[0]?.attempts || 0) < maxAttempts;
}

function normalizeFromNumberList(values = []) {
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = normalizeE164Like(value);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

async function resolveCampaignFromNumber(pool, campaignRow, ledgerRow) {
  const settingsResult = await pool.query(`SELECT settings FROM outbound_settings WHERE id='default' LIMIT 1`);
  const settings = parseJson(settingsResult.rows?.[0]?.settings, {});
  const allowedNumbers = normalizeFromNumberList(settings.allowed_numbers || settings.allowedNumbers || []);
  const metadata = parseJson(campaignRow?.metadata, {});
  const configured = normalizeFromNumberList(metadata.from_numbers || metadata.allowed_from_numbers || []);
  const rotateNumbers = metadata.rotate_numbers === true;
  const campaignNumbers = configured.filter((number) => allowedNumbers.includes(number));
  const selectedNumbers = rotateNumbers ? campaignNumbers.slice(0, 5) : campaignNumbers.slice(0, 1);
  const fallbackNumber = normalizeE164Like(process.env.TELNYX_MAIN_FROM_NUMBER || "");
  const numbers = selectedNumbers.length ? selectedNumbers : (fallbackNumber ? [fallbackNumber] : []);
  if (!numbers.length) return { number: null, sequence: [], rotate: rotateNumbers, attemptIndex: 0 };

  if (!rotateNumbers || numbers.length === 1) {
    return { number: numbers[0], sequence: numbers, rotate: false, attemptIndex: 0 };
  }

  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS attempts
     FROM outbound_attempt_ledger
     WHERE campaign_id = $1
       AND contact_record_id = $2
       AND id <> $3`,
    [campaignRow.id, ledgerRow.contact_record_id, ledgerRow.id],
  );
  const attemptIndex = Math.max(0, Number(rows?.[0]?.attempts || 0));
  const clamped = Math.min(attemptIndex, numbers.length - 1);
  return { number: numbers[clamped], sequence: numbers, rotate: true, attemptIndex: clamped };
}

async function markAttemptStatus(pool, ledgerId, status, patchMetadata = {}) {
  const { rows } = await pool.query(
    `UPDATE outbound_attempt_ledger
     SET status = $1,
         failure_reason = COALESCE($4, failure_reason),
         metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
         updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [status, JSON.stringify(patchMetadata || {}), ledgerId, patchMetadata?.failure_reason || null],
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

  const toNumber = pickCampaignPhoneNumber(contact, campaignRow);
  if (!toNumber) {
    await completeAttemptClaim(pool, ledgerRow.id, "suppressed", {
      suppression_reason: "missing_callable_number",
    });
    return { ok: false, reason: "missing_callable_number" };
  }

  if (!(await passesCampaignFilter(pool, campaignRow, contact))) {
    await completeAttemptClaim(pool, ledgerRow.id, "suppressed", {
      suppression_reason: "filtered_out",
      to_number: toNumber,
    });
    return { ok: false, reason: "filtered_out" };
  }

  if (await isSuppressedByDnc(pool, campaignRow, toNumber)) {
    await completeAttemptClaim(pool, ledgerRow.id, "suppressed", {
      suppression_reason: "dnc_match",
      to_number: toNumber,
    });
    return { ok: false, reason: "dnc_match" };
  }

  if (!(await passesTimeSet(pool, campaignRow))) {
    await completeAttemptClaim(pool, ledgerRow.id, "skipped", {
      skip_reason: "outside_time_set",
      to_number: toNumber,
      next_retry_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });
    return { ok: false, reason: "outside_time_set" };
  }

  if (!(await withinAttemptControlPerNumber(pool, campaignRow, contact.id, toNumber))) {
    await completeAttemptClaim(pool, ledgerRow.id, "suppressed", {
      suppression_reason: "max_attempts_per_number_reached",
      to_number: toNumber,
    });
    return { ok: false, reason: "max_attempts_per_number_reached" };
  }

  const fromResolution = await resolveCampaignFromNumber(pool, campaignRow, ledgerRow);
  const fromNumber = fromResolution.number;
  if (!fromNumber) {
    await completeAttemptClaim(pool, ledgerRow.id, "failed", {
      failure_reason: "missing_campaign_from_number",
    });
    return { ok: false, reason: "missing_campaign_from_number" };
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
    from_number_sequence: fromResolution.sequence,
    from_number_rotate_enabled: fromResolution.rotate,
    from_number_attempt_index: fromResolution.attemptIndex,
    dial_started_at: new Date().toISOString(),
  });

  const webhookUrl = resolveWebhookUrlForCampaign(campaignRow);
  const telnyxPayload = {
    to: toNumber,
    from: fromNumber,
    connection_id: process.env.TELNYX_CALL_CONTROL_ID || undefined,
    webhook_url: webhookUrl || undefined,
    webhook_url_method: webhookUrl ? "POST" : undefined,
    command_id: `outbound-${ledgerRow.id}`,
    metadata: {
      outbound_campaign_id: campaignRow.id,
      outbound_run_id: ledgerRow.run_id,
      outbound_ledger_id: ledgerRow.id,
      outbound_handler_type: campaignRow.handler_type || null,
      outbound_handler_ref: campaignRow.handler_ref || null,
    },
  };

  const response = await fetch(buildTelnyxV2Url("/calls"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(telnyxPayload),
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
     SET call_control_id = COALESCE($1, call_control_id),
         call_session_id = COALESCE($2, call_session_id),
         metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
         updated_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [
      dialData.call_control_id || null,
      dialData.call_session_id || null,
      JSON.stringify({
        call_control_id: dialData.call_control_id || null,
        call_session_id: dialData.call_session_id || null,
        telnyx_call_status: dialData.call_status || null,
        dial_completed_at: new Date().toISOString(),
        execution_mode: "webhook_finalized",
        webhook_url: webhookUrl || null,
        outbound_handler_type: campaignRow.handler_type || null,
        outbound_handler_ref: campaignRow.handler_ref || null,
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

function classifyHangupOutcome({ hangupCauseRaw, sipHangupCauseRaw = null } = {}) {
  const cause = String(hangupCauseRaw || "").trim().toLowerCase();
  const sipCause = String(sipHangupCauseRaw || "").trim();

  const RETRYABLE_CAUSES = new Set([
    "user_busy",
    "busy",
    "no_answer",
    "timeout",
    "temporarily_unavailable",
    "not_found",
    "unspecified",
  ]);

  const CANCELLED_CAUSES = new Set([
    "call_rejected",
    "rejected",
    "cancelled",
    "canceled",
    "originator_cancel",
  ]);

  const NON_RETRY_COMPLETED_CAUSES = new Set([
    "normal_clearing",
    "time_limit",
  ]);

  const RETRYABLE_SIP_CAUSES = new Set(["480", "486", "487", "503", "408"]);

  if (RETRYABLE_CAUSES.has(cause) || RETRYABLE_SIP_CAUSES.has(sipCause)) {
    return {
      status: "failed",
      retryEligible: true,
      reasonCode: cause || `sip_${sipCause || "retryable"}`,
    };
  }

  if (CANCELLED_CAUSES.has(cause)) {
    return { status: "cancelled", retryEligible: false, reasonCode: cause || "cancelled" };
  }

  if (NON_RETRY_COMPLETED_CAUSES.has(cause)) {
    return { status: "completed", retryEligible: false, reasonCode: cause };
  }

  return { status: "completed", retryEligible: false, reasonCode: cause || "normal_clearing" };
}

function mergeProcessedEventIds(metadata, eventId) {
  const existing = Array.isArray(metadata?.processed_event_ids)
    ? metadata.processed_event_ids.filter((x) => typeof x === "string" && x.trim())
    : [];
  if (!eventId) return existing.slice(-20);
  const next = [...existing.filter((id) => id !== eventId), eventId];
  return next.slice(-20);
}

function hasProcessedEventId(metadata, eventId) {
  if (!eventId) return false;
  const ids = Array.isArray(metadata?.processed_event_ids) ? metadata.processed_event_ids : [];
  return ids.includes(eventId);
}

async function registerWebhookEventOnce(pool, { eventId, callControlId, eventType }) {
  if (!eventId) return { shouldProcess: true, dedupeSource: "none" };

  const { rows } = await pool.query(
    `INSERT INTO outbound_webhook_events (
       event_id,
       call_control_id,
       event_type,
       metadata
     )
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING event_id`,
    [
      eventId,
      callControlId || null,
      eventType || null,
      JSON.stringify({ ingestion_source: "voice_webhook" }),
    ],
  );

  if (!rows?.[0]) {
    return { shouldProcess: false, dedupeSource: "db_unique_event_id" };
  }

  return { shouldProcess: true, dedupeSource: "db_unique_event_id" };
}

export async function finalizeAgentlessAttemptByWebhook(
  pool,
  { callControlId, eventType, hangupCause = null, sipHangupCause = null, eventId = null },
) {
  if (!pool || !callControlId || !eventType) return null;

  const dedupe = await registerWebhookEventOnce(pool, {
    eventId,
    callControlId,
    eventType,
  });

  if (!dedupe.shouldProcess) {
    return {
      status: "ignored",
      metadata: {
        ignored_webhook_event: eventType,
        ignored_reason: "duplicate_event_id_db",
        ignored_event_id: eventId,
        ignored_at: new Date().toISOString(),
      },
    };
  }

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

  const ledgerMetadata = parseJson(ledger.metadata, {});
  if (hasProcessedEventId(ledgerMetadata, eventId)) {
    return {
      ...ledger,
      metadata: {
        ...ledgerMetadata,
        ignored_webhook_event: eventType,
        ignored_reason: "duplicate_event_id",
        ignored_event_id: eventId,
        ignored_at: new Date().toISOString(),
      },
    };
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
          processed_event_ids: mergeProcessedEventIds(ledgerMetadata, eventId),
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
    const outcome = classifyHangupOutcome({ hangupCauseRaw: hangupCause, sipHangupCauseRaw: sipHangupCause });

    const now = Date.now();
    const nextRetryAt = outcome.retryEligible
      ? new Date(now + retryAfterSeconds * 1000).toISOString()
      : null;

    return completeAttemptClaim(pool, ledger.id, outcome.status, {
      completed_at: new Date(now).toISOString(),
      telnyx_event_type: eventType,
      hangup_cause: hangupCause || null,
      sip_hangup_cause: sipHangupCause || null,
      reason_code: outcome.reasonCode,
      retry_eligible: outcome.retryEligible,
      retry_after_seconds: outcome.retryEligible ? retryAfterSeconds : null,
      next_retry_at: nextRetryAt,
      processed_event_ids: mergeProcessedEventIds(ledgerMetadata, eventId),
    });
  }

  return null;
}
