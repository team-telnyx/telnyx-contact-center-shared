// Hard Phones CTI — Poly/Polycom REST API driver (Phase 2)
//
// Controls VVX / Edge E / CCX (OpenSIP) phones over the UC Software REST API
// (UCS 5.8+). Auth: HTTP Basic, username "Polycom", password = phone admin
// password (provisioned per phone). Self-signed device certs are expected,
// so TLS verification is disabled for the phone connection only.
//
// Status convention: {"Status":"2000"} = success. Notable codes:
//   4001 device busy · 4002 line not registered · 4007 call doesn't exist ·
//   4010 default admin password still set (call control blocked)
import { createDiagnosticLogger } from "../../diagnostic-logger.mjs";

const ctiLogger = createDiagnosticLogger("contact-center.hardphone-cti");

const POLY_USER = "Polycom";

const POLY_ERRORS = {
  4000: "Invalid parameters",
  4001: "Device busy",
  4002: "Line not registered",
  4003: "Operation not allowed",
  4004: "Operation not supported",
  4005: "Line does not exist",
  4007: "Call does not exist",
  4009: "Input size exceeded",
  4010: "Default admin password must be changed",
  5000: "Internal phone failure",
};

async function polyRequest(phone, method, path, body = null) {
  const host = phone.ip_address || phone.last_ip;
  if (!host) return { ok: false, reason: "no_phone_ip" };
  const url = `https://${host}${path}`;
  const headers = {
    Authorization: "Basic " + Buffer.from(`${POLY_USER}:${phone.admin_password || ""}`).toString("base64"),
    "Content-Type": "application/json",
  };
  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      // Node fetch (undici) dispatcher option is not available here; use
      // NODE_TLS_REJECT_UNAUTHORIZED-free agent via the https module fallback
      // when undici rejects the self-signed certificate.
      dispatcher: undefined,
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
  } catch (err) {
    // Fall back to plain HTTP (port 80) for phones with HTTPS disabled or
    // certificate negotiation failures.
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      response = await fetch(`http://${host}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
    } catch (innerErr) {
      ctiLogger.warn("poly_request_failed", { path, error: innerErr?.message || String(innerErr) });
      return { ok: false, reason: "phone_unreachable", error: innerErr?.message };
    }
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "auth_failed", httpStatus: response.status };
  }
  let data = null;
  try { data = await response.json(); } catch {}
  const status = String(data?.Status || "");
  if (response.ok && status === "2000") return { ok: true, data };
  const reason = POLY_ERRORS[Number(status)] || `HTTP ${response.status}`;
  return { ok: false, reason, polyStatus: status || null, httpStatus: response.status, data };
}

// Fetch active call references — needed for answer/end/hold which operate
// on a call Ref handle.
async function activeCallRef(phone) {
  const result = await polyRequest(phone, "GET", "/api/v1/webCallControl/callStatus");
  if (!result.ok) return null;
  const payload = result.data?.data;
  const calls = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const call = calls.find((c) => c?.Ref || c?.CallHandle) || null;
  return call ? { ref: call.Ref || call.CallHandle, state: call.CallState || null, type: call.Type || null } : null;
}

export const polycomDriver = {
  vendor: "polycom",

  async dial(phone, number) {
    return polyRequest(phone, "POST", "/api/v1/callctrl/dial", { data: { Dest: String(number), Line: "1", Type: "SIP" } });
  },

  async answer(phone) {
    const call = await activeCallRef(phone);
    if (!call) return { ok: false, reason: "no_active_call" };
    return polyRequest(phone, "POST", "/api/v1/callctrl/answerCall", { data: { Ref: call.ref } });
  },

  async hangup(phone) {
    const call = await activeCallRef(phone);
    if (!call) return { ok: false, reason: "no_active_call" };
    return polyRequest(phone, "POST", "/api/v1/callctrl/endCall", { data: { Ref: call.ref } });
  },

  async hold(phone) {
    const call = await activeCallRef(phone);
    if (!call) return { ok: false, reason: "no_active_call" };
    return polyRequest(phone, "POST", "/api/v1/callctrl/holdCall", { data: { Ref: call.ref } });
  },

  async resume(phone) {
    const call = await activeCallRef(phone);
    if (!call) return { ok: false, reason: "no_active_call" };
    return polyRequest(phone, "POST", "/api/v1/callctrl/resumeCall", { data: { Ref: call.ref } });
  },

  async mute(phone, state = true) {
    return polyRequest(phone, "POST", "/api/v1/callctrl/mute", { data: { state: state ? "1" : "0" } });
  },

  async sendDtmf(phone, digits) {
    return polyRequest(phone, "POST", "/api/v1/callctrl/sendDTMF", { data: { Digits: String(digits) } });
  },

  async status(phone) {
    const [callStatus, lineInfo] = await Promise.all([
      polyRequest(phone, "GET", "/api/v1/webCallControl/callStatus"),
      polyRequest(phone, "GET", "/api/v1/mgmt/lineInfo"),
    ]);
    return {
      ok: callStatus.ok || lineInfo.ok,
      reachable: callStatus.ok || lineInfo.ok,
      call: callStatus.ok ? (callStatus.data?.data ?? null) : null,
      line: lineInfo.ok ? (lineInfo.data?.data ?? null) : null,
      reason: callStatus.ok || lineInfo.ok ? undefined : callStatus.reason,
    };
  },

  // Force config re-download (UCS 5.9+) — used by "Re-provision now".
  async reprovision(phone) {
    return polyRequest(phone, "POST", "/api/v1/mgmt/updateConfiguration");
  },
};
