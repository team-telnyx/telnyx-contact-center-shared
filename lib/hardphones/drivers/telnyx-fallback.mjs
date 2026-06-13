// Hard Phones CTI — Telnyx Call Control fallback driver (Phase 2)
//
// Universal driver for phones without a usable HTTP control channel
// (AudioCodes 4xxHD, NAT-ed/remote phones). The phone is treated as a dumb
// auto-answering SIP endpoint:
//   dial(number)  → originate leg A to the phone's SIP credential with an
//                   auto-answer Alert-Info header, then on answer transfer
//                   the leg to the destination number (click-to-dial).
//   hangup/hold/resume/mute → Telnyx Call Control commands on the active leg
//                   (tracked via client_state in hp-cti webhooks, or the
//                   phone's current cc_interaction).
//
// AudioCodes config enables voip/auto_answer/enabled=1 so INVITEs carrying
// "Alert-Info: info=alert-autoanswer" are picked up hands-free.
import { buildTelnyxV2Url } from "../../telnyx.js";
import { createDiagnosticLogger } from "../../diagnostic-logger.mjs";

const ctiLogger = createDiagnosticLogger("contact-center.hardphone-cti");

function getApiKey() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error("TELNYX_API_KEY environment variable is required");
  return apiKey;
}

async function telnyxCall(path, body) {
  const response = await fetch(buildTelnyxV2Url(path), {
    method: "POST",
    headers: { Authorization: `Bearer ${getApiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || `HTTP ${response.status}`;
    return { ok: false, reason: detail, httpStatus: response.status };
  }
  return { ok: true, data: data?.data || data };
}

export function buildCtiClientState({ phoneId, target, callerId }) {
  return Buffer.from(JSON.stringify({ hardphoneCti: true, phoneId, target, callerId })).toString("base64");
}

export function parseCtiClientState(clientState) {
  try {
    const decoded = JSON.parse(Buffer.from(String(clientState || ""), "base64").toString("utf8"));
    return decoded?.hardphoneCti === true ? decoded : null;
  } catch {
    return null;
  }
}

async function findActiveHardphoneInteractionSession(pool, phoneId, phone = {}) {
  const params = [String(phoneId || "")];
  let connectionClause = "";
  const connectionId = String(phone?.telnyx_connection_id || phone?.connection_id || "").trim();
  if (connectionId) {
    params.push(connectionId);
    connectionClause = " OR metadata->>'hardphone_connection_id' = $2 OR metadata->>'connection_id' = $2";
  }
  const { rows } = await pool.query(
    `SELECT
       id,
       COALESCE(metadata->>'hardphone_call_control_id', metadata->>'agent_call_control_id', call_control_id, metadata->>'pstn_call_control_id') AS call_control_id,
       COALESCE(metadata->>'pstn_call_control_id', metadata->>'target_call_control_id') AS pstn_call_control_id,
       COALESCE(metadata->>'hardphone_target', metadata->>'target', metadata->>'to', to_number, from_number) AS target,
       state AS status,
       metadata
     FROM cc_interactions
     WHERE completed_at IS NULL
       AND abandoned_at IS NULL
       AND (
         metadata->>'hardphone_phone_id' = $1
         OR metadata->>'phone_id' = $1
         ${connectionClause}
       )
       AND COALESCE(metadata->>'hardphone_call_control_id', metadata->>'agent_call_control_id', call_control_id, metadata->>'pstn_call_control_id') IS NOT NULL
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    params,
  );
  return rows[0] || null;
}

// Find the phone's active Telnyx call leg. Prefer explicit CTI sessions written
// by the dedicated click-to-dial webhook, then fall back to normal hardphone
// interactions keyed by hardphone metadata / Credential Connection.
export async function activeCtiSession(pool, phoneId, phone = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM hp_cti_sessions
     WHERE phone_id = $1 AND status IN ('originating','ringing','answered','bridged')
     ORDER BY created_at DESC LIMIT 1`,
    [phoneId],
  );
  return rows[0] || await findActiveHardphoneInteractionSession(pool, phoneId, phone);
}

function telnyxSessionCall(session) {
  if (!session) return null;
  const state = session.status || "active";
  const target = session.target || "";
  return {
    state,
    CallState: state,
    RemotePartyNumber: target,
    RemotePartyName: target,
    Type: "Outgoing",
    call_control_id: session.call_control_id,
    pstn_call_control_id: session.pstn_call_control_id || null,
  };
}

function fallbackCallerId(phone) {
  return String(phone?.assigned_phone_number || process.env.HP_CTI_FROM_NUMBER || process.env.TELNYX_DEFAULT_FROM_NUMBER || "").trim();
}

export function createTelnyxFallbackDriver({ pool, baseUrl = "" }) {
  const webhookUrl = baseUrl ? `${baseUrl}/api/provisioning/cti-webhook` : undefined;

  return {
    vendor: "telnyx-fallback",

    // Click-to-dial: ring the phone (auto-answer), then transfer to target.
    async dial(phone, number) {
      if (!phone.sip_username) return { ok: false, reason: "phone_has_no_sip_credential" };
      const target = String(number || "").trim();
      if (!target) return { ok: false, reason: "invalid_number" };
      const callerId = fallbackCallerId(phone);
      if (!callerId) return { ok: false, reason: "phone_has_no_caller_id" };
      const result = await telnyxCall("/calls", {
        to: `sip:${phone.sip_username}@sip.telnyx.com`,
        from: callerId,
        connection_id: process.env.TELNYX_CALL_CONTROL_ID || undefined,
        custom_headers: [{ name: "Alert-Info", value: "info=alert-autoanswer" }],
        timeout_secs: 30,
        webhook_url: webhookUrl,
        webhook_url_method: webhookUrl ? "POST" : undefined,
        client_state: buildCtiClientState({ phoneId: phone.id, target, callerId }),
      });
      if (!result.ok) return result;
      const callControlId = result.data?.call_control_id || null;
      if (pool && callControlId) {
        await pool.query(
          `INSERT INTO hp_cti_sessions (phone_id, call_control_id, target, status)
           VALUES ($1, $2, $3, 'originating')`,
          [phone.id, callControlId, target],
        );
      }
      return { ok: true, callControlId };
    },

    // Phone auto-answers; explicit answer is a no-op success for parity.
    async answer() {
      return { ok: true, note: "auto-answer endpoint" };
    },

    async hangup(phone) {
      const session = pool ? await activeCtiSession(pool, phone.id, phone) : null;
      if (!session) return { ok: false, reason: "no_active_call" };
      return telnyxCall(`/calls/${encodeURIComponent(session.call_control_id)}/actions/hangup`, {});
    },

    async hold(phone) {
      const session = pool ? await activeCtiSession(pool, phone.id, phone) : null;
      if (!session) return { ok: false, reason: "no_active_call" };
      return telnyxCall(`/calls/${encodeURIComponent(session.call_control_id)}/actions/hold`, {});
    },

    async resume(phone) {
      const session = pool ? await activeCtiSession(pool, phone.id, phone) : null;
      if (!session) return { ok: false, reason: "no_active_call" };
      return telnyxCall(`/calls/${encodeURIComponent(session.call_control_id)}/actions/unhold`, {});
    },

    // No phone-side mic control over SIP; mute the leg audio instead.
    async mute(phone, state = true) {
      const session = pool ? await activeCtiSession(pool, phone.id, phone) : null;
      if (!session) return { ok: false, reason: "no_active_call" };
      const action = state ? "suppression_start" : "suppression_stop";
      const result = await telnyxCall(`/calls/${encodeURIComponent(session.call_control_id)}/actions/${action}`, { direction: "both" });
      if (result.ok) return result;
      // Older accounts: fall back to mute via hold
      return telnyxCall(`/calls/${encodeURIComponent(session.call_control_id)}/actions/${state ? "hold" : "unhold"}`, {});
    },

    async sendDtmf(phone, digits) {
      const session = pool ? await activeCtiSession(pool, phone.id, phone) : null;
      if (!session) return { ok: false, reason: "no_active_call" };
      return telnyxCall(`/calls/${encodeURIComponent(session.call_control_id)}/actions/send_dtmf`, { digits: String(digits) });
    },

    async status(phone) {
      const session = pool ? await activeCtiSession(pool, phone.id, phone) : null;
      return { ok: true, reachable: null, call: telnyxSessionCall(session), line: null };
    },

    // No HTTP path to the phone; re-provision waits for the polling cycle.
    async reprovision() {
      return { ok: false, reason: "not_supported_use_polling" };
    },
  };
}
