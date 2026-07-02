// Hard Phones CTI — Yealink Action URI + Web API driver (Phase 2)
//
// Controls T4x/T5x/T3x phones via Yealink's phone-local APIs:
//   - Action URI: /servlet?key=<KEY> and /servlet?number=<digits> for call control
//   - Web API:    /api/auth/login?p=Login + /api/account/status?p=AccountRegister
//                 + /api/account/info?p=AccountRegister for registration/status
// Requirements provisioned in the phone config: features.action_uri.enable=1
// and features.action_uri_limit_ip including this server's IP (otherwise the
// phone shows a confirmation popup). Auth: web admin account.
//
// Action URI commands are mostly fire-and-forget. Current registration/account
// state is read back through the Web API so Yealink behaves like Polycom in the
// CTI card and local bridge status path.
import { createDiagnosticLogger } from "../../diagnostic-logger.mjs";
import http from "node:http";
import https from "node:https";

const ctiLogger = createDiagnosticLogger("contact-center.hardphone-cti");

const YEALINK_ACCOUNT_STATUS = {
  0: "disabled",
  1: "registering",
  2: "registered",
  3: "registration_failed",
  4: "unregistered",
};

function yealinkCredentials(phone = {}) {
  return {
    user: phone.admin_user || phone.web_user || "admin",
    password: phone.admin_password || "admin",
  };
}

function hostFor(phone = {}) {
  return phone.last_ip || phone.ip_address;
}

function requestRaw(url, { method = "GET", headers = {}, body = null, timeoutMs = 6000 } = {}) {
  const target = new URL(url);
  const transport = target.protocol === "https:" ? https : http;
  const payload = body == null ? null : String(body);
  return new Promise((resolve, reject) => {
    const req = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers: payload ? { ...headers, "Content-Length": Buffer.byteLength(payload) } : headers,
      timeout: timeoutMs,
      rejectUnauthorized: false,
    }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => resolve({ status: res.statusCode || 0, ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300, raw, headers: res.headers || {} }));
    });
    req.on("timeout", () => req.destroy(new Error("request_timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseJson(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function cookieHeader(headers = {}) {
  const setCookie = headers["set-cookie"] || [];
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies.map((cookie) => String(cookie).split(";", 1)[0]).filter(Boolean).join("; ");
}

async function withProtocolFallback(host, path, options = {}) {
  let first;
  try {
    first = await requestRaw(`https://${host}${path}`, options);
    if (first.ok || first.status === 401 || first.status === 403) return first;
  } catch (err) {
    first = { error: err };
  }
  try {
    return await requestRaw(`http://${host}${path}`, options);
  } catch (err) {
    const error = err?.message || first?.error?.message || String(err || first?.error || "request_failed");
    throw new Error(error);
  }
}

async function yealinkLogin(host, { user = "admin", password = "admin" } = {}) {
  const form = new URLSearchParams({ username: user, pwd: password }).toString();
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    Origin: `https://${host}`,
    Referer: `https://${host}/api`,
  };
  const response = await withProtocolFallback(host, "/api/auth/login?p=Login", { method: "POST", headers, body: form, timeoutMs: 7000 });
  const data = parseJson(response.raw);
  if (response.status === 401 || response.status === 403 || data?.ret !== "ok") {
    return { ok: false, reason: "auth_failed", httpStatus: response.status, data };
  }
  return { ok: true, cookie: cookieHeader(response.headers), protocol: response.protocol, data };
}

async function yealinkApiGet(host, path, credentials) {
  const login = await yealinkLogin(host, credentials);
  if (!login.ok) return login;
  const headers = login.cookie ? { Cookie: login.cookie } : {};
  const response = await withProtocolFallback(host, path, { headers, timeoutMs: 7000 });
  const data = parseJson(response.raw);
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "auth_failed", httpStatus: response.status, data };
  if (!response.ok || !data) return { ok: false, reason: `HTTP ${response.status}`, httpStatus: response.status, raw: response.raw?.slice(0, 500) || null };
  return { ok: true, data, httpStatus: response.status };
}

function normalizeRegistrationStatus(code) {
  const normalized = String(code ?? "").trim();
  if (!normalized) return null;
  const numeric = Number(normalized);
  return YEALINK_ACCOUNT_STATUS[numeric] || (Number.isFinite(numeric) ? `status_${numeric}` : null);
}

