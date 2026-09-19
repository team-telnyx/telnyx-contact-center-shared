// Call Generator — originate engine & call lifecycle (T2)
//
// Gated by the admin Settings master switch (cg_settings.enabled). Flipping
// the toggle in Settings is the only switch — no env flag, no restart needed.
// Generated calls carry client_state { callGenerator: true, runId, ledgerId }
// (base64 JSON, same convention as the outbound dialer) so the dedicated
// webhook endpoint can correlate Telnyx events back to cg_call_ledger rows.
//
// Ledger state machine:
//   pending → dialing → ringing → answered → talking → completed
//                                  ↘ failed / abandoned
import { buildTelnyxV2Url } from "../telnyx.js";
import { createHash } from "node:crypto";
import { generatorInboundHeaders } from './inbound-identity.mjs';

// Master switch lives in the database (cg_settings.enabled) so toggling the
// generator in admin Settings is sufficient — no env var, no restart.
export async function isCallGeneratorEnabled(pool) {
  if (!pool) return false;
  try {
    const { rows } = await pool.query(`SELECT settings FROM cg_settings WHERE id = 'default' LIMIT 1`);
    return rows[0]?.settings?.enabled === true;
  } catch {
    return false;
  }
}

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error("TELNYX_API_KEY environment variable is required");
  return apiKey;
}

