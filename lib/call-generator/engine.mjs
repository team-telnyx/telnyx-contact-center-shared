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
      await markLedgerStatus(pool, ledgerRow.id, "failed", { reason: "call_generator_disabled" });
    }
    return { ok: false, reason: "call_generator_disabled" };
  }
  const apiKey = getApiKey();
  const destination = resolveDialTarget(task);
  if (!destination) {
    await markLedgerStatus(pool, ledgerRow.id, "failed", { reason: "invalid_target" });
    return { ok: false, reason: "invalid_target" };
  }
  if (String(task?.target_type || "").toLowerCase() === "pstn") {
    const whitelist = pstnWhitelistFromConfig(run?.config || {});
    if (!isPstnTargetAllowed(destination, whitelist)) {
      await markLedgerStatus(pool, ledgerRow.id, "failed", { reason: "pstn_not_whitelisted" });
      return { ok: false, reason: "pstn_not_whitelisted" };
    }
  }

  const base = resolveWebhookBaseUrl();
  const webhookUrl = base ? `${base}/api/call-generator/webhook` : null;
  const payload = {
    to: destination,
    from: fromNumber,
    connection_id: process.env.TELNYX_CALL_CONTROL_ID || undefined,
    webhook_url: webhookUrl || undefined,
    webhook_url_method: webhookUrl ? "POST" : undefined,
    timeout_secs: Number(run?.config?.dialTimeoutSecs) > 0 ? Number(run.config.dialTimeoutSecs) : 30,
    command_id: `cg-${ledgerRow.id}`,
    client_state: buildGeneratorClientState({ runId: run.id, ledgerId: ledgerRow.id }),
  };

  await markLedgerStatus(pool, ledgerRow.id, "dialing", { dial_started_at: new Date().toISOString() });

  let response;
  try {
    response = await fetch(buildTelnyxV2Url("/calls"), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    await markLedgerStatus(pool, ledgerRow.id, "failed", { reason: "telnyx_request_error", error: err?.message || String(err) });
    return { ok: false, reason: "telnyx_request_error" };
  }

  if (!response.ok) {
    const errorText = await response.text();
    await markLedgerStatus(pool, ledgerRow.id, "failed", {
      reason: "telnyx_dial_failed",
      telnyx_status: response.status,
      telnyx_error: String(errorText || "").slice(0, 1200),
    });
    return { ok: false, reason: "telnyx_dial_failed", status: response.status };
  }

  const dialResult = await response.json();
  const dialData = dialResult?.data || {};
  await pool.query(
    `UPDATE cg_call_ledger
     SET call_control_id = COALESCE($1, call_control_id),
         call_session_id = COALESCE($2, call_session_id),
         to_number = COALESCE(to_number, $3),
         from_number = COALESCE(from_number, $4),
         started_at = COALESCE(started_at, NOW())
     WHERE id = $5`,
    [dialData.call_control_id || null, dialData.call_session_id || null, destination, fromNumber || null, ledgerRow.id],
  );
  return { ok: true, callControlId: dialData.call_control_id || null };
}

// Allowed state transitions — CAS-style guards so replayed/ooo webhooks
// can never move a call backwards.
const TRANSITIONS = {
  pending: ["dialing", "failed"],
  dialing: ["ringing", "answered", "completed", "failed", "abandoned"],
  ringing: ["answered", "completed", "failed", "abandoned"],
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
  const setAnswered = status === "answered" ? ", answered_at = COALESCE(answered_at, NOW())" : "";
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

// Map Telnyx webhook event types onto ledger transitions. Returns the
// applied status or null when the event is not relevant.
export async function handleGeneratorWebhookEvent(pool, eventType, payload) {
  const state = parseGeneratorClientState(payload?.client_state);
  if (!state?.ledgerId) return null;
  const ledgerId = state.ledgerId;

  switch (String(eventType || "")) {
    case "call.initiated":
      return (await markLedgerStatus(pool, ledgerId, "dialing", { event: eventType })) ? "dialing" : null;
    case "call.ringing":
      return (await markLedgerStatus(pool, ledgerId, "ringing", { event: eventType })) ? "ringing" : null;
    case "call.answered": {
      const ok = await markLedgerStatus(pool, ledgerId, "answered", { event: eventType });
      if (ok) await runPostAnswerActions(pool, ledgerId, payload);
      return ok ? "answered" : null;
    }
    case "call.speak.started":
    case "call.playback.started":
      return (await markLedgerStatus(pool, ledgerId, "talking", { event: eventType })) ? "talking" : null;
    case "call.hangup": {
      const cause = payload?.hangup_cause || payload?.sip_hangup_cause || null;
      const { rows } = await pool.query("SELECT status FROM cg_call_ledger WHERE id = $1", [ledgerId]);
      const wasAnswered = ["answered", "talking"].includes(rows[0]?.status);
      const finalStatus = wasAnswered ? "completed" : (cause === "originator_cancel" ? "abandoned" : "completed");
      return (await markLedgerStatus(pool, ledgerId, finalStatus, { event: eventType, hangup_cause: cause })) ? finalStatus : null;
    }
    case "call.machine.detection.ended":
      return (await markLedgerStatus(pool, ledgerId, "talking", { event: eventType, amd_result: payload?.result || null })) ? "talking" : null;
    default:
      return null;
  }
}

// Post-answer behaviour: if the ledger row carries an action sequence
// (resolved from the target's action_id at seed time), execute the steps
// sequentially — play_media, speak (with voice), send_dtmf. Otherwise fall
// back to the legacy run-config postAnswer behaviour. A timed hangup guard
// always arms so generated calls can never linger past maxDurationSecs.
export async function runPostAnswerActions(pool, ledgerId, payload) {
  const apiKey = getApiKey();
  const callControlId = payload?.call_control_id;
  if (!callControlId) return;

  let config = {};
  let ledgerResult = {};
  try {
    const { rows } = await pool.query(
      `SELECT r.config, l.result FROM cg_call_ledger l JOIN cg_runs r ON r.id = l.run_id WHERE l.id = $1`,
      [ledgerId],
    );
    config = rows[0]?.config || {};
    ledgerResult = rows[0]?.result || {};
  } catch {
    config = {};
  }

  const clientState = buildGeneratorClientState({ runId: config?.runId || null, ledgerId });
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const telnyxCall = (actionPath, body) =>
    fetch(buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}/actions/${actionPath}`), {
      method: "POST",
      headers,
      body: JSON.stringify({ ...body, client_state: clientState }),
    });

  const steps = Array.isArray(ledgerResult?.action_steps) ? ledgerResult.action_steps : [];

  try {
    if (steps.length) {
      // Sequential execution: speak/playback commands queue server-side at
      // Telnyx per call, so issuing them in order preserves the sequence.
      for (const step of steps) {
        if (step.type === "play_media") {
          await telnyxCall("playback_start", { media_name: step.media_name });
        } else if (step.type === "speak") {
          await telnyxCall("speak", { payload: step.text, voice: step.voice || "AWS.Polly.Joanna" });
        } else if (step.type === "send_dtmf") {
          await telnyxCall("send_dtmf", { digits: step.digits });
        }
      }
    } else {
      const action = String(config?.postAnswer?.action || "tts_loop");
      if (action === "audio_loop" && config?.postAnswer?.audioUrl) {
        await telnyxCall("playback_start", { audio_url: config.postAnswer.audioUrl, loop: "infinity" });
      } else if (action !== "silence") {
        const text = String(config?.postAnswer?.ttsText || "This is an automated test call from the contact center call generator.");
        await telnyxCall("speak", { payload: text, voice: "female", language: "en-US" });
      }
    }
  } catch (err) {
    await pool.query(
      `UPDATE cg_call_ledger SET result = COALESCE(result, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ post_answer_error: err?.message || String(err) }), ledgerId],
    );
  }

  const maxDurationSecs = Number(config?.postAnswer?.maxDurationSecs) > 0 ? Number(config.postAnswer.maxDurationSecs) : 60;
  setTimeout(async () => {
    try {
      const { rows } = await pool.query("SELECT status FROM cg_call_ledger WHERE id = $1", [ledgerId]);
      if (!["completed", "failed", "abandoned"].includes(rows[0]?.status)) {
        await hangupGeneratedCall(callControlId);
      }
    } catch {}
  }, maxDurationSecs * 1000);
}