function accountMapValue(data, account = 1) {
  const raw = data?.data?.[String(account)] ?? data?.data?.[Number(account)] ?? null;
  return raw == null ? null : String(raw).trim();
}

function accountInfo(data, account = 1) {
  const rows = Array.isArray(data?.data) ? data.data : [];
  return rows.find((row) => String(row?.id || row?.account || "") === String(account)) || null;
}

async function actionUri(phone, query) {
  const host = hostFor(phone);
  if (!host) return { ok: false, reason: "no_phone_ip" };
  const { user, password } = yealinkCredentials(phone);
  const headers = {
    Authorization: "Basic " + Buffer.from(`${user}:${password}`).toString("base64"),
  };
  try {
    const response = await withProtocolFallback(host, `/servlet?${query}`, { method: "GET", headers, timeoutMs: 6000 });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "auth_failed", httpStatus: response.status };
    }
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}`, httpStatus: response.status, raw: response.raw?.slice(0, 500) || null };
    return { ok: true, httpStatus: response.status, raw: response.raw?.slice(0, 500) || null };
  } catch (err) {
    ctiLogger.warn("yealink_action_uri_failed", { query: query.split("&")[0], error: err?.message || String(err) });
    return { ok: false, reason: "phone_unreachable", error: err?.message };
  }
}

export const yealinkDriver = {
  vendor: "yealink",

  async dial(phone, number) {
    const digits = String(number || "").replace(/[^0-9+*#]/g, "");
    if (!digits) return { ok: false, reason: "invalid_number" };
    return actionUri(phone, `number=${encodeURIComponent(digits)}`);
  },

  async answer(phone) {
    return actionUri(phone, "key=OK");
  },

  async hangup(phone) {
    return actionUri(phone, "key=CALLEND");
  },

  async hold(phone) {
    return actionUri(phone, "key=F_HOLD");
  },

  // Yealink hold is a toggle — resume re-sends the same key.
  async resume(phone) {
    return actionUri(phone, "key=F_HOLD");
  },

  // Yealink MUTE is a hardware-key toggle; `state` is accepted for interface parity.
  async mute(phone) {
    return actionUri(phone, "key=MUTE");
  },

  async unmute(phone) {
    return actionUri(phone, "key=MUTE");
  },

  async sendDtmf(phone, digits) {
    const sequence = String(digits || "").replace(/[^0-9*#]/g, "").split("");
    if (!sequence.length) return { ok: false, reason: "invalid_digits" };
    for (const digit of sequence) {
      const key = digit === "*" ? "STAR" : digit === "#" ? "POUND" : digit;
      const result = await actionUri(phone, `key=${key}`);
      if (!result.ok) return result;
    }
    return { ok: true };
  },

  async status(phone) {
    const host = hostFor(phone);
    if (!host) return { ok: false, reachable: false, reason: "no_phone_ip" };
    const credentials = yealinkCredentials(phone);
    try {
      const [statusResult, infoResult] = await Promise.all([
        yealinkApiGet(host, "/api/account/status?p=AccountRegister", credentials),
        yealinkApiGet(host, "/api/account/info?p=AccountRegister", credentials),
      ]);
      const account = Number(phone?.settings?.line || phone?.line || 1) || 1;
      const rawStatus = statusResult.ok ? accountMapValue(statusResult.data, account) : null;
      const registration = normalizeRegistrationStatus(rawStatus);
      const info = infoResult.ok ? accountInfo(infoResult.data, account) : null;
      return {
        ok: statusResult.ok || infoResult.ok,
        reachable: statusResult.ok || infoResult.ok,
        vendor: "yealink",
        registration,
        registration_status: registration,
        call: null,
        line: info ? { ...info, RegistrationStatus: registration, AccountStatusCode: rawStatus } : { RegistrationStatus: registration, AccountStatusCode: rawStatus },
        reason: statusResult.ok || infoResult.ok ? undefined : statusResult.reason || infoResult.reason,
      };
    } catch (err) {
      ctiLogger.warn("yealink_status_failed", { error: err?.message || String(err) });
      return { ok: false, reachable: false, reason: "phone_unreachable", error: err?.message };
    }
  },

  // Trigger immediate auto-provision check.
  async reprovision(phone) {
    return actionUri(phone, "key=AUTOP");
  },

  // Remote reboot through Yealink Action URI. Requires Action URI enablement and reachability.
  async reboot(phone) {
    return actionUri(phone, "key=Reboot");
  },
};
