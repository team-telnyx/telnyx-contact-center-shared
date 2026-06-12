// Hard Phones CTI — Yealink Action URI driver (Phase 2)
//
// Controls T4x/T5x phones via HTTP GET Action URI commands:
//   http://<ip>/servlet?key=<KEY>  /  servlet?number=<digits>
// Requirements provisioned in the phone config: features.action_uri.enable=1
// and features.action_uri_limit_ip including this server's IP (otherwise the
// phone shows a confirmation popup). Auth: HTTP Basic/Digest with the web
// admin account (admin / provisioned admin_password).
//
// Commands are fire-and-forget — state confirmation arrives via action_url
// events on /api/provisioning/events/yealink.
import { createDiagnosticLogger } from "../../diagnostic-logger.mjs";

const ctiLogger = createDiagnosticLogger("contact-center.hardphone-cti");

async function actionUri(phone, query) {
  const host = phone.ip_address || phone.last_ip;
  if (!host) return { ok: false, reason: "no_phone_ip" };
  const url = `http://${host}/servlet?${query}`;
  const headers = {
    Authorization: "Basic " + Buffer.from(`admin:${phone.admin_password || "admin"}`).toString("base64"),
  };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal }).finally(() => clearTimeout(timer));
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "auth_failed", httpStatus: response.status };
    }
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}`, httpStatus: response.status };
    return { ok: true };
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

  // Mute is a toggle as well; `state` is accepted for interface parity but
  // the phone flips the current state.
  async mute(phone) {
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

  // Yealink has no status read-back over Action URI; reachability check only.
  async status(phone) {
    const host = phone.ip_address || phone.last_ip;
    if (!host) return { ok: false, reachable: false, reason: "no_phone_ip" };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(`http://${host}/servlet?key=`, {
        method: "GET",
        headers: { Authorization: "Basic " + Buffer.from(`admin:${phone.admin_password || "admin"}`).toString("base64") },
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));
      return { ok: true, reachable: response.status < 500, call: null, line: null };
    } catch {
      return { ok: false, reachable: false, reason: "phone_unreachable" };
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