function resolveWebhookBaseUrl() {
  const candidates = [
    process.env.CALL_GENERATOR_WEBHOOK_BASE_URL,
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

export function buildGeneratorClientState({ runId, ledgerId }) {
  return Buffer.from(
    JSON.stringify({ callGenerator: true, runId, ledgerId }),
  ).toString("base64");
}

export function parseGeneratorClientState(clientState) {
  try {
    const decoded = JSON.parse(Buffer.from(String(clientState || ""), "base64").toString("utf8"));
    if (decoded && decoded.callGenerator === true) return decoded;
    return null;
  } catch {
    return null;
  }
}

// Resolve scenario task target into a dialable destination.
// target_type 'call_flow' → SIP URI using flowId as sip_subdomain.
// target_type 'sip'       → raw SIP URI passthrough.
// target_type 'pstn'      → E.164 (must pass whitelist check upstream).
export function resolveDialTarget(task) {
  const targetType = String(task?.target_type || "").toLowerCase();
  const target = String(task?.target || "").trim();
  if (!target) return null;
  if (targetType === "call_flow") return `sip:gen@${target}.sip.telnyx.com`;
  if (targetType === "sip") return target.startsWith("sip:") ? target : `sip:${target}`;
  if (targetType === "pstn") return target;
  return null;
}

export function pstnWhitelistFromConfig(config) {
  const list = Array.isArray(config?.pstnWhitelist) ? config.pstnWhitelist : [];
  return list.map((n) => String(n || "").replace(/\D/g, "")).filter(Boolean);
}

export function isPstnTargetAllowed(target, whitelist) {
  const digits = String(target || "").replace(/\D/g, "");
  if (!digits) return false;
  return whitelist.includes(digits);
}

// Originate a single generated call and persist Telnyx identifiers on the
// ledger row. Returns { ok, reason?, callControlId? }.
export async function originateGeneratedCall(pool, { run, ledgerRow, task, fromNumber }) {
  if (!(await isCallGeneratorEnabled(pool))) {
    if (ledgerRow?.id) {
      await markLedgerStatus(pool, ledgerRow.id, "failed", { reason: "call_generator_disabled", dial_rejected: true });
    }
    return { ok: false, reason: "call_generator_disabled" };
  }
  let apiKey;
  try {apiKey=getApiKey();} catch {await markLedgerStatus(pool,ledgerRow.id,'failed',{reason:'missing_api_key',dial_rejected:true});return {ok:false,reason:'missing_api_key'};}
  const destination = resolveDialTarget(task);
  if (!destination) {
    await markLedgerStatus(pool, ledgerRow.id, "failed", { reason: "invalid_target", dial_rejected: true });
    return { ok: false, reason: "invalid_target" };
  }
  if (String(task?.target_type || "").toLowerCase() === "pstn") {
    const whitelist = pstnWhitelistFromConfig(run?.config || {});
    if (!isPstnTargetAllowed(destination, whitelist)) {
      await markLedgerStatus(pool, ledgerRow.id, "failed", { reason: "pstn_not_whitelisted", dial_rejected: true });
      return { ok: false, reason: "pstn_not_whitelisted" };
    }
  }

  const base = resolveWebhookBaseUrl();
  const webhookUrl = base ? `${base}/api/call-generator/webhook` : null;
  // Hand the max call duration to Telnyx via time_limit_secs so the platform
  // enforces the hangup at exactly the configured time (per-scenario override
  // → global Settings → default), instead of relying solely on the app-side
  // hangup timer in runPostAnswerActions. The runner resolves the effective
  // limit (effectiveRunLimits) and passes it down as
  // run.config.postAnswer.maxDurationSecs.
  const timeLimitSecs = Number(run?.config?.postAnswer?.maxDurationSecs) > 0
    ? Math.min(86400, Math.max(10, Math.round(Number(run.config.postAnswer.maxDurationSecs))))
    : undefined;
  const payload = {
    to: destination,
    from: fromNumber,
    connection_id: process.env.TELNYX_CALL_CONTROL_ID || undefined,
    webhook_url: webhookUrl || undefined,
    webhook_url_method: webhookUrl ? "POST" : undefined,
    timeout_secs: Number(run?.config?.dialTimeoutSecs) > 0 ? Number(run.config.dialTimeoutSecs) : 30,
    time_limit_secs: timeLimitSecs,
    command_id: `cg-${ledgerRow.id}`,
    client_state: buildGeneratorClientState({ runId: run.id, ledgerId: ledgerRow.id }),
    custom_headers: task.target_type === 'call_flow'
      ? generatorInboundHeaders({
          runId: run.id,
          ledgerId: ledgerRow.id,
          flowId: task.target,
          directAgentId: task.direct_agent_id || null,
        }, apiKey)
      : undefined,
  };

  await markLedgerStatus(pool, ledgerRow.id, "dialing", { dial_started_at: new Date().toISOString() });

  let response;
  try {
    response = await fetch(buildTelnyxV2Url("/calls"), {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    await pool.query(`UPDATE cg_call_ledger SET result = COALESCE(result,'{}'::jsonb) || '{"origination_unknown":true}'::jsonb WHERE id = $1`, [ledgerRow.id]);
    return { ok: false, reason: "origination_unknown" };
  }

  if (!response.ok) {
    // A server error may occur after the provider accepted the call. Never
    // originate a replacement for an unknown outcome.
    const rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
    if (rejected) await markLedgerStatus(pool, ledgerRow.id, "failed", {
      reason: "telnyx_dial_failed", telnyx_status: response.status, dial_rejected: true,
    });
    else await pool.query(`UPDATE cg_call_ledger SET result = COALESCE(result,'{}'::jsonb) || '{"origination_unknown":true}'::jsonb WHERE id=$1`, [ledgerRow.id]);
    return { ok: false, reason: rejected ? "telnyx_dial_failed" : "origination_unknown", status: response.status };
  }

  let dialResult;
  try { dialResult = await response.json(); } catch { dialResult=null; }
  const dialData = dialResult?.data || {};
  if (!dialData.call_control_id) {
    await pool.query(`UPDATE cg_call_ledger SET result=COALESCE(result,'{}'::jsonb)||'{"origination_unknown":true}'::jsonb WHERE id=$1`,[ledgerRow.id]);
    return {ok:false,reason:'origination_unknown'};
  }
  const bound=await pool.query(
    `UPDATE cg_call_ledger
     SET call_control_id = COALESCE(call_control_id, $1),
         call_session_id = COALESCE(call_session_id, $2),
         to_number = COALESCE(to_number, $3),
         from_number = COALESCE(from_number, $4),
         started_at = COALESCE(started_at, NOW())
     WHERE id = $5 AND (call_control_id IS NULL OR call_control_id = $1)`,
    [dialData.call_control_id || null, dialData.call_session_id || null, destination, fromNumber || null, ledgerRow.id],
  );
  if(bound.rowCount===0) {
    await pool.query(`UPDATE cg_call_ledger SET result=COALESCE(result,'{}'::jsonb)||'{"provider_identity_conflict":true}'::jsonb WHERE id=$1`,[ledgerRow.id]);
    return {ok:false,reason:'provider_identity_conflict'};
  }
  return { ok: true, callControlId: dialData.call_control_id || null };
}

// Allowed state transitions — CAS-style guards so replayed/ooo webhooks
// can never move a call backwards.
const TRANSITIONS = {
  pending: ["dialing", "failed"],
  dialing: ["ringing", "answered", "talking", "completed", "failed", "abandoned"],
  ringing: ["answered", "talking", "completed", "failed", "abandoned"],
  answered: ["talking", "completed", "failed"],
  talking: ["completed", "failed"],
};

export function canTransition(from, to) {
  return (TRANSITIONS[String(from || "pending")] || []).includes(String(to || ""));
}

export async function markLedgerStatus(pool, ledgerId, status, resultPatch = {}) {
  const { rows } = await pool.query("SELECT status FROM cg_call_ledger WHERE id = $1", [ledgerId]);
  if (!rows.length) return false;
  const current = rows[0].status;
  if (current !== status && !canTransition(current, status)) return false;
  const setAnswered = ["answered", "talking"].includes(status) ? ", answered_at = COALESCE(answered_at, NOW())" : "";
  const setEnded = ["completed", "failed", "abandoned"].includes(status)
    ? ", ended_at = COALESCE(ended_at, NOW()), duration_ms = COALESCE(duration_ms, (EXTRACT(EPOCH FROM (NOW() - COALESCE(answered_at, started_at, created_at))) * 1000)::int)"
    : "";
  const { rowCount } = await pool.query(
    `UPDATE cg_call_ledger
     SET status = $1, result = COALESCE(result, '{}'::jsonb) || $2::jsonb${setAnswered}${setEnded}
     WHERE id = $3 AND status = $4`,
    [status, JSON.stringify(resultPatch || {}), ledgerId, current],
  );
  return rowCount > 0;
}

// Webhook effects are only database writes. The durable executor performs media
// commands after intake has committed; event retries can safely schedule again.
export async function handleGeneratorWebhookEvent(pool, eventType, payload) {
  const state = parseGeneratorClientState(payload?.client_state);
  if (!state?.ledgerId) return null;
  const id = state.ledgerId;
  if (eventType === "call.hangup") {
    await pool.query(`UPDATE cg_call_ledger SET media_ended_at = COALESCE(media_ended_at, now()) WHERE id = $1`, [id]);
    await markLedgerStatus(pool, id, "completed", { event: eventType, hangup_cause: payload.hangup_cause || null });
    return "completed";
  }
  const status = { "call.initiated": "dialing", "call.ringing": "ringing", "call.answered": "answered" }[eventType];
  if (!status) return null;
  await markLedgerStatus(pool, id, status, { event: eventType });
  return status;
}

export async function runPostAnswerActions(pool, ledgerId, _payload, { executeSequence = true } = {}) {
  if (!executeSequence) return;
  const { scheduleGeneratorActions } = await import("./commands.mjs");
  await scheduleGeneratorActions(pool, ledgerId);
}

export async function hangupGeneratedCall(callControlId) {
  if (!callControlId) return false;
  try {
    const response = await fetch(buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`), {
      method: "POST", signal: AbortSignal.timeout(8000),
      headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: `cg-stop-${createHash('sha256').update(callControlId).digest('hex').slice(0,32)}` }),
    });
    return response.ok;
  } catch { return false; }
}

// A requested hangup is not proof of media end. Keep the slot occupied until
// call.hangup (or a provider GET reporting is_alive=false) is persisted.
export async function requestGeneratorStop(pool, ledgerId, reason = "manual_disconnect") {
  const result = await pool.query(`UPDATE cg_call_ledger SET result = COALESCE(result,'{}'::jsonb)
    || jsonb_build_object('stop_requested',true,'stop_reason',$2::text)
    WHERE id = $1 AND media_ended_at IS NULL AND dial_requested_at IS NOT NULL RETURNING id`, [ledgerId, reason]);
  return result.rowCount > 0;
}
export async function panicStop(pool, runId = null) {
  await pool.query(`UPDATE cg_runs SET status = 'stopped', stopped_at = COALESCE(stopped_at,now())
    WHERE ($1::uuid IS NULL OR id = $1) AND status IN ('pending','running')`, [runId]);
  await pool.query(`UPDATE cg_call_ledger SET status = 'failed', ended_at = now(),
    result = COALESCE(result,'{}'::jsonb) || '{"reason":"cancelled_before_dial"}'::jsonb
    WHERE ($1::uuid IS NULL OR run_id = $1) AND status = 'pending' AND dial_requested_at IS NULL`, [runId]);
  const result = await pool.query(`UPDATE cg_call_ledger SET result = COALESCE(result,'{}'::jsonb)
    || '{"stop_requested":true,"stop_reason":"panic_stop"}'::jsonb
    WHERE ($1::uuid IS NULL OR run_id = $1) AND dial_requested_at IS NOT NULL AND media_ended_at IS NULL
      AND COALESCE(result->>'dial_rejected','false') <> 'true' RETURNING id`, [runId]);
  return result.rowCount;
}
export async function disconnectGeneratedCall(pool, ledgerId) {
  const row = (await pool.query('SELECT id, media_ended_at, dial_requested_at FROM cg_call_ledger WHERE id = $1', [ledgerId])).rows[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.media_ended_at || !row.dial_requested_at) return { ok: false, reason: 'not_active' };
  await requestGeneratorStop(pool, ledgerId);
  return { ok: true, pending: true };
}
export async function disconnectActiveCalls(pool, runId = null) {
  const rows = (await pool.query(`SELECT id FROM cg_call_ledger WHERE ($1::uuid IS NULL OR run_id = $1)
    AND dial_requested_at IS NOT NULL AND media_ended_at IS NULL`, [runId])).rows;
  for (const row of rows) await requestGeneratorStop(pool, row.id);
  return rows.length;
}