export async function hangupGeneratedCall(callControlId) {
  const apiKey = getApiKey();
  try {
    const response = await fetch(buildTelnyxV2Url(`/calls/${encodeURIComponent(callControlId)}/actions/hangup`), {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    return response.ok;
  } catch {
    return false;
  }
}

// Panic: hang up every non-final generated call for a run (or all runs).
export async function panicStop(pool, runId = null) {
  const params = [];
  let where = "status IN ('dialing','ringing','answered','talking') AND call_control_id IS NOT NULL";
  if (runId) {
    params.push(runId);
    where += ` AND run_id = $1`;
  }
  const { rows } = await pool.query(`SELECT id, call_control_id FROM cg_call_ledger WHERE ${where}`, params);
  let stopped = 0;
  for (const row of rows) {
    const ok = await hangupGeneratedCall(row.call_control_id);
    if (ok) {
      await markLedgerStatus(pool, row.id, "failed", { reason: "panic_stop" });
      stopped += 1;
    }
  }
  if (runId) {
    await pool.query(`UPDATE cg_runs SET status = 'stopped', stopped_at = NOW() WHERE id = $1`, [runId]);
  }
  return stopped;
}

// Graceful disconnect of a single generated call: send hangup and tag the
// ledger row; the call.hangup webhook finalizes the status transition so the
// call completes its normal lifecycle (unlike panicStop, which force-fails).
export async function disconnectGeneratedCall(pool, ledgerId) {
  const { rows } = await pool.query(
    `SELECT id, call_control_id, status FROM cg_call_ledger WHERE id = $1`,
    [ledgerId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: "not_found" };
  if (!["dialing", "ringing", "answered", "talking"].includes(row.status)) {
    return { ok: false, reason: "not_active" };
  }
  if (!row.call_control_id) return { ok: false, reason: "no_call_control_id" };
  const ok = await hangupGeneratedCall(row.call_control_id);
  if (!ok) return { ok: false, reason: "hangup_failed" };
  await pool.query(
    `UPDATE cg_call_ledger SET result = COALESCE(result, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ manual_disconnect: true }), ledgerId],
  );
  return { ok: true };
}

// Graceful disconnect of every active generated call (optionally per run).
// Sends hangups but leaves status finalization to the webhook lifecycle.
export async function disconnectActiveCalls(pool, runId = null) {
  const params = [];
  let where = "status IN ('dialing','ringing','answered','talking') AND call_control_id IS NOT NULL";
  if (runId) {
    params.push(runId);
    where += ` AND run_id = $1`;
  }
  const { rows } = await pool.query(`SELECT id, call_control_id FROM cg_call_ledger WHERE ${where}`, params);
  let disconnected = 0;
  for (const row of rows) {
    const ok = await hangupGeneratedCall(row.call_control_id);
    if (ok) {
      await pool.query(
        `UPDATE cg_call_ledger SET result = COALESCE(result, '{}'::jsonb) || '{"manual_disconnect":true}'::jsonb WHERE id = $1`,
        [row.id],
      );
      disconnected += 1;
    }
  }
  return disconnected;
}
