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
import http from "node:http";
import https from "node:https";

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

function requestOnce(url, method, headers, body) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: payload ? { ...headers, "Content-Length": Buffer.byteLength(payload) } : headers,
      timeout: 6000,
      rejectUnauthorized: false,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch {}
        resolve({
          response: { status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300 },
          data,
        });
      });
    });
    req.on("timeout", () => req.destroy(new Error("request_timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function normalizePolyResponse(response, data) {
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "auth_failed", httpStatus: response.status };
  }
  const status = String(data?.Status || "");
  if (response.ok && status === "2000") return { ok: true, data };
  const reason = POLY_ERRORS[Number(status)] || `HTTP ${response.status}`;
  return { ok: false, reason, polyStatus: status || null, httpStatus: response.status, data };
}

function shouldRetryPolyOverHttp(response, data) {
  if (!response) return true;
  if (response.status === 401 || response.status === 403) return false;
  const status = String(data?.Status || "");
  if (status) return false;
  // Some VVX firmware exposes the web UI on HTTPS but the UCS REST API only on
  // HTTP. In that case HTTPS answers with an HTML 404 instead of failing the
  // connection, so a catch-only fallback incorrectly reports the phone as down.
  return response.status === 404 || response.status === 405 || response.status === 501;
}

async function polyRequest(phone, method, path, body = null) {
  const host = phone.last_ip || phone.ip_address;
  if (!host) return { ok: false, reason: "no_phone_ip" };
  const headers = {
    Authorization: "Basic " + Buffer.from(`${POLY_USER}:${phone.admin_password || ""}`).toString("base64"),
    "Content-Type": "application/json",
  };

  let first;
  try {
    first = await requestOnce(`https://${host}${path}`, method, headers, body);
    if (!shouldRetryPolyOverHttp(first.response, first.data)) {
      return normalizePolyResponse(first.response, first.data);
    }
  } catch (err) {
    first = { error: err };
  }

  try {
    const fallback = await requestOnce(`http://${host}${path}`, method, headers, body);
    return normalizePolyResponse(fallback.response, fallback.data);
  } catch (innerErr) {
    const error = innerErr?.message || first?.error?.message || String(innerErr || first?.error || "request_failed");
    ctiLogger.warn("poly_request_failed", { path, error });
    return { ok: false, reason: "phone_unreachable", error };
  }
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
    // VVX treats Type: "SIP" as a SIP-URI dial and prefixes the destination
    // with `sip:` (for example `sip:+486...`), which can disconnect before the
    // INVITE reaches Telnyx Call Control. For PSTN-style dialing, send the raw
    // destination and let the configured line/server route it as a telephone
    // number. This yields Proceeding/RingBack/Connected states on VVX300.
    return polyRequest(phone, "POST", "/api/v1/callctrl/dial", { data: { Dest: String(number), Line: "1" } });
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

  // Remote reboot through the Poly UCS/PVOS REST management API.
  async reboot(phone) {
    return polyRequest(phone, "POST", "/api/v1/mgmt/safeReboot");
  },
};
