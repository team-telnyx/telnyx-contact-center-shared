// Hard Phones CTI — Telnyx Call Control fallback driver (Phase 2)
//
// Universal driver for phones without a usable HTTP control channel
// (AudioCodes 4xxHD, NAT-ed/remote phones). The physical phone is controlled
// by a Telnyx-managed bridge: leg A dials the phone SIP credential, leg B dials
// the typed target with link_to/bridge_on_answer. Call lifecycle is driven by
// Telnyx webhooks and persisted in hp_cti_sessions.
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
    return { ok: false, reason: detail, httpStatus: response.status, data };
  }
  return { ok: true, data: data?.data || data };
}

export function buildCtiClientState({ phoneId, target, callerId, leg }) {
  const payload = { hardphoneCti: true, phoneId, target, callerId };
  if (leg) payload.leg = leg;
  return Buffer.from(JSON.stringify(payload)).toString("base64");
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
       COALESCE(metadata->>'pstn_call_control_id', metadata->>'target_call_control_id') AS target_call_control_id,
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

export async function activeCtiSession(pool, phoneId, phone = {}) {
  const { rows } = await pool.query(
    `SELECT *, COALESCE(phone_call_control_id, call_control_id) AS call_control_id,
             COALESCE(target_call_control_id, call_control_id) AS target_call_control_id
     FROM hp_cti_sessions
     WHERE phone_id = $1 AND status IN ('originating','ringing','answered','bridged','held')
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
    call_control_id: session.call_control_id || session.phone_call_control_id,
    phone_call_control_id: session.phone_call_control_id || session.call_control_id,
    target_call_control_id: session.target_call_control_id || session.pstn_call_control_id || null,
    pstn_call_control_id: session.target_call_control_id || session.pstn_call_control_id || null,
  };
}

function normalizeE164CallerId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  if (!/^\+?[0-9\s().-]+$/.test(raw)) return null;
  const normalized = raw.startsWith("+") ? `+${raw.slice(1).replace(/\D/g, "")}` : raw.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{1,14}$/.test(normalized) ? normalized : null;
}

function fallbackCallerId(phone) {
  return [phone?.assigned_phone_number, process.env.HP_CTI_FROM_NUMBER, process.env.TELNYX_DEFAULT_FROM_NUMBER]
    .map(normalizeE164CallerId)
    .find(Boolean) || "";
}

function fallbackConnectionId(phone) {
  return String(phone?.telnyx_connection_id || phone?.connection_id || process.env.TELNYX_CALL_CONTROL_ID || "").trim();
}

function webhookUrlFromBase(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/$/, "");
  return value ? `${value}/api/provisioning/cti-webhook` : undefined;
}

export function createTelnyxFallbackDriver({ pool, baseUrl = "" } = {}) {
  const webhookUrl = webhookUrlFromBase(baseUrl);
  return {
    vendor: "telnyx-fallback",

    async dial(phone, number) {
      if (!phone.sip_username) return { ok: false, reason: "phone_has_no_sip_credential" };
      const target = String(number || "").trim();
      if (!target) return { ok: false, reason: "invalid_number" };
      const callerId = fallbackCallerId(phone);
      if (!callerId) return { ok: false, reason: "phone_has_no_caller_id" };
      const connectionId = fallbackConnectionId(phone);
      if (!connectionId) return { ok: false, reason: "missing_call_control_connection" };

      const phoneLeg = await telnyxCall("/calls", {
        to: `sip:${phone.sip_username}@sip.telnyx.com`,
        from: callerId,
        connection_id: connectionId,
        custom_headers: [{ name: "Alert-Info", value: "info=alert-autoanswer" }],
        timeout_secs: 30,
        webhook_url: webhookUrl,
        webhook_url_method: webhookUrl ? "POST" : undefined,
        client_state: buildCtiClientState({ phoneId: phone.id, target, callerId, leg: "phone" }),
      });
      if (!phoneLeg.ok) return phoneLeg;
      const phoneCallControlId = phoneLeg.data?.call_control_id || null;
      if (!phoneCallControlId) return { ok: false, reason: "missing_phone_call_control_id" };

      const targetLeg = await dialTargetLeg({ phone, target, callerId, connectionId, phoneCallControlId, webhookUrl });
      if (!targetLeg.ok) {
        await telnyxCall(`/calls/${encodeURIComponent(phoneCallControlId)}/actions/hangup`, {}).catch(() => null);
        return targetLeg;
      }
      const targetCallControlId = targetLeg.data?.call_control_id || null;
      if (pool) {
        await pool.query(
          `INSERT INTO hp_cti_sessions
             (phone_id, call_control_id, phone_call_control_id, target_call_control_id, target, status, call_session_id)
           VALUES ($1, $2, $3, $4, $5, 'originating', $6)`,
          [phone.id, phoneCallControlId, phoneCallControlId, targetCallControlId, target, phoneLeg.data?.call_session_id || targetLeg.data?.call_session_id || null],
        );
      }
      return { ok: true, callControlId: phoneCallControlId, phoneCallControlId, targetCallControlId };
    },

    async answer() {
      return { ok: true, note: "telnyx-managed bridge" };
    },

    async hangup(phone) {
      const session = pool ? await activeCtiSession(pool, phone.id, phone) : null;
      if (!session) return { ok: false, reason: "no_active_call" };
      return telnyxCall(`/calls/${encodeURIComponent(session.call_control_id)}/actions/hangup`, {});
    },

    async hold(phone) {
      const session = pool ? await activeCtiSession(pool, phone.id, phone) : null;
      if (!session) return { ok: false, reason: "no_active_call" };
      const result = await telnyxCall(`/calls/${encodeURIComponent(session.call_control_id)}/actions/hold`, {});
      if (result.ok && pool) await pool.query(`UPDATE hp_cti_sessions SET status = 'held', updated_at = NOW() WHERE phone_id = $1 AND COALESCE(phone_call_control_id, call_control_id) = $2`, [phone.id, session.call_control_id]);
      return result;
    },

    async resume(phone) {
      const session = pool ? await activeCtiSession(pool, phone.id, phone) : null;
      if (!session) return { ok: false, reason: "no_active_call" };
      const result = await telnyxCall(`/calls/${encodeURIComponent(session.call_control_id)}/actions/unhold`, {});
      if (result.ok && pool) await pool.query(`UPDATE hp_cti_sessions SET status = 'bridged', updated_at = NOW() WHERE phone_id = $1 AND COALESCE(phone_call_control_id, call_control_id) = $2`, [phone.id, session.call_control_id]);
      return result;
    },

    async mute() {
      return { ok: false, reason: "mute_not_supported_for_telnyx_bridge" };
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

    async reprovision() {
      return { ok: false, reason: "not_supported_use_polling" };
    },
  };
}

async function dialTargetLeg({ phone, target, callerId, connectionId, phoneCallControlId, webhookUrl }) {
  return telnyxCall("/calls", {
    to: target,
    from: callerId,
    connection_id: connectionId,
    link_to: phoneCallControlId,
    bridge_intent: true,
    bridge_on_answer: true,
    timeout_secs: 30,
    webhook_url: webhookUrl,
    webhook_url_method: webhookUrl ? "POST" : undefined,
    client_state: buildCtiClientState({ phoneId: phone.id, target, callerId, leg: "target" }),
  });
}
